import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { verifyDocsAdmissionChange, verifyAdmissionController, readAdmissionBaseFile,
  reconcileLegacyPending } from "./verify-docs-admission-change.mjs";
import { currentAdmissionScope, verifyDocsAdmissionEvidence, requirePlatformPending } from "./verify-docs-cohort-evidence.mjs";
import { PLATFORM_RECOVERY } from "./docs-platform-admission-recovery.mjs";
import { validateDocsProtocolPolicy } from "./governance-policy.mjs";
import { validateDocsGovernanceReferences } from "./docs-cohort-policy.mjs";
import { assertDocsCohortAppendOnly, cohortRecordDigest, cohortEventDigest, validateDocsQualifiedCohorts, qualifiedCohortProjection } from "./docs-cohort-policy.mjs";
import { POLICY_PATH, REGISTRY_PATH, EXCEPTIONS_PATH, RECOVERY_AUTHORITY_PATH,
  recoveryBlob, recoveryDigest, recoveryTarget, reproduceLegacyParserErrors } from "./docs-legacy-admission-recovery.mjs";

const base = "72e1a4c2c0845655153a0b757aa7c87c34ec8f7e";
const head = "c".repeat(40); // Synthetic central PR, never published.
const encode = (value) => Buffer.from(JSON.stringify(value));
test("legacy reconciliation retains complete mixed legacy and Platform pending report", () => {
  const legacy = { repository_id: 1314012020, source_head: "a".repeat(40), status: "recovery_pending" };
  const platform = { repository_id: PLATFORM_RECOVERY.repository_id,
    source_head: PLATFORM_RECOVERY.source_head, status: "recovery_pending",
    semantics: "unverified", qualification: "unverified" };
  const report = { recovery_pending: [legacy, platform], recovery: { recovery_pending: [{
    repository_id: legacy.repository_id, source_head: legacy.source_head }] } };
  assert.equal(reconcileLegacyPending(report), report);
  assert.deepEqual(report.recovery_pending, [legacy, platform]);
  report.recovery.recovery_pending[0].source_head = "b".repeat(40);
  assert.throws(() => reconcileLegacyPending(report), /Legacy pending source changed/u);
});
test("candidate-only evidence and forged current status cannot become current_verified", () => {
  const entry = { repository_id: PLATFORM_RECOVERY.repository_id };
  const head = PLATFORM_RECOVERY.source_head;
  for (const status of ["candidate_evidence_only", "current_verified", undefined]) {
    assert.throws(() => requirePlatformPending({ repository_id: entry.repository_id, source_head: head,
      status, semantics: "unverified", qualification: "unverified" }, entry, head), /remain recovery_pending/u);
  }
  assert.throws(() => requirePlatformPending({ repository_id: entry.repository_id,
    source_head: "f".repeat(40), status: "recovery_pending", semantics: "unverified",
    qualification: "unverified" }, entry, head), /remain recovery_pending/u);
  assert.deepEqual(requirePlatformPending({ repository_id: entry.repository_id, source_head: head,
    status: "recovery_pending", semantics: "unverified", qualification: "unverified" }, entry, head).status,
  "recovery_pending");
});
const caller = (record) => Buffer.from(`name: Documentation Protocol\n\non:\n  pull_request:\n  merge_group:\n  push:\n\npermissions:\n  contents: read\n  id-token: write\n\njobs:\n  docs-protocol:\n    uses: ${record.reusable_workflow.repository}/${record.reusable_workflow.path}@${record.reusable_workflow.revision}\n`);

// Historical runners expose only the legacy CLI. Current v2 runners also
// expose the skipped legacy alternative; schema 1 executes neither qualifier.
const legacyQualification = "Run only the exact installed agent-teams-docs qualify CLI";
const v2Qualification = "Run Cohort v2 qualification through the trusted base-owned runner";
function successfulSteps(role, generation, schemaVersion = generation === 2 ? 3 : 2) {
  const step = (name, conclusion = "success") => ({ name, status: "completed", conclusion });
  if (role === "trusted-qualification") return [
    step(legacyQualification, schemaVersion === 2 ? "success" : "skipped"),
    ...(generation === 2 ? [step(v2Qualification)] : []),
    step("Confirm current controller authority stayed stable through qualification"),
  ];
  if (role === "docs-protocol-check") return [step("Run repository semantic documentation gate")];
  return [];
}

