#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify,isDeepStrictEqual } from "node:util";
import { loadJson, validateDocsProtocolPolicy, validateGovernanceReferences, validateOrganizationRepositoryInventory } from "./governance-policy.mjs";
import { validateDocsGovernanceReferences, validateDocsProtocolExceptions } from "./docs-cohort-policy.mjs";
import { verifyDocsAdmissionEvidence } from "./verify-docs-cohort-evidence.mjs";
import { POLICY_PATH, REGISTRY_PATH,
  recoveryBlob, prepareAdmissionRecovery, finishAdmissionRecovery } from "./docs-legacy-admission-recovery.mjs";
import { PLATFORM_RECOVERY_AUTHORITY_PATH, verifyPlatformAdmissionRecovery } from "./docs-platform-admission-recovery.mjs";
import { parseIncidentJson, validateIRecordStructure, validateStagedIRecord } from "./verify-docs-platform-recovery-installation-r317.mjs";

const execute = promisify(execFile);
const need = (condition, message) => { if (!condition) {throw new Error(message);} };
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
// This exact base-owned template carries no incident authority. A changed or
// embellished unbound record must never disable an installed recovery.
const UNBOUND_PLATFORM_AUTHORITY_BLOB = "9c08e7c5587c1a2607dbb15cc97dc90d59acd57a";
async function api(path) {
  const { stdout } = await execute("gh", ["api", path], { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}
export async function readAdmissionBaseFile(path, revision) {
  need(/^(?!0{40}$)[0-9a-f]{40}$/u.test(revision) && /^[a-zA-Z0-9_./-]+$/u.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== ".."), "Invalid base Git coordinate.");
  const { stdout: entry } = await execute("git", ["ls-tree", revision, "--", path], { encoding: "utf8" });
  if (entry === "") {return null;}
  const match = /^100644 blob ([0-9a-f]{40})\t([^\n]+)\n$/u.exec(entry);
  need(match && match[2] === path, "Admission authority must be one regular base-owned file.");
  const { stdout } = await execute("git", ["cat-file", "blob", match[1]], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
  need(recoveryBlob(stdout) === match[1], "Base Git blob content mismatch.");
  return stdout;
}

export async function verifyAdmissionController(execution, read = api) {
  need(execution && isDeepStrictEqual(Object.keys(execution).toSorted(),
    "controller pull_number pull_id head_ref run_id run_attempt base head execution_base changed_files".split(" ").toSorted()) &&
    execution.controller?.repository === "agent-teams-ai/.github" &&
    isDeepStrictEqual(Object.keys(execution.controller).toSorted(), ["repository", "repository_id"]) &&
    execution.controller.repository_id === 1316243981 &&
    Number.isSafeInteger(execution.pull_number) && execution.pull_number > 0 &&
    [execution.pull_id, execution.run_id, execution.run_attempt]
      .every((value) => Number.isSafeInteger(value) && value > 0) &&
    typeof execution.head_ref === "string" && execution.head_ref.length > 0 &&
    execution.execution_base === execution.base && execution.head !== execution.base &&
    [execution.base, execution.head].every((sha) => /^(?!0{40}$)[0-9a-f]{40}$/u.test(sha)),
  "Admission execution must bind the central repository/PR/base/head.");
  const repo = execution.controller.repository;
  const [controller, pull] = await Promise.all([read(`repos/${repo}`), read(`repos/${repo}/pulls/${execution.pull_number}`)]);
  const identity = (value) => value?.id === execution.controller.repository_id && value.full_name === repo;
  need(identity(controller) && controller.archived === false && controller.disabled === false &&
    identity(pull.base?.repo) && identity(pull.head?.repo) && pull.number === execution.pull_number &&
    pull.id === execution.pull_id && pull.head.ref === execution.head_ref &&
    pull.state === "open" && pull.merged === false && pull.base.sha === execution.base && pull.head.sha === execution.head &&
    pull.base.ref === controller.default_branch && pull.changed_files === execution.changed_files.length,
  "Live admission controller/PR identity or exact tuple changed.");
  const branch = await read(`repos/${repo}/branches/${controller.default_branch}`);
  need(branch.commit?.sha === execution.base, "Live central default head changed during admission verification.");
  return execution;
}
export function reconcileLegacyPending(report) {
  const pending = report.recovery_pending.filter((row) => row.repository_id !== 1319378484)
    .map((row) => ({ repository_id: row.repository_id, source_head: row.source_head }));
  need(isDeepStrictEqual(report.recovery.recovery_pending, pending),
    "Legacy pending source changed during retry.");
  return report;
}

export function legacyRecoveryExecution(execution) {
  return { controller: execution.controller, pull_number: execution.pull_number,
    base: execution.base, head: execution.head, execution_base: execution.execution_base,
    changed_files: execution.changed_files };
}

export async function verifyDocsAdmissionChange(paths, overrides = {}) {
  const [policyBytes, basePolicyBytes, exceptionsBytes, registryBytes, policySchema, exceptionsSchema, registrySchema, security] =
    await Promise.all([
      readFile(paths.policy), overrides.basePolicyBytes ?? readFile(POLICY_PATH), readFile(paths.exceptions), readFile(REGISTRY_PATH),
      loadJson("governance/docs-protocol-policy-v2.schema.json"),
      loadJson("governance/docs-protocol-exceptions.schema.json"),
      loadJson("governance/docs-qualified-cohorts.schema.json"), loadJson("governance/code-security-defaults.json"),
    ]);
  const policy = JSON.parse(policyBytes);
  const basePolicy = JSON.parse(basePolicyBytes);
  const clock = overrides.clock ?? now;
  const exceptions = JSON.parse(exceptionsBytes);
  const registry = JSON.parse(registryBytes);
  // Neither document is projected or relaxed. Existing reference/lifecycle,
  // migration-edge, single-canary and repository-eligibility rules run first.
  validateDocsProtocolPolicy(policy, policySchema);
  validateDocsProtocolPolicy(basePolicy, policySchema);
  validateDocsProtocolExceptions(exceptions, exceptionsSchema, { asOf: clock().slice(0, 10) });
  validateDocsGovernanceReferences(registry, exceptions, policy, security);
  if (paths.inventory) {
    const inventory = JSON.parse(await readFile(paths.inventory));
    const [inventorySchema, ledger, actions] = await Promise.all([
      loadJson("governance/organization-repository-inventory.schema.json"),
      loadJson("governance/executable-spec-qualification.json"),
      loadJson("governance/actions-policy.json"),
    ]);
    validateOrganizationRepositoryInventory(inventory, inventorySchema);
    validateGovernanceReferences(ledger, security, actions, inventory, policy);
  }
  const execution = paths.execution ? await loadJson(paths.execution) : overrides.execution;
  need(execution, "Trusted admission requires materialized execution coordinates.");
  const verifyController = overrides.verifyController ?? verifyAdmissionController;
  const readBaseFile = overrides.readBaseFile ?? readAdmissionBaseFile;
  await verifyController(execution);
  // Legacy incident authority owns only the original six-field PR/base tuple.
  // The full materialized envelope remains available to Platform recovery.
  const legacyExecution = legacyRecoveryExecution(execution);
  need(isDeepStrictEqual(await readBaseFile(POLICY_PATH, execution.base), basePolicyBytes) &&
    isDeepStrictEqual(await readBaseFile(REGISTRY_PATH, execution.base), registryBytes), "Checkout authority is not the exact base.");
  // Lazy consumption preserves normal successful admissions even when another
  // PR has separately staged incident authority. No failed row can skip proof.
  let capability;
  const getCapability = async () => {
    capability ??= await prepareAdmissionRecovery({ execution: legacyExecution, readBaseFile, asOf: clock(),
      basePolicyBytes, proposedPolicyBytes: policyBytes, registryBytes, exceptionsBytes });
    need(capability, "Current source failed without trusted base incident authorization.");
    return capability;
  };
  // The only consumable incident record is a regular file in the exact base.
  // A PR-head record, candidate fixture or same-PR authority cannot enable it.
  const platformRecordBytes = await readBaseFile(PLATFORM_RECOVERY_AUTHORITY_PATH, execution.base);
  let platformRecord;
  if (platformRecordBytes !== null) {
    platformRecord = parseIncidentJson(platformRecordBytes, "base-owned Platform recovery authority");
    need(platformRecord !== null && typeof platformRecord === "object" && !Array.isArray(platformRecord),
      "base-owned Platform recovery authority must be an object.");
  }
  if (platformRecord?.state === "unbound") {
    need(recoveryBlob(platformRecordBytes) === UNBOUND_PLATFORM_AUTHORITY_BLOB,
      "Platform unbound authority is not the exact inert template.");
  } else if (platformRecord !== undefined) {
    need(platformRecord.state === "active", "Platform recovery authority has malformed or unsupported state.");
    validateIRecordStructure(platformRecordBytes);
  }
  let platformValidity;
  const platformRecovery = platformRecord?.state !== "active" ? undefined : {
    verify: async (entry, sourceHead, adapters) => {
      validateStagedIRecord(platformRecordBytes, Date.parse(clock()));
      platformValidity = undefined;
      const record = platformRecord;
      // Retain the exact comments accepted by this verifier pass for the outer checkpoint.
      const comments = new Map();
      const getDecisionComment = (repository, id) => adapters.getDecisionComment(repository, id);
      const getCollaboratorPermission = (repository, login) =>
        adapters.getCollaboratorPermission(repository, login);
      const observedAdapters = { ...adapters, getDecisionComment: async (repository, id) => {
        const comment = await getDecisionComment(repository, id);
        if (repository === execution.controller.repository &&
          [record.owner_decision?.comment_id, record.execution_decision_id].includes(id) && !comments.has(id)) {
          comments.set(id, structuredClone(comment));
        }
        return comment;
      } };
      const result = await (overrides.verifyPlatformRecovery ?? verifyPlatformAdmissionRecovery)(record, {
        asOf: clock(), execution, accepted_execution: null,
        basePolicyBytes, proposedPolicyBytes: policyBytes, registryBytes, exceptionsBytes,
        onVerifiedExecution: (accepted) => {
          need(comments.has(record.owner_decision?.comment_id) && comments.has(record.execution_decision_id),
            "Platform verifier did not retain both accepted decision comments.");
          const ownerComment = comments.get(record.owner_decision.comment_id);
          const executionComment = comments.get(record.execution_decision_id);
          need(ownerComment?.id === record.owner_decision.comment_id &&
            ownerComment.user?.id === record.owner_decision.actor_id &&
            ownerComment.user?.login === record.owner_decision.actor_login &&
            executionComment?.id === record.execution_decision_id &&
            executionComment.user?.id === record.owner_decision.actor_id &&
            executionComment.user?.login === record.owner_decision.actor_login,
          "Platform accepted decision identities were not retained.");
          platformValidity = { record: structuredClone(record), accepted: structuredClone(accepted),
            ownerComment, executionComment,
            getDecisionComment, getCollaboratorPermission };
        },
      }, observedAdapters, entry, sourceHead);
      need(platformValidity, "Platform verifier did not retain accepted execution validity.");
      return result;
    },
  };
  const report = await verifyDocsAdmissionEvidence(policy, registry, registrySchema, {
    ...overrides, basePolicy, requireCredential: true, recovery: { getCapability, execution: legacyExecution }, platformRecovery,
  });
  // Controller and authority are re-read after the whole fleet, including
  // unrelated rows; a moving base never reuses an earlier result.
  await verifyController(execution);
  if (capability) {
    report.recovery = finishAdmissionRecovery(capability, legacyExecution, clock());
    reconcileLegacyPending(report);
  }
  report.execution = execution;
  if (platformValidity) {
    // GitHub reads are sequential observations; repeat authorization after all
    // fleet and controller awaits, then check time without another await.
    const { record, accepted, ownerComment, executionComment,
      getDecisionComment, getCollaboratorPermission } = platformValidity;
    const repo = execution.controller.repository;
    need(isDeepStrictEqual(await getDecisionComment(repo, record.owner_decision.comment_id), ownerComment) &&
      isDeepStrictEqual(await getDecisionComment(repo, record.execution_decision_id), executionComment),
    "Platform decision comments changed after the fleet audit.");
    for (const actor of [record.owner_decision, {
      actor_id: executionComment.user?.id, actor_login: executionComment.user?.login,
    }]) {
      const permission = await getCollaboratorPermission(repo, actor.actor_login);
      need(permission?.permission === "admin" && permission.user?.id === actor.actor_id &&
        permission.user?.login === actor.actor_login,
      "Platform decision actor lost current admin authority after the fleet audit.");
    }
    const finalTime = clock();
    const asOf = Date.parse(finalTime);
    need(typeof finalTime === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(finalTime) &&
      Number.isFinite(asOf) && asOf >= Date.parse(record.valid_from) &&
      asOf < Date.parse(record.expires_at) &&
      asOf < Date.parse(accepted.deadline),
    "Platform authority or execution expired after final admission rereads.");
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const policy = process.env.DOCS_ADMISSION_POLICY_PATH;
  const exceptions = process.env.DOCS_ADMISSION_EXCEPTIONS_PATH;
  const inventory = process.env.DOCS_ADMISSION_INVENTORY_PATH;
  const execution = process.env.DOCS_ADMISSION_EXECUTION_PATH;
  need(policy && exceptions && inventory && execution, "Trusted admission verification requires materialized policy, exceptions, inventory and execution paths.");
  console.log(JSON.stringify(await verifyDocsAdmissionChange({ policy, exceptions, inventory, execution })));
}