test("admission execution fixtures follow canonical legacy and v2 workflow branches", async () => {
  const workflow = YAML.parse(await readFile(".github/workflows/docs-protocol-check.yml", "utf8"));
  const steps = workflow.jobs["trusted-qualification"].steps;
  for (const [name, profile] of [[legacyQualification, "legacy"], [v2Qualification, "cohort-v2"]]) {
    const matching = steps.filter((step) => step.name === name);
    assert.equal(matching.length, 1);
    assert.equal(matching[0].if, `needs.trusted-authorize.outputs.qualification-profile == '${profile}'`);
  }
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "central-admission-integration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "synthetic-job-token";
  t.after(() => { if (token === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = token; });
  const baseBytes = await readAdmissionBaseFile(POLICY_PATH, base);
  const policy = JSON.parse(baseBytes);
  // Keep checkout authority and proof coordinates on the same historical snapshot.
  const registryBytes = await readAdmissionBaseFile(REGISTRY_PATH, base);
  const registry = JSON.parse(registryBytes);
  const asOfDate = new Date(Date.parse(registry.events.at(-1).effective_at) + 1_000);
  const asOf = asOfDate.toISOString().replace(/\.000Z$/u, "Z");
  const validFrom = new Date(asOfDate.getTime() - 60_000).toISOString().replace(/\.000Z$/u, "Z");
  const expiresAt = new Date(asOfDate.getTime() + 60_000).toISOString().replace(/\.000Z$/u, "Z");
  const exceptions = await readAdmissionBaseFile(EXCEPTIONS_PATH, base);
  const candidates = policy.repositories.filter((row) => ["bound", "rollout_pending"].includes(row.cohort_binding_status));
  const selected = policy.repositories.find((row) => row.repository === "agent-teams-ai/docs-protocol-canary-20260817");
  const collateral = policy.repositories.find((row) => row.repository === "agent-teams-ai/agent-teams-token");
  const originalCollateral = structuredClone(collateral);
  selected.desired_cohort_id = "docs-2026-09-08-stable15";
  const source = registry.cohorts.find((row) => row.cohort_id === collateral.observed_cohort_id);
  const sourceHead = "d".repeat(40);
  const recordFor = (entry) => registry.cohorts.find((row) => row.cohort_id === entry.observed_cohort_id);
  const entryFor = (repository) => candidates.find((entry) => entry.repository === repository);
  const projectionFor = (entry, id = entry.observed_cohort_id) => {
    const p = qualifiedCohortProjection(registry, id, { asOf });
    return encode({ ...p, repository: { provider: "github", id: String(entry.repository_id), nameWithOwner: entry.repository },
      cohortAuthority: { channel: p.channel, recordDigest: p.recordDigest, qualificationEventDigest: p.qualificationEventDigest,
        eligibleAfter: p.eligibleAfter, upgradeFrom: p.upgradeFrom, rollbackTo: p.rollbackTo } });
  };
  const runner = source.reusable_workflow.revision;
  const historicalPolicy = await readAdmissionBaseFile(POLICY_PATH, runner);
  const historicalRegistry = await readAdmissionBaseFile(REGISTRY_PATH, runner);
  const schemaPolicy = await readAdmissionBaseFile(POLICY_PATH.replace(".json", ".schema.json"), runner);
  const schemaRegistry = await readAdmissionBaseFile(REGISTRY_PATH.replace(".json", ".schema.json"), runner);
  const parserErrors = await reproduceLegacyParserErrors(JSON.parse(baseBytes), registry,
    { policy: JSON.parse(schemaPolicy), registry: JSON.parse(schemaRegistry) },
    { policy: JSON.parse(historicalPolicy), registry: JSON.parse(historicalRegistry) });
  const coord = (path, revision, content) => ({ path, revision, blob: recoveryBlob(content) });
  const diagnostic = `Central Docs policy schema validation failed: ${parserErrors.policy.map(({ instancePath, message }) => `${instancePath || "/"} ${message}`).join("; ")}`;
  const log = Buffer.from(`CONTROLLER_SNAPSHOT_SHA: ${base}\nJOB_WORKFLOW_SHA: ${runner}\nGITHUB_SHA: ${sourceHead}\n${diagnostic}\n`);
  const historicalLog = Buffer.from(`CONTROLLER_SNAPSHOT_SHA: ${runner}\nJOB_WORKFLOW_SHA: ${runner}\nGITHUB_SHA: ${collateral.observed_default_branch_evidence.revision}\n`);
  const failureStep = ["Authorize exact consumer snapshot without executing consumer code", null,
    "Require successful trusted structural authorization", "Require successful trusted qualification"];
  const jobs = ["trusted-authorize", "trusted-structural", "trusted-qualification", "docs-protocol-check"].map((role, i) => ({
    id: 71 + i, run_id: 800, run_attempt: 1, head_sha: sourceHead, name: `docs-protocol / ${role}`,
    html_url: `https://github.com/${collateral.repository}/actions/runs/800/job/${71 + i}`, status: "completed",
    conclusion: i === 1 ? "skipped" : "failure", steps: failureStep[i] === null ? [] :
      [{ number: 1, name: failureStep[i], status: "completed", conclusion: "failure" }],
  }));
  const proof = { schema_version: 1, source_target: recoveryTarget(registry, source.cohort_id),
    historical_inputs: { policy: coord(POLICY_PATH, runner, historicalPolicy), registry: coord(REGISTRY_PATH, runner, historicalRegistry) },
    historical_run: { attempt: 1, authorize_job_id: 171, log_digest: recoveryDigest(historicalLog) },
    current_inputs: { policy: coord(POLICY_PATH, base, baseBytes), registry: coord(REGISTRY_PATH, base, registryBytes) },
    schemas: { policy: coord(POLICY_PATH.replace(".json", ".schema.json"), runner, schemaPolicy),
      registry: coord(REGISTRY_PATH.replace(".json", ".schema.json"), runner, schemaRegistry) },
    caller_blob: recoveryBlob(caller(source)), projection_blob: recoveryBlob(projectionFor(collateral)), parser_errors: parserErrors,
    run: { id: 800, attempt: 1, workflow_id: collateral.observed_default_branch_evidence.workflow_id,
      head: sourceHead, branch: "main", path: collateral.caller_workflow_path }, jobs, parser_job_id: 71, parser_log_digest: recoveryDigest(log) };
  const execution = { controller: { repository: "agent-teams-ai/.github", repository_id: 1316243981 },
    pull_number: 999, pull_id: 1999, head_ref: "synthetic-selection", run_id: 3117, run_attempt: 1,
    base, head, execution_base: base, changed_files: [POLICY_PATH] };
  const operation = { kind: "selection", repository_id: selected.repository_id, before_policy_blob: recoveryBlob(baseBytes),
    after_policy_blob: recoveryBlob(encode(policy)), registry_blob: recoveryBlob(registryBytes), exceptions_blob: recoveryBlob(exceptions),
    target: recoveryTarget(registry, selected.desired_cohort_id) };
  const proofCoordinate = coord("governance/evidence/docs-admission-recovery/synthetic-integration.json", base, encode(proof));
  let decisionText = `Authorize central admission recovery synthetic-integration\nRepository: agent-teams-ai/.github (1316243981)\nPR: 999\nPolicy: ${operation.before_policy_blob} -> ${operation.after_policy_blob}\nProof: ${base}:${proofCoordinate.path}@${proofCoordinate.blob}\nExpires: ${expiresAt}\n`;
  const authorization = { id: "synthetic-integration", state: "active", valid_from: validFrom, expires_at: expiresAt,
    controller: execution.controller, pull_number: 999, operation,
    incidents: [{ source_entry: originalCollateral, source_head: sourceHead, proof: proofCoordinate,
      owner_decision: { comment_id: 7, actor_id: 8, actor_login: "synthetic-owner", body_digest: recoveryDigest(Buffer.from(decisionText)) } }] };
  const authority = { schema_version: 1, authorizations: [authorization] };
  const controller = { id: 1316243981, full_name: "agent-teams-ai/.github", default_branch: "main", archived: false, disabled: false };
  const centralPull = { id: 1999, number: 999, state: "open", merged: false, changed_files: 1,
    base: { sha: base, ref: "main", repo: controller },
    head: { sha: head, ref: "synthetic-selection", repo: controller } };
  let controllerCalls = 0;
  const options = {
    // Imported incident/recovery cases retain complete-fleet semantics.
    fullFleetCurrent: true,
    clock: () => asOf, asOf, execution, basePolicyBytes: baseBytes,
    verifyController: async (value) => {
      controllerCalls++;
      return verifyAdmissionController(value, async (path) => path.endsWith("/pulls/999") ? centralPull
        : path.endsWith("/branches/main") ? { commit: { sha: base } } : controller);
    },
    readBaseFile: async (path, revision) => path === RECOVERY_AUTHORITY_PATH ? encode(authority) : readAdmissionBaseFile(path, revision),
    getRepository: async (repository) => ({ id: entryFor(repository).repository_id, full_name: repository,
      default_branch: "main", private: false, archived: false, disabled: false }),
    isCommitAncestor: async () => true,
    getDefaultBranchHead: async (repository) => repository === collateral.repository ? sourceHead : entryFor(repository).observed_default_branch_evidence.revision,
    getCheckRuns: async (repository, revision) => {
      const evidence = entryFor(repository).observed_default_branch_evidence;
      return [{ id: revision === sourceHead ? 74 : evidence.check_run_id, head_sha: revision, name: evidence.required_context,
        app: { id: evidence.integration_id }, conclusion: revision === sourceHead ? "failure" : "success",
        html_url: revision === sourceHead ? jobs[3].html_url : evidence.check_run_url }];
    },
    getWorkflowRun: async (repository, id) => {
      const entry = entryFor(repository), evidence = entry.observed_default_branch_evidence, workflow = recordFor(entry).reusable_workflow;
      return { id, workflow_id: evidence.workflow_id, run_attempt: 1, head_sha: id === 800 ? sourceHead : evidence.revision,
        head_branch: "main", path: evidence.caller_workflow_path, event: "push", status: "completed", conclusion: id === 800 ? "failure" : "success",
        repository: { id: entry.repository_id, full_name: repository },
        referenced_workflows: [{ sha: workflow.revision, path: `${workflow.repository}/${workflow.path}@${workflow.revision}` }] };
    },
    getWorkflowJobs: async (repository, id) => id === 800 ? structuredClone(jobs) : [{ id: 171, run_id: id, run_attempt: 1,
      head_sha: collateral.observed_default_branch_evidence.revision, name: "docs-protocol / trusted-authorize", status: "completed", conclusion: "success",
      html_url: `https://github.com/${repository}/actions/runs/${id}/job/171`,
      steps: [{ name: failureStep[0], status: "completed", conclusion: "success" }] }],
    readRepositoryFile: async (repository, path) => path === "architecture/foundation/docs-consumer-integration.json" ? encode({ schemaVersion: recordFor(entryFor(repository)).cohort_generation === 2 ? 3 : 2 }) : path.endsWith("managed-state.json") ? projectionFor(entryFor(repository)) : caller(recordFor(entryFor(repository))),
    readGitFile: async (repository, path, revision) => repository === execution.controller.repository
      ? path === proofCoordinate.path ? encode(proof) : readAdmissionBaseFile(path, revision)
      : options.readRepositoryFile(repository, path, revision),
    getDecisionComment: async () => ({ id: 7, user: { id: 8, login: "synthetic-owner", type: "User" }, body: decisionText,
      issue_url: "https://api.github.com/repos/agent-teams-ai/.github/issues/999" }),
    getCollaboratorPermission: async () => ({ permission: "admin", user: { id: 8, login: "synthetic-owner" } }),
    getJobLog: async (_repository, id) => id === 171 ? historicalLog : log,
  };
  const paths = { policy: join(directory, "policy.json"), exceptions: join(directory, "exceptions.json") };
  await writeFile(paths.exceptions, exceptions);
  // The real verifier reads checkout authority relative to cwd. Materialize its
  // pinned inputs without modifying the shared worktree or bypassing base checks.
  await mkdir(join(directory, "governance"));
  await symlink(resolve(".git"), join(directory, ".git"), "dir");
  for (const path of [REGISTRY_PATH, "governance/docs-protocol-policy-v2.schema.json",
    "governance/docs-protocol-exceptions.schema.json", "governance/docs-qualified-cohorts.schema.json",
    "governance/code-security-defaults.json"]) {
    await writeFile(join(directory, path), await readAdmissionBaseFile(path, base));
  }
  return { policy, registry, selected, collateral, originalCollateral, authority, authorization, execution, options, centralPull,
    projectionFor, checkoutRegistryPath: join(directory, REGISTRY_PATH),
    bindOperation: (kind) => {
      operation.kind = kind; operation.after_policy_blob = recoveryBlob(encode(policy));
      operation.target = recoveryTarget(registry, selected.desired_cohort_id);
      decisionText = `Authorize central admission recovery synthetic-integration\nRepository: agent-teams-ai/.github (1316243981)\nPR: 999\nPolicy: ${operation.before_policy_blob} -> ${operation.after_policy_blob}\nProof: ${base}:${proofCoordinate.path}@${proofCoordinate.blob}\nExpires: ${expiresAt}\n`;
      authorization.incidents[0].owner_decision.body_digest = recoveryDigest(Buffer.from(decisionText));
    },
    controllerCalls: () => controllerCalls,
    run: async () => {
      await writeFile(paths.policy, encode(policy));
      const cwd = process.cwd();
      // These tests run serially; always restore cwd, including on rejection.
      process.chdir(directory);
      try { return await verifyDocsAdmissionChange(paths, options); }
      finally { process.chdir(cwd); }
    } };
}

test("full imported verifier admits exact TEST selection with independently covered unchanged Token pending", async (t) => {
  const f = await fixture(t); const result = await f.run();
  assert.equal(result.historical_verified.length, 6); assert.equal(result.current_verified.length, 5);
  assert.equal(result.recovery_pending.length, 1); assert.equal(result.recovery_pending[0].repository_id, f.collateral.repository_id);
  assert.deepEqual(f.collateral, f.originalCollateral);
  assert.equal(f.selected.desired_cohort_id, "docs-2026-09-08-stable15");
  assert.equal(f.collateral.desired_cohort_id, "docs-2026-08-28-stable8");
  assert.equal(f.controllerCalls(), 2);
  assert.deepEqual(result.execution, f.execution);
  assert.deepEqual(result.recovery.execution, {
    controller: f.execution.controller, pull_number: f.execution.pull_number,
    base: f.execution.base, head: f.execution.head, execution_base: f.execution.execution_base,
    changed_files: f.execution.changed_files,
  });
});
for (const [name, mutate] of [
  ["wrong PR ID", (f) => { f.execution.pull_id++; }],
  ["wrong head ref", (f) => { f.execution.head_ref = "other-branch"; }],
  ["invalid run ID", (f) => { f.execution.run_id = 0; }],
  ["invalid run attempt", (f) => { f.execution.run_attempt = 0; }],
  ["extra execution field", (f) => { f.execution.unreviewed = true; }],
  ["extra controller field", (f) => { f.execution.controller.unreviewed = true; }],
  ["missing execution field", (f) => { delete f.execution.pull_id; }],
]) {
  test(`admission rejects ${name} before legacy authority is read`, async (t) => {
    const f = await fixture(t);
    const read = f.options.readBaseFile;
    let authorityReads = 0;
    f.options.readBaseFile = async (filePath, revision) => {
      if (filePath === RECOVERY_AUTHORITY_PATH) authorityReads++;
      return read(filePath, revision);
    };
    mutate(f);
    await assert.rejects(f.run(), /Admission execution must bind|Live admission controller/u);
    assert.equal(authorityReads, 0);
  });
}
test("real legacy recovery report reconciles while a Platform pending row remains in the fleet", async (t) => {
  const f = await fixture(t);
  const report = await f.run();
  const platform = { repository_id: PLATFORM_RECOVERY.repository_id,
    source_head: PLATFORM_RECOVERY.source_head, status: "recovery_pending",
    semantics: "unverified", qualification: "unverified" };
  report.recovery_pending.push(platform);
  assert.equal(reconcileLegacyPending(report), report);
  assert.equal(report.recovery_pending.length, 2);
  assert.deepEqual(report.recovery_pending.at(-1), platform);
});
test("production fleet composition routes the latest failed Platform check and rejects a later success", async (t) => {
  const f = await fixture(t);
  f.options.fullFleetCurrent = false;
  const platform = f.policy.repositories.find((row) => row.repository_id === PLATFORM_RECOVERY.repository_id);
  const originalChecks = f.options.getCheckRuns;
  const originalGet = f.options.getDefaultBranchHead;
  const sourceCheck = (id, run, conclusion) => ({ id, head_sha: PLATFORM_RECOVERY.source_head,
    name: platform.observed_default_branch_evidence.required_context,
    app: { id: platform.observed_default_branch_evidence.integration_id }, conclusion,
    html_url: `https://github.com/${platform.repository}/actions/runs/${run}/job/${id}` });
  const checks = [sourceCheck(11, 101, "success"), sourceCheck(13, 103, "failure")];
  f.options.getCheckRuns = async (repository, revision) => repository === platform.repository &&
    revision === PLATFORM_RECOVERY.source_head ? structuredClone(checks) : originalChecks(repository, revision);
  // The collateral legacy row remains successful here so this directly exercises
  // the production fleet adapter without a synthetic recovery capability.
  f.options.getDefaultBranchHead = async (repository, branch) => repository === f.collateral.repository
    ? f.collateral.observed_default_branch_evidence.revision :
      (repository === platform.repository ? PLATFORM_RECOVERY.source_head : originalGet(repository, branch));
  let clockCalls = 0;
  let rejectRemainingFleet = false;
  let remainingFleetFailure = false;
  const collateralHead = "e".repeat(40);
  const successfulChecks = f.options.getCheckRuns;
  const successfulHead = f.options.getDefaultBranchHead;
  f.options.getCheckRuns = async (repository, revision) => remainingFleetFailure &&
    repository === f.collateral.repository && revision === collateralHead
    ? [{ ...((await successfulChecks(repository, f.collateral.observed_default_branch_evidence.revision))[0]),
      id: 999, head_sha: collateralHead, conclusion: "failure" }]
    : successfulChecks(repository, revision);
  f.options.getDefaultBranchHead = async (repository, branch) => remainingFleetFailure &&
    repository === f.collateral.repository ? collateralHead : successfulHead(repository, branch);
  const schema = JSON.parse(await readAdmissionBaseFile("governance/docs-qualified-cohorts.schema.json", base));
  const verifyPlatform = async (entry, sourceHead, adapters) => {
      assert.equal(entry.repository_id, PLATFORM_RECOVERY.repository_id);
      assert.equal(sourceHead, PLATFORM_RECOVERY.source_head);
      assert.match(await adapters.currentTime(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
      if (rejectRemainingFleet) remainingFleetFailure = true;
      await adapters.evaluateRemainingFleet({ platform_repository_id: entry.repository_id,
        changed_repository_id: f.selected.repository_id });
      clockCalls++;
      return { repository_id: entry.repository_id, source_head: sourceHead, status: "recovery_pending",
        semantics: "unverified", qualification: "unverified" };
  };
  const report = await verifyDocsAdmissionEvidence(f.policy, f.registry, schema, {
    ...f.options, platformRecovery: { verify: verifyPlatform },
  });
  assert.equal(report.recovery_pending.length, 1);
  assert.equal(report.recovery_pending[0].repository_id, PLATFORM_RECOVERY.repository_id);
  assert.equal(report.current_verified.length, 5);
  assert.deepEqual(report.current_not_evaluated, []);
  assert.ok(clockCalls >= 2);
  rejectRemainingFleet = true;
  await assert.rejects(verifyDocsAdmissionEvidence(f.policy, f.registry, schema, {
    ...f.options, platformRecovery: { verify: verifyPlatform },
  }), /current default-branch head requires every decisive admitted check to succeed/u);
  rejectRemainingFleet = false;
  remainingFleetFailure = false;
  checks.push(sourceCheck(15, 105, "success"));
  await assert.rejects(verifyDocsAdmissionEvidence(f.policy, f.registry, schema, {
    ...f.options, platformRecovery: { verify: async () => {
      throw new Error("Platform recovery must not run after a later success.");
    } },
  }), /requires every decisive admitted check to succeed/u);
});

function stagedSyntheticPlatformRecord(record) {
  Object.assign(record, { schema_version: 1, id: "platform-a3-admission-cycle", state: "active",
    central_pull: PLATFORM_RECOVERY.central_pull, before_policy_blob: PLATFORM_RECOVERY.before_policy_blob,
    after_policy_blob: PLATFORM_RECOVERY.after_policy_blob, registry_blob: PLATFORM_RECOVERY.registry_blob,
    exceptions_blob: PLATFORM_RECOVERY.exceptions_blob,
    proof: { revision: "a".repeat(40), path: "governance/evidence/docs-admission-recovery/platform-a3.json",
      blob: "b".repeat(40) },
    failure: { run_id: 71, attempt: 1, workflow_id: 72, authorize_job_id: 73, semantic_job_id: 74,
      diagnostic_digest: recoveryDigest(Buffer.from("synthetic diagnostic")) } });
  record.owner_decision = { comment_id: 11, actor_id: 8, actor_login: "synthetic-owner",
    body_digest: recoveryDigest(Buffer.from("synthetic owner decision")) };
  record.execution_decision_id = 12;
  return record;
}

function installSyntheticPlatform(f, record, accepted) {
  const platform = f.policy.repositories.find((row) => row.repository_id === PLATFORM_RECOVERY.repository_id);
  stagedSyntheticPlatformRecord(record);
  const state = {
    ownerComment: { id: 11, user: { id: 8, login: "synthetic-owner", type: "User" }, body: "owner decision" },
    executionComment: { id: 12, user: { id: 8, login: "synthetic-owner", type: "User" }, body: "execution decision" },
    permission: { permission: "admin", user: { id: 8, login: "synthetic-owner" } },
    verifierCalls: 0, commentReads: 0, permissionReads: 0,
  };
  const readBaseFile = f.options.readBaseFile;
  f.options.readBaseFile = (path, revision) => path === "governance/docs-platform-admission-recovery.json"
    ? encode(record) : readBaseFile(path, revision);
  const getChecks = f.options.getCheckRuns;
  f.options.getCheckRuns = (repository, revision) => repository === platform.repository &&
    revision === PLATFORM_RECOVERY.source_head ? [{ id: 71, head_sha: revision,
      name: platform.observed_default_branch_evidence.required_context,
      app: { id: platform.observed_default_branch_evidence.integration_id }, conclusion: "failure",
      html_url: `https://github.com/${repository}/actions/runs/71/job/71` }] : getChecks(repository, revision);
  const getHead = f.options.getDefaultBranchHead;
  f.options.getDefaultBranchHead = async (repository, branch) => repository === f.collateral.repository
    ? f.collateral.observed_default_branch_evidence.revision
    : repository === platform.repository ? PLATFORM_RECOVERY.source_head : getHead(repository, branch);
  f.options.getDecisionComment = async (_repository, id) => {
    state.commentReads++;
    return id === 11 ? state.ownerComment : id === 12 ? state.executionComment : null;
  };
  f.options.getCollaboratorPermission = async () => {
    state.permissionReads++;
    return state.permission;
  };
  f.options.verifyPlatformRecovery = async (_record, input, adapters, entry, sourceHead) => {
    assert.deepEqual(input.execution, f.execution);
    assert.equal(entry.repository_id, platform.repository_id);
    assert.equal(sourceHead, PLATFORM_RECOVERY.source_head);
    await adapters.getDecisionComment("agent-teams-ai/.github", 11);
    await adapters.getDecisionComment("agent-teams-ai/.github", 12);
    input.onVerifiedExecution(accepted);
    state.verifierCalls++;
    return { repository_id: entry.repository_id, source_head: sourceHead, status: "recovery_pending",
      semantics: "unverified", qualification: "unverified" };
  };
  return { state, platform };
}

for (const crossing of ["final controller reread", "fleet head reread"]) {
  test(`outer admission rejects Platform expiry during ${crossing}`, async (t) => {
    const f = await fixture(t);
    const platform = f.policy.repositories.find((row) => row.repository_id === PLATFORM_RECOVERY.repository_id);
    const start = Date.parse(f.options.asOf);
    const stamp = (offset) => new Date(start + offset).toISOString().replace(/\.000Z$/u, "Z");
    const record = { valid_from: stamp(-1_000), expires_at: stamp(crossing === "fleet head reread" ? 30_000 : 60_000) };
    const accepted = { deadline: stamp(crossing === "final controller reread" ? 30_000 : 60_000) };
    let currentTime = f.options.asOf;
    f.options.clock = () => currentTime;
    const { state } = installSyntheticPlatform(f, record, accepted);
    const getHead = f.options.getDefaultBranchHead;
    let finalPlatformReads = 0;
    f.options.getDefaultBranchHead = async (repository, branch) => {
      const result = await getHead(repository, branch);
      if (repository === platform.repository && state.verifierCalls > 0 && ++finalPlatformReads === 2 &&
        crossing === "fleet head reread") { currentTime = record.expires_at; }
      return result;
    };
    if (crossing === "final controller reread") {
      const verify = f.options.verifyController;
      let calls = 0;
      f.options.verifyController = async (...args) => {
        const result = await verify(...args);
        if (++calls === 2) { currentTime = accepted.deadline; }
        return result;
      };
    }
    await assert.rejects(f.run(), /Platform authority or execution expired/u);
    assert.equal(state.verifierCalls, 2);
    if (crossing === "fleet head reread") { assert.ok(finalPlatformReads >= 2); }
  });
}

test("outer admission retains Platform recovery after final authorization rereads", async (t) => {
  const f = await fixture(t);
  const stamp = (offset) => new Date(Date.parse(f.options.asOf) + offset).toISOString().replace(/\.000Z$/u, "Z");
  const { state } = installSyntheticPlatform(f,
    { valid_from: stamp(-1_000), expires_at: stamp(60_000) }, { deadline: stamp(60_000) });
  const report = await f.run();
  assert.equal(report.recovery_pending.some((row) => row.repository_id === PLATFORM_RECOVERY.repository_id), true);
  assert.equal(state.verifierCalls, 2);
  assert.equal(state.commentReads, 6);
  assert.equal(state.permissionReads, 2);
});

for (const crossing of ["fleet head reread", "final controller reread"]) {
  for (const revoked of ["owner comment", "execution comment", "admin permission"]) {
    test(`outer admission rejects ${revoked} revocation during ${crossing}`, async (t) => {
      const f = await fixture(t);
      const stamp = (offset) => new Date(Date.parse(f.options.asOf) + offset).toISOString().replace(/\.000Z$/u, "Z");
      const { state, platform } = installSyntheticPlatform(f,
        { valid_from: stamp(-1_000), expires_at: stamp(60_000) }, { deadline: stamp(60_000) });
      let revokedDuringAwait = false;
      const revoke = () => {
        revokedDuringAwait = true;
        if (revoked === "owner comment") state.ownerComment = { ...state.ownerComment, body: "revoked" };
        if (revoked === "execution comment") state.executionComment = { ...state.executionComment, body: "revoked" };
        if (revoked === "admin permission") state.permission = { ...state.permission, permission: "read" };
      };
      if (crossing === "fleet head reread") {
        const getHead = f.options.getDefaultBranchHead;
        f.options.getDefaultBranchHead = async (repository, branch) => {
          const result = await getHead(repository, branch);
          if (repository === platform.repository && state.verifierCalls === 2 && !revokedDuringAwait) { revoke(); }
          return result;
        };
      } else {
        const verify = f.options.verifyController;
        f.options.verifyController = async (...args) => {
          const result = await verify(...args);
          if (f.controllerCalls() === 2) { revoke(); }
          return result;
        };
      }
      await assert.rejects(f.run(), revoked === "admin permission"
        ? /lost current admin authority after the fleet audit/u : /decision comments changed after the fleet audit/u);
      assert.equal(state.verifierCalls, 2);
      assert.equal(revokedDuringAwait, true);
    });
  }
}

test("historical fixture stays pinned across unrelated checkout registry appends", async (t) => {
  const pinnedRegistryBytes = await readAdmissionBaseFile(REGISTRY_PATH, base);
  const f = await fixture(t);
  assert.ok(f.registry.cohorts.some((row) => row.cohort_id === "docs-2026-09-09-stable16"));
  // Derive an unrelated, unpublished test successor solely from immutable data.
  // No ambient checkout successor (such as stable17) is needed for this regression.
  const laterRegistry = structuredClone(f.registry);
  const successor = structuredClone(laterRegistry.cohorts.at(-1));
  successor.cohort_id = "docs-2026-09-09-fixture-successor";
  successor.upgrade_from = [laterRegistry.cohorts.at(-1).cohort_id];
  successor.rollback_to = [];
  successor.record_digest = cohortRecordDigest(successor);
  laterRegistry.cohorts.push(successor);
  const publication = structuredClone(laterRegistry.events.find((event) =>
    event.cohort_id === successor.upgrade_from[0] && event.state === "PUBLISHED_UNQUALIFIED"));
  publication.cohort_id = successor.cohort_id;
  publication.sequence = laterRegistry.events.length + 1;
  publication.previous_event_digest = laterRegistry.events.at(-1).event_digest;
  publication.event_digest = cohortEventDigest(publication);
  laterRegistry.events.push(publication);
  const schema = JSON.parse(await readAdmissionBaseFile("governance/docs-qualified-cohorts.schema.json", base));
  validateDocsQualifiedCohorts(laterRegistry, schema, { asOf: f.options.asOf });
  assertDocsCohortAppendOnly(f.registry, laterRegistry);
  assert.ok(!f.registry.cohorts.some((row) => row.cohort_id === successor.cohort_id));
  assert.deepEqual(await readFile(f.checkoutRegistryPath), pinnedRegistryBytes);
  assert.equal(f.authorization.operation.registry_blob, recoveryBlob(pinnedRegistryBytes));
  assert.equal(f.authorization.operation.exceptions_blob, recoveryBlob(await readAdmissionBaseFile(EXCEPTIONS_PATH, base)));
  await f.run();
  // Even a valid later registry must fail the real exact-base control if mixed in.
  await writeFile(f.checkoutRegistryPath, encode(laterRegistry));
  const cwd = process.cwd();
  await assert.rejects(f.run(), /Checkout authority is not the exact base/);
  assert.equal(process.cwd(), cwd);
  await writeFile(f.checkoutRegistryPath, pinnedRegistryBytes);
  await f.run();
});

const negatives = {
  "PR-head incident proof": (f) => { f.options.readBaseFile = async (path, revision) => path === RECOVERY_AUTHORITY_PATH ? null : readAdmissionBaseFile(path, revision); },
  "self-approved authority": (f) => { f.authorization.approved = true; },
  "uncovered additional failed row": (f) => { const get = f.options.getCheckRuns;
    f.options.getCheckRuns = async (repo, revision) => repo === "agent-teams-ai/agent-runtime" ? [] : get(repo, revision); },
  "wrong current source head": (f) => { const get = f.options.getDefaultBranchHead;
    f.options.getDefaultBranchHead = async (repo) => repo === f.collateral.repository ? "e".repeat(40) : get(repo); },
  "wrong current target generation": (f) => { delete f.selected.desired_cohort_generation; },
  "Token selection of TEST-only stable15": (f) => { Object.assign(f.collateral, { desired_cohort_id: f.selected.desired_cohort_id, desired_cohort_generation: 2, cohort_binding_status: "rollout_pending" }); },
  "unknown full policy field": (f) => { f.policy.arbitrary = true; },
  "revoked authority": (f) => { f.authorization.state = "revoked"; },
  "cross-PR replay": (f) => { f.authorization.pull_number = 998; },
  "late controller drift": (f) => { const verify = f.options.verifyController;
    f.options.verifyController = async (execution) => { if (f.controllerCalls() === 1) f.centralPull.head.sha = "f".repeat(40); return verify(execution); }; },
};
for (const [name, mutate] of Object.entries(negatives)) {
  test(`full imported verifier rejects ${name}`, async (t) => { const f = await fixture(t); mutate(f); await assert.rejects(f.run()); });
}


function successfulTarget(f, advance = false) {
  const original = structuredClone(f.selected);
  const targetId = advance ? "docs-2026-09-08-stable14" : f.selected.desired_cohort_id;
  const record = f.registry.cohorts.find((row) => row.cohort_id === targetId);
  const targetHead = "e".repeat(40);
  const evidence = { ...original.observed_default_branch_evidence, revision: targetHead, check_run_id: 904,
    check_run_url: `https://github.com/${original.repository}/actions/runs/900/job/904`, workflow_run_id: 900,
    caller_workflow_digest: record.assets.caller_workflow.rendered_digest, observed_at: "2026-09-08T18:00:00Z" };
  if (advance) {
    const packageByName = new Map(record.packages.map((pkg) => [pkg.name, pkg.version]));
    Object.assign(f.selected, { desired_cohort_id: targetId, observed_cohort_id: targetId, observed_cohort_generation: 2,
      observed_cohort_record_digest: record.record_digest,
      observed_cohort_event_digest: f.registry.events.find((event) => event.cohort_id === targetId && event.state === "QUALIFIED").event_digest,
      cohort_binding_status: "bound", observed_default_branch_evidence: evidence,
      exact_package_version: packageByName.get("@agent-teams/docs-protocol"),
      exact_foundation_version: packageByName.get("@agent-teams/engineering-foundation"), reusable_workflow_revision: record.reusable_workflow.revision,
      exact_cohort_v2_packages: Object.fromEntries(["repository-mutation", "document-authoring", "docs-protocol", "docs-protocol-agent-teams", "engineering-foundation"]
        .map((name) => [name.replaceAll("-", "_"), packageByName.get(`@agent-teams/${name}`)])) });
    f.selected.qualification.observed_revision = targetHead;
    f.bindOperation("observation");
  }
  const priorOptions = { ...f.options };
  f.options.getDefaultBranchHead = async (repo) => repo === original.repository ? targetHead : priorOptions.getDefaultBranchHead(repo);
  f.options.getCheckRuns = async (repo, revision) => repo === original.repository ? [{ id: revision === targetHead ? 904 : original.observed_default_branch_evidence.check_run_id,
    head_sha: revision, name: evidence.required_context, app: { id: evidence.integration_id }, conclusion: "success",
    html_url: revision === targetHead ? evidence.check_run_url : original.observed_default_branch_evidence.check_run_url }] : priorOptions.getCheckRuns(repo, revision);
  f.options.getWorkflowRun = async (repo, id) => {
    if (repo !== original.repository) return priorOptions.getWorkflowRun(repo, id);
    const binding = id === 900 ? record : f.registry.cohorts.find((row) => row.cohort_id === original.observed_cohort_id);
    const workflow = binding.reusable_workflow;
    return { id, workflow_id: evidence.workflow_id, run_attempt: 1, head_sha: id === 900 ? targetHead : original.observed_default_branch_evidence.revision,
      head_branch: "main", path: original.caller_workflow_path, event: "push", status: "completed", conclusion: "success",
      repository: { id: original.repository_id, full_name: repo },
      referenced_workflows: [{ sha: workflow.revision, path: `${workflow.repository}/${workflow.path}@${workflow.revision}` }] };
  };
  f.options.getWorkflowJobs = async (repo, id, attempt) => repo === original.repository ?
    ["trusted-authorize", "trusted-structural", "trusted-qualification", "docs-protocol-check"].map((role, index) => ({ id: 901 + index,
      run_id: 900, run_attempt: 1, head_sha: targetHead, name: `docs-protocol / ${role}`, status: "completed", conclusion: "success",
      html_url: `https://github.com/${repo}/actions/runs/900/job/${901 + index}`,
      steps: successfulSteps(role, record.cohort_generation) })) : priorOptions.getWorkflowJobs(repo, id, attempt);
  f.options.readRepositoryFile = async (repo, path, revision) => {
    if (repo !== original.repository) return priorOptions.readRepositoryFile(repo, path, revision);
    const id = revision === targetHead ? targetId : original.observed_cohort_id;
    return path === "architecture/foundation/docs-consumer-integration.json" ? encode({ schemaVersion: record.cohort_generation === 2 ? 3 : 2 }) : path.endsWith("managed-state.json") ? f.projectionFor(original, id) : caller(f.registry.cohorts.find((row) => row.cohort_id === id));
  };
  return { original, targetHead, targetId };
}

test("full imported selected stable15 success remains separate from historical observed stable9.1", async (t) => {
  const f = await fixture(t); const { original, targetId } = successfulTarget(f);
  const report = await f.run();
  assert.equal(report.current_verified.find((row) => row.repository_id === f.selected.repository_id).cohort_id, targetId);
  assert.equal(f.selected.observed_cohort_id, original.observed_cohort_id);
  assert.equal(report.recovery_pending.length, 1);
});

test("full imported observation finalizes only the base-selected target while collateral remains pending", async (t) => {
  const f = await fixture(t); const { targetId, targetHead } = successfulTarget(f, true);
  const report = await f.run();
  assert.equal(report.current_verified.find((row) => row.repository_id === f.selected.repository_id).revision, targetHead);
  assert.equal(f.selected.observed_cohort_id, targetId);
  assert.equal(report.recovery.authorization_id, "synthetic-integration");
  assert.equal(report.recovery_pending.length, 1);
});

for (const conclusion of ["failure", "skipped"]) {
  test(`full imported observation rejects ${conclusion} target qualification`, async (t) => {
    const f = await fixture(t); successfulTarget(f, true);
    const get = f.options.getWorkflowJobs;
    f.options.getWorkflowJobs = async (repo, id, attempt) => (await get(repo, id, attempt)).map((job) =>
      repo === f.selected.repository && job.name.endsWith("trusted-qualification") ? { ...job, conclusion } : job);
    await assert.rejects(f.run(), /target trusted\/semantic job/u);
  });
}

// Independent review regressions: exercise repeated PR/push executions on one
// exact head, mixed conclusions, and mutation during the final reread.
for (const advance of [false, true]) {
  for (const late of [false, true]) {
    for (const conclusion of ["success", "failure", "cancelled", null]) {
      test(`current repeated check: advance=${advance}, late=${late}, conclusion=${conclusion}`, async (t) => {
        const f = await fixture(t); const { targetHead } = successfulTarget(f, advance);
        const get = f.options.getCheckRuns; let reads = 0;
        f.options.getCheckRuns = async (repo, revision) => {
          const checks = await get(repo, revision);
          if (repo === f.selected.repository && revision === targetHead && ++reads > (late ? (advance ? 2 : 1) : 0)) {
            return [...checks, { ...checks[0], id: 903, conclusion,
              html_url: `https://github.com/${repo}/actions/runs/899/job/903` }];
          }
          return checks;
        };
        if (conclusion === "success" && !late) {
          assert.ok((await f.run()).current_verified.some((row) => row.revision === targetHead));
        } else {
          await assert.rejects(f.run(), /check|success|changed|execution/i);
        }
      });
    }
  }
}

test("skipped check on the same head is not competing admission evidence", async (t) => {
  const f = await fixture(t); const { targetHead } = successfulTarget(f, true);
  const get = f.options.getCheckRuns;
  f.options.getCheckRuns = async (repo, revision) => {
    const checks = await get(repo, revision);
    return repo === f.selected.repository && revision === targetHead
      ? [...checks, { ...checks[0], id: 1904, conclusion: "skipped",
        html_url: `https://github.com/${repo}/actions/runs/1900/job/1904` }] : checks;
  };
  const result = await f.run();
  assert.ok(result.current_verified.some((row) => row.revision === targetHead));
});

test("latest attempt replaces an earlier check from the same workflow run", async (t) => {
  const f = await fixture(t); const { targetHead } = successfulTarget(f, true);
  const get = f.options.getCheckRuns;
  f.options.getCheckRuns = async (repo, revision) => {
    const checks = await get(repo, revision);
    if (repo !== f.selected.repository || revision !== targetHead) return checks;
    const current = checks[0];
    return [{ ...current, id: current.id - 1, conclusion: "failure",
      html_url: current.html_url.replace(/\/job\/\d+$/u, `/job/${current.id - 1}`) }, current];
  };
  const result = await f.run();
  assert.ok(result.current_verified.some((row) => row.revision === targetHead));
});

for (const field of ["head_sha", "name", "app"]) {
  test(`different current check ${field} does not create context ambiguity`, async (t) => {
    const f = await fixture(t); const { targetHead } = successfulTarget(f, true);
    const get = f.options.getCheckRuns;
    f.options.getCheckRuns = async (repo, revision) => {
      const checks = await get(repo, revision);
      return repo === f.selected.repository && revision === targetHead
        ? [...checks, { ...checks[0], id: 1904, conclusion: "failure",
          [field]: field === "app" ? { id: 999 } : "unrelated" }] : checks;
    };
    const result = await f.run();
    assert.ok(result.current_verified.some((row) => row.revision === targetHead));
  });
}

test("historical recorded success remains valid despite a later failed check at that historical revision", async (t) => {
  const f = await fixture(t); const { original } = successfulTarget(f, true);
  const get = f.options.getCheckRuns;
  f.options.getCheckRuns = async (repo, revision) => {
    const checks = await get(repo, revision);
    return repo === original.repository && revision === original.observed_default_branch_evidence.revision
      ? [...checks, { ...checks[0], id: 1904, conclusion: "failure" }] : checks;
  };
  assert.equal((await f.run()).recovery_pending.length, 1);
});

async function bootstrapFixture(t) {
  const b = await firstBinding(t, 1);
  return { f: b.f, initial: b.prior, run: b.run };
}

test("ordinary bootstrap_pending first admission accepts a valid null-observation base without recovery", async (t) => {
  const { initial, run } = await bootstrapFixture(t);
  const result = await run();
  assert.equal(result.current_verified.length, 6);
  assert.equal(result.recovery_pending.length, 0);
  assert.ok(result.current_verified.some((r) => r.repository_id === initial.repository_id));
});

for (const kind of ["missing check", "failed check", "bound missing history", "partial bootstrap history", "wrong selected target", "moving target"]) {
  test(`first admission rejects ${kind}`, async (t) => {
    const { f, initial, run } = await bootstrapFixture(t);
    if (kind === "bound missing history") { initial.admission_status = "admitted"; initial.cohort_binding_status = "bound"; }
    if (kind === "partial bootstrap history") initial.observed_cohort_record_digest = "sha256:" + "0".repeat(64);
    if (kind === "wrong selected target") initial.desired_cohort_id = "docs-2026-09-08-stable15";
    if (kind === "moving target") {
      const get = f.options.getDefaultBranchHead;
      f.options.getDefaultBranchHead = async (repo) => repo === initial.repository ? "f".repeat(40) : get(repo);
    }
    if (["missing check", "failed check"].includes(kind)) {
      const get = f.options.getCheckRuns;
      f.options.getCheckRuns = async (repo, rev) => repo !== initial.repository ? get(repo, rev)
        : kind === "missing check" ? [] : (await get(repo, rev)).map((c) => ({ ...c, conclusion: "failure" }));
    }
    await assert.rejects(run(), /check|success|history|historical|selected target|default head/i);
  });
}


test("bootstrap accepts an explicitly null observed generation allowed by the schema", async (t) => {
  const { initial, run } = await bootstrapFixture(t);
  initial.observed_cohort_generation = null;
  const result = await run();
  assert.equal(result.current_verified.length, 6);
  assert.equal(result.recovery_pending.length, 0);
});

// Imported independent P1 regressions; synthetic API evidence, real validators.
async function firstBinding(t, generation = 2, schemaVersion = generation === 2 ? 3 : 2) {
  const f = await fixture(t);
  if (generation === 2) successfulTarget(f, true);
  const selected = generation === 2 ? f.selected : f.policy.repositories.find(r => r.repository.endsWith('/extension-foundation'));
  const basePolicy = structuredClone(f.policy);
  const prior = basePolicy.repositories.find(r => r.repository_id === selected.repository_id);
  prior.admission_status = 'admission_candidate'; prior.cohort_binding_status = 'bootstrap_pending';
  for (const key of ['observed_cohort_id', 'observed_cohort_record_digest', 'observed_cohort_event_digest',
    'exact_package_version', 'exact_foundation_version', 'reusable_workflow_revision', 'observed_default_branch_evidence']) prior[key] = null;
  delete prior.observed_cohort_generation; delete prior.exact_cohort_v2_packages;
  prior.qualification = { status: 'not_qualified', observed_revision: null, evidence_paths: [] };
  const read = async name => JSON.parse(await readAdmissionBaseFile(`governance/${name}.json`, base));
  const [policySchema, schema, exceptions, security] = await Promise.all(['docs-protocol-policy-v2.schema',
    'docs-qualified-cohorts.schema', 'docs-protocol-exceptions', 'code-security-defaults'].map(read));
  const validate = () => { for (const p of [basePolicy, f.policy]) {
    validateDocsProtocolPolicy(p, policySchema); validateDocsGovernanceReferences(f.registry, exceptions, p, security);
  } };
  validate();
  f.options.getDefaultBranchHead = async repo => f.policy.repositories.find(r => r.repository === repo).observed_default_branch_evidence.revision;
  const readConsumer = f.options.readRepositoryFile;
  f.options.readRepositoryFile = async (repo, path, revision) => {
    if (repo === selected.repository && path === "architecture/foundation/docs-consumer-integration.json") {
      assert.equal(revision, selected.observed_default_branch_evidence.revision);
      return encode({ schemaVersion });
    }
    return readConsumer(repo, path, revision);
  };
  let jobReads = 0;
  const jobs = f.options.getWorkflowJobs;
  f.options.getWorkflowJobs = async (repo, id, attempt) => {
    if (repo !== selected.repository) return jobs(repo, id, attempt);
    jobReads++;
    const evidence = selected.observed_default_branch_evidence;
    return ['trusted-authorize', 'trusted-structural', 'trusted-qualification', 'docs-protocol-check'].map((role, index) => {
      const jobId = role === 'docs-protocol-check' ? evidence.check_run_id : 901 + index;
      return { id: jobId, run_id: evidence.workflow_run_id, run_attempt: 1, head_sha: evidence.revision,
        name: `docs-protocol / ${role}`, status: 'completed', conclusion: 'success',
        html_url: `https://github.com/${repo}/actions/runs/${evidence.workflow_run_id}/job/${jobId}`,
        steps: successfulSteps(role, generation, schemaVersion) };
    });
  };
  return { f, selected, prior, basePolicy, validate, jobReads: () => jobReads,
    run: (changed_files) => verifyDocsAdmissionEvidence(f.policy, f.registry, schema,
      { ...f.options, basePolicy, ...(changed_files ? { recovery: { execution: { changed_files } } } : {}) }) };
}

test("policy admission checks changed consumer while direct fleet audit still catches collateral failure", async t => {
  const b = await firstBinding(t);
  b.f.options.fullFleetCurrent = false;
  const collateral = b.f.policy.repositories.find(row => row.repository === "agent-teams-ai/agent-teams-platform");
  const newHead = "e".repeat(40);
  const getHead = b.f.options.getDefaultBranchHead;
  const getChecks = b.f.options.getCheckRuns;
  b.f.options.getDefaultBranchHead = async repo => repo === collateral.repository ? newHead : getHead(repo);
  b.f.options.getCheckRuns = async (repo, revision) => repo === collateral.repository && revision === newHead
    ? [{ id: 999, head_sha: newHead, name: collateral.required_check_context,
      app: { id: collateral.observed_default_branch_evidence.integration_id }, conclusion: "failure",
      html_url: `https://github.com/${repo}/actions/runs/999/job/999` }]
    : getChecks(repo, revision);
  const result = await b.run([POLICY_PATH]);
  assert.deepEqual(result.current_verified.map(row => row.repository_id), [b.selected.repository_id]);
  assert.ok(result.current_not_evaluated.some(row => row.repository_id === collateral.repository_id));
  await assert.rejects(b.run(), /current default-branch head requires every decisive admitted check to succeed/u);
});

test("trusted policy-only PR scopes current checks after live controller validation", async t => {
  const f = await fixture(t);
  f.options.fullFleetCurrent = false;
  const result = await f.run();
  assert.deepEqual(result.current_verified.map(row => row.repository_id), [f.selected.repository_id]);
  assert.equal(result.current_not_evaluated.length, 5);
  assert.deepEqual(result.recovery_pending, []);
  assert.equal(f.controllerCalls(), 2);
});

test("checked-in unbound Platform authority leaves an unrelated policy-only PR scoped", async t => {
  const f = await fixture(t);
  f.options.fullFleetCurrent = false;
  const template = await readFile("governance/docs-platform-admission-recovery.json");
  assert.equal(JSON.parse(template).state, "unbound");
  let authorityBytes = template;
  const readBase = f.options.readBaseFile;
  f.options.readBaseFile = (path, revision) => path === "governance/docs-platform-admission-recovery.json"
    ? authorityBytes : readBase(path, revision);
  const platform = f.policy.repositories.find(row => row.repository_id === PLATFORM_RECOVERY.repository_id);
  const getHead = f.options.getDefaultBranchHead;
  const getChecks = f.options.getCheckRuns;
  f.options.getDefaultBranchHead = (repository, branch) => repository === platform.repository
    ? PLATFORM_RECOVERY.source_head : getHead(repository, branch);
  f.options.getCheckRuns = (repository, revision) => repository === platform.repository &&
    revision === PLATFORM_RECOVERY.source_head
    ? [{ id: 71, head_sha: revision, name: platform.observed_default_branch_evidence.required_context,
      app: { id: platform.observed_default_branch_evidence.integration_id }, conclusion: "failure",
      html_url: `https://github.com/${repository}/actions/runs/71/job/71` }]
    : getChecks(repository, revision);
  const report = await f.run();
  assert.deepEqual(report.current_verified.map(row => row.repository_id), [f.selected.repository_id]);
  assert.ok(report.current_not_evaluated.some(row => row.repository_id === platform.repository_id));
  assert.deepEqual(report.recovery_pending, []);
  assert.equal(f.controllerCalls(), 2);
  authorityBytes = encode({ ...JSON.parse(template), proof: { revision: "f".repeat(40) } });
  await assert.rejects(f.run(), /unbound authority is not the exact inert template/u);
  authorityBytes = encode({ ...JSON.parse(template), state: "retired" });
  await assert.rejects(f.run(), /malformed or unsupported state/u);
  for (const bytes of ["null", "[]", "42", "true", '"text"']) {
    authorityBytes = Buffer.from(bytes);
    await assert.rejects(f.run(), /base-owned Platform recovery authority must be an object/u);
  }
  authorityBytes = Buffer.from("{bad");
  await assert.rejects(f.run(), /base-owned Platform recovery authority/u);
});

test("expired active Platform authority audits the full healthy fleet without consuming recovery", async t => {
  const f = await fixture(t);
  f.options.fullFleetCurrent = false;
  const stamp = (offset) => new Date(Date.parse(f.options.asOf) + offset).toISOString().replace(/\.000Z$/u, "Z");
  const active = stagedSyntheticPlatformRecord({ valid_from: stamp(-60_000), expires_at: stamp(-1_000) });
  const readBase = f.options.readBaseFile;
  f.options.readBaseFile = (path, revision) => path === "governance/docs-platform-admission-recovery.json"
    ? encode(active) : readBase(path, revision);
  const getHead = f.options.getDefaultBranchHead;
  f.options.getDefaultBranchHead = (repository, branch) => repository === f.collateral.repository
    ? f.collateral.observed_default_branch_evidence.revision : getHead(repository, branch);
  const report = await f.run();
  assert.equal(report.current_verified.length, 6);
  assert.deepEqual(report.current_not_evaluated, []);
  assert.deepEqual(report.recovery_pending, []);
});

test("expired active Platform authority refuses incident recovery", async t => {
  const f = await fixture(t);
  const stamp = (offset) => new Date(Date.parse(f.options.asOf) + offset).toISOString().replace(/\.000Z$/u, "Z");
  const { state, platform } = installSyntheticPlatform(f,
    { valid_from: stamp(-60_000), expires_at: stamp(-1_000) }, { deadline: stamp(60_000) });
  const getChecks = f.options.getCheckRuns;
  let platformCheckReads = 0;
  f.options.getCheckRuns = (repository, revision) => {
    if (repository === platform.repository) platformCheckReads++;
    return getChecks(repository, revision);
  };
  await assert.rejects(f.run(), /I authority remains unbound or embeds its own base commit/u);
  assert.ok(platformCheckReads > 0);
  assert.equal(state.verifierCalls, 0);
});

test("active Platform authority still expands an unrelated policy-only PR to the remaining fleet", async t => {
  const f = await fixture(t);
  f.options.fullFleetCurrent = false;
  const stamp = (offset) => new Date(Date.parse(f.options.asOf) + offset).toISOString().replace(/\.000Z$/u, "Z");
  const active = stagedSyntheticPlatformRecord({ valid_from: stamp(-1_000), expires_at: stamp(60_000) });
  const readBase = f.options.readBaseFile;
  f.options.readBaseFile = (path, revision) => path === "governance/docs-platform-admission-recovery.json"
    ? encode(active) : readBase(path, revision);
  const getHead = f.options.getDefaultBranchHead;
  f.options.getDefaultBranchHead = (repository, branch) => repository === f.collateral.repository
    ? f.collateral.observed_default_branch_evidence.revision : getHead(repository, branch);
  const report = await f.run();
  assert.equal(report.current_verified.length, 6);
  assert.ok(report.current_verified.some(row => row.repository_id === PLATFORM_RECOVERY.repository_id));
  assert.deepEqual(report.current_not_evaluated, []);
  const unrelated = f.policy.repositories.find(row => row.repository === "agent-teams-ai/agent-runtime");
  const failedHead = "f".repeat(40);
  f.options.getDefaultBranchHead = (repository, branch) => repository === unrelated.repository
    ? failedHead : getHead(repository, branch);
  const getChecks = f.options.getCheckRuns;
  f.options.getCheckRuns = async (repository, revision) => repository === unrelated.repository &&
    revision === failedHead
    ? [{ ...((await getChecks(repository, unrelated.observed_default_branch_evidence.revision))[0]),
      head_sha: failedHead, conclusion: "failure" }]
    : getChecks(repository, revision);
  await assert.rejects(f.run(), /Admission recovery: uncovered failure or changed source head/u);
});

test("affected-row scope fails closed on global, nonconsumer and incomplete changes", async t => {
  const b = await firstBinding(t);
  const id = b.selected.repository_id;
  assert.deepEqual([...currentAdmissionScope(b.f.policy, b.basePolicy, [POLICY_PATH])], [id]);
  for (const changed of [undefined, [], [POLICY_PATH, "governance/docs-protocol-exceptions.json"]]) {
    assert.equal(currentAdmissionScope(b.f.policy, b.basePolicy, changed), null);
  }
  const global = structuredClone(b.f.policy);
  global.schema_version = 999;
  assert.equal(currentAdmissionScope(global, b.basePolicy, [POLICY_PATH]), null);
  const removed = structuredClone(b.f.policy);
  removed.repositories.pop();
  assert.equal(currentAdmissionScope(removed, b.basePolicy, [POLICY_PATH]), null);
});

for (const generation of [1, 2]) {
  test(`bootstrap positive generation ${generation}: six current successes and zero recovery pending`, async t => {
    const b = await firstBinding(t, generation); const result = await b.run();
    assert.equal(result.current_verified.length, 6); assert.equal(result.recovery_pending.length, 0);
    assert.ok(result.current_verified.some(r => r.repository_id === b.selected.repository_id));
    assert.ok(b.jobReads() > 0, "first admission must read target qualification and semantic jobs");
  });
}

const projectionNegatives = {
  'wrong package integrity': p => { Object.values(p.packages)[0].integrity = 'sha512-forged'; },
  'invented package version': p => { Object.values(p.packages)[0].version = '99.0.0'; },
  'wrong generation': p => { p.schemaVersion = 1; },
  'wrong repository': p => { p.repository.id = '999'; },
  'forged asset digest': p => { p.assets.callerWorkflowDigest = 'sha256:' + 'f'.repeat(64); },
  'wrong runtime': p => { p.runtime.node = '0.0.0'; },
};
for (const [label, mutate] of Object.entries(projectionNegatives)) {
  test(`REQUIRED bootstrap rejects ${label}`, async t => {
    const b = await firstBinding(t); const read = b.f.options.readRepositoryFile;
    b.f.options.readRepositoryFile = async (repo, path, rev) => {
      const bytes = await read(repo, path, rev);
      if (repo !== b.selected.repository || !path.endsWith('managed-state.json')) return bytes;
      const p = JSON.parse(bytes); mutate(p); return Buffer.from(JSON.stringify(p));
    };
    await assert.rejects(b.run(), /target|projection|Cohort|package|runtime/i);
  });
}
for (const mutation of ['missing jobs', 'failed qualification', 'skipped semantics', 'wrong runner', 'missing attempt']) {
  test(`REQUIRED bootstrap rejects ${mutation}`, async t => {
    const b = await firstBinding(t);
    if (['wrong runner','missing attempt'].includes(mutation)) {
      const get = b.f.options.getWorkflowRun;
      b.f.options.getWorkflowRun = async (repo, id) => {
        const run = await get(repo, id);
        if (repo === b.selected.repository) {
          if (mutation === 'wrong runner') run.referenced_workflows[0].sha = 'f'.repeat(40);
          else delete run.run_attempt;
        } return run;
      };
    } else {
      const get = b.f.options.getWorkflowJobs;
      b.f.options.getWorkflowJobs = async (repo, id, attempt) => {
        const jobs = await get(repo, id, attempt); if (repo !== b.selected.repository) return jobs;
        if (mutation === 'missing jobs') return [];
        if (mutation === 'failed qualification') jobs.find(j => j.name.endsWith('trusted-qualification')).conclusion = 'failure';
        else jobs.find(j => j.name.endsWith('docs-protocol-check')).steps.forEach(s => s.conclusion = 'skipped');
        return jobs;
      };
    }
    await assert.rejects(b.run(), /target|qualification|semantic|runner|attempt/i);
  });
}

for (const mode of ["selected-target", "final-observed", "first-binding-legacy", "first-binding-v2"]) {
  for (const mutation of ["missing", "wrong-generation", "failure", "cancelled", "skipped", "in-progress", "duplicate", "duplicate-skipped"]) {
    test(`executed qualification rejects ${mutation}: ${mode}`, async (t) => {
      const generation = mode === "first-binding-legacy" ? 1 : 2;
      const b = mode.startsWith("first-binding") ? await firstBinding(t, generation) : null;
      const f = b ? b.f : await fixture(t);
      if (!b) successfulTarget(f, mode === "final-observed");
      const selected = b ? b.selected : f.selected;
      const get = f.options.getWorkflowJobs;
      f.options.getWorkflowJobs = async (repo, id, attempt) => {
        const jobs = await get(repo, id, attempt);
        if (repo !== selected.repository) return jobs;
        const job = jobs.find((job) => job.name.endsWith("trusted-qualification"));
        const name = generation === 2 ? v2Qualification : legacyQualification;
        const executed = job.steps.find((step) => step.name === name);
        if (mutation === "missing") job.steps = job.steps.filter((step) => step !== executed);
        else if (mutation === "wrong-generation") {
          executed.conclusion = "skipped";
          job.steps = job.steps.filter((step) => step.name !== (generation === 2 ? legacyQualification : v2Qualification));
          job.steps.push({ name: generation === 2 ? legacyQualification : v2Qualification, status: "completed", conclusion: "success" });
        } else if (mutation.startsWith("duplicate")) {
          job.steps.push({ ...executed, conclusion: mutation === "duplicate" ? "success" : "skipped" });
        } else if (mutation === "in-progress") executed.status = "in_progress";
        else executed.conclusion = mutation;
        return jobs;
      };
      await assert.rejects(b ? b.run() : f.run(), /target qualification\/semantics did not actually execute successfully/u);
    });
  }
}

test("historical schema1 first binding accepts skipped qualification with successful controller and semantics", async t => {
  const b = await firstBinding(t, 1, 1);
  const result = await b.run();
  assert.equal(result.current_verified.length, 6);
  assert.equal(result.recovery_pending.length, 0);
});


test("supported pinned runners bind actual none, legacy, and cohort-v2 dispatch", async () => {
  const registry = JSON.parse(await readFile(REGISTRY_PATH));
  for (const id of ["docs-2026-08-31-stable10", "docs-2026-09-08-stable14", "docs-2026-09-08-stable15"]) {
    const record = registry.cohorts.find(row => row.cohort_id === id);
    const { path, revision, blob_sha: blob } = record.reusable_workflow;
    const bytes = await readAdmissionBaseFile(path, revision);
    assert.equal(recoveryBlob(bytes), blob);
    const steps = YAML.parse(bytes.toString()).jobs["trusted-qualification"].steps;
    const legacy = steps.filter(step => step.name === legacyQualification);
    assert.equal(legacy.length, 1);
    if (record.cohort_generation === 2) {
      assert.equal(legacy[0].if, "needs.trusted-authorize.outputs.qualification-profile == 'legacy'");
      assert.equal(steps.filter(step => step.name === v2Qualification).length, 1);
      assert.equal(steps.find(step => step.name === v2Qualification).if,
        "needs.trusted-authorize.outputs.qualification-profile == 'cohort-v2'");
      const authorization = (await readAdmissionBaseFile("scripts/verify-docs-consumer-gate.mjs", revision)).toString();
      assert.ok(authorization.includes('const qualificationProfile = v2 ? "cohort-v2" : profile.schemaVersion === 2 ? "legacy" : "none";'));
    } else {
      assert.equal(steps.filter(step => step.name === v2Qualification).length, 0);
      assert.equal(legacy[0].if, "steps.qualification.outputs.enabled == 'true'");
      const detector = steps.find(step => step.name === "Detect exact qualification contract version");
      assert.equal(detector.id, "qualification");
      assert.ok(detector.run.includes('integration.schemaVersion !== 1 && integration.schemaVersion !== 2'));
      assert.ok(detector.run.includes('integration.schemaVersion === 2 ? "true" : "false"'));
      assert.ok(detector.run.includes('/architecture/foundation/docs-consumer-integration.json'));
    }
    assert.equal(steps.filter(step => step.name === "Confirm current controller authority stayed stable through qualification").length, 1);
  }
});

for (const field of ["qualification", "controller", "semantic"]) {
  for (const mutation of ["missing", "failure", "cancelled", "in-progress", "duplicate", "wrong-branch"]) {
    test(`historical schema1 rejects ${mutation} ${field}`, async t => {
      const b = await firstBinding(t, 1, 1);
      const get = b.f.options.getWorkflowJobs;
      b.f.options.getWorkflowJobs = async (...args) => {
        const jobs = await get(...args);
        if (args[0] !== b.selected.repository) return jobs;
        const job = jobs.find(job => job.name.endsWith(field === "semantic" ? " / docs-protocol-check" : " / trusted-qualification"));
        const name = field === "qualification" ? legacyQualification : field === "controller"
          ? "Confirm current controller authority stayed stable through qualification" : "Run repository semantic documentation gate";
        const step = job.steps.find(step => step.name === name);
        if (mutation === "missing") job.steps = job.steps.filter(item => item !== step);
        else if (mutation === "duplicate") job.steps.push({ ...step });
        else if (mutation === "in-progress") step.status = "in_progress";
        else step.conclusion = mutation === "wrong-branch" ? (field === "qualification" ? "success" : "skipped") : mutation;
        return jobs;
      };
      await assert.rejects(b.run(), /target qualification\/semantics did not actually execute successfully/u);
    });
  }
}

for (const generation of [1, 2]) {
  for (const contract of [null, {}, { schemaVersion: 0 }, { schemaVersion: "1" }, { schemaVersion: generation === 2 ? 1 : 3 }]) {
    test(`immutable contract rejects invalid selector ${JSON.stringify(contract)} generation ${generation}`, async t => {
      const b = await firstBinding(t, generation);
      const read = b.f.options.readRepositoryFile;
      b.f.options.readRepositoryFile = async (repo, path, revision) => repo === b.selected.repository &&
        path === "architecture/foundation/docs-consumer-integration.json" ? encode(contract) : read(repo, path, revision);
      await assert.rejects(b.run());
    });
  }
}

for (const [generation, schemaVersion] of [[1, 1], [1, 2], [2, 3]]) {
  for (const mutation of ["success", "failure", "duplicate-skipped"]) {
    test(`unselected qualification rejects ${mutation} schema ${schemaVersion}`, async t => {
      const b = await firstBinding(t, generation, schemaVersion);
      const get = b.f.options.getWorkflowJobs;
      b.f.options.getWorkflowJobs = async (...args) => {
        const jobs = await get(...args);
        if (args[0] !== b.selected.repository) return jobs;
        const job = jobs.find(job => job.name.endsWith(" / trusted-qualification"));
        const name = generation === 2 ? legacyQualification : v2Qualification;
        job.steps = job.steps.filter(step => step.name !== name);
        job.steps.push({ name, status: "completed", conclusion: mutation === "duplicate-skipped" ? "skipped" : mutation });
        if (mutation === "duplicate-skipped") job.steps.push({ ...job.steps.at(-1) });
        return jobs;
      };
      await assert.rejects(b.run(), /target qualification\/semantics did not actually execute successfully/u);
    });
  }
}
