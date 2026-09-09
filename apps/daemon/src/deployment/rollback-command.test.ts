import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { afterEach, expect, it } from "vitest";
import { backupFileHash } from "../backups/backup-ports.js";
import { setEnvironmentVariable } from "../environment/environment-store.js";
import { MIGRATION_RECEIPT_VERSION, migrationReceiptId, recordMigrationReceipt }
  from "../repository/migrations/migration-receipt.js";
import type { MigrationReceipt } from "../repository/migrations/migration-receipt.js";
import { DEPLOY_MIGRATION_DATABASE_VARIABLE } from "./deploy-migration-context.js";
import { ROLLBACK_RESTORE_DETAILS, ROLLBACK_RESTORE_STAMP } from "./rollback-restore.js";
import { DAEMON_COMMAND_SEAM } from "../http/http-async-contract.js";
import type { CommandHandlerInput } from "../http/http-contract.js";
import { closeStores, openStore, openRestartableStore, reopen, PROJECT_ID } from "../review/review-test-fixtures.js";
import { deploymentInfrastructureFiles } from "../repository/deployment/deployment-infrastructure-templates.js";
import { recordDeployReceipt, readDeployReceipt } from "./deploy-ledger.js";
import { createDockerDouble } from "./deploy-ports.js";
import { candidateContainerName } from "./deploy-service.js";
import { deployReceiptId } from "./deploy-receipt-contracts.js";
import { createRollbackCommandHandler } from "./rollback-command.js";
import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";

afterEach(closeStores);
const clock = () => "2026-09-06T01:00:00.000Z";
// "production", not "staging": `ENVIRONMENT_NAMES` (environment-contracts.ts:29) is CLOSED to
// {preview, production, verify}, so only those three can ever carry a bound restore
// destination. A suite pinned to "staging" could seed no destination at all and every bound
// arm below would have proved the unbound path twice under two different names.
const environment = "production", sha = "a".repeat(40), digest = `sha256:${"b".repeat(64)}`;
function harness(store = openStore()) {
  const source = recordDeployReceipt(store, { projectId: PROJECT_ID, environment, sha,
    imageDigest: digest, decisionId: "original", decidedAt: clock(), refusal: null, releaseDecision: null, url: null });
  if (!source.ok) throw new Error(source.code);
  const docker = createDockerDouble({ proxyConfig: deploymentInfrastructureFiles("", []).get("docker/Caddyfile") ?? "",
    running: { app: "HEALTHY" }, imageDigest: digest,
    health: { [candidateContainerName(environment, sha, "rollback-command-1")]: ["HEALTHY"] } });
  const options = { operatorPrincipalId: "operator", projectId: PROJECT_ID, store, clock,
    healthBudgetMs: 1, pollMs: 1, sleep: async () => {},
    ports: { build: docker.build, docker: docker.docker, ssh: docker.ssh, transfer: docker.transfer,
      target: () => ({ network: "product", sshTarget: null, url: null }), releaseDecision: () => null } };
  const input: CommandHandlerInput = { principal: { principalId: "operator", projectId: PROJECT_ID, capabilities: ["goal.write"] },
    envelope: { commandId: "rollback-command-1", commandKind: "deployment.rollback", correlationId: "rollback-test",
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, expectedVersion: store.getAggregateVersion(PROJECT_ID),
      targetAggregateId: PROJECT_ID, requestDigest: "c".repeat(64), sessionCredential: "test-credential",
      payload: { environment, toReceiptRef: source.receipt.receiptId, restoreDatabase: false } } };
  return { docker, store, options, input, handler: createRollbackCommandHandler(options) };
}

it("returns a durable receipt-backed decision and replays after handler recreation", async () => {
  const h = harness();
  const decision = await h.handler(h.input);
  expect(decision.disposition).toBe("DECIDED");
  expect(decision.effectId).not.toBeNull();
  const receipt = readDeployReceipt(h.store, PROJECT_ID, deployReceiptId(PROJECT_ID, environment, h.input.envelope.commandId));
  expect(receipt.ok && receipt.receipt.imageDigest).toBe(digest);
  const count = h.docker.calls.length;
  expect(await createRollbackCommandHandler(h.options)(h.input)).toEqual({ ...decision, disposition: "REPLAYED" });
  expect(h.docker.calls).toHaveLength(count);
});

// Each row pins the LAYER as well as the code: more than one layer can refuse
// this handler, and a code that migrated between layers would otherwise keep a
// code-only assertion green. `OPERATOR_PRINCIPAL_REQUIRED` proves the column is
// load-bearing — it is stamped DAEMON_AUTHORIZATION at rollback-command.ts:69,
// not DAEMON_COMMAND_SEAM like the rest.
it.each([
  ["principal", "OPERATOR_PRINCIPAL_REQUIRED", "DAEMON_AUTHORIZATION"],
  ["project", "DEPLOY_ROLLBACK_PROJECT_MISMATCH", DAEMON_COMMAND_SEAM],
  ["target", "DEPLOY_ROLLBACK_TARGET_INVALID", DAEMON_COMMAND_SEAM],
  ["version", "EXPECTED_VERSION_CONFLICT", DAEMON_COMMAND_SEAM],
  ["restore", "DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE", DAEMON_COMMAND_SEAM],
  ["extra", "DEPLOY_ROLLBACK_REQUEST_INVALID", DAEMON_COMMAND_SEAM],
  ["missing", "DEPLOY_ROLLBACK_REQUEST_INVALID", DAEMON_COMMAND_SEAM],
  ["receipt", "DEPLOY_ROLLBACK_RECEIPT_INVALID", DAEMON_COMMAND_SEAM],
  ["environment", "DEPLOY_ROLLBACK_RECEIPT_INVALID", DAEMON_COMMAND_SEAM],
])("refuses %s before Docker effects", async (mutation, code, layer) => {
  const h = harness();
  const payload = { ...h.input.envelope.payload };
  let envelope = { ...h.input.envelope, payload }, principal = { ...h.input.principal };
  if (mutation === "principal") principal.principalId = "agent";
  if (mutation === "project") principal.projectId = "another-project";
  if (mutation === "target") envelope.targetAggregateId = "another-project";
  if (mutation === "version") envelope.expectedVersion += 1;
  if (mutation === "restore") payload["restoreDatabase"] = true;
  if (mutation === "extra") payload["buildContext"] = "/tmp";
  if (mutation === "missing") delete payload["restoreDatabase"];
  if (mutation === "receipt") payload["toReceiptRef"] = "f".repeat(64);
  if (mutation === "environment") payload["environment"] = "staging";
  await expect(h.handler({ envelope, principal })).rejects.toMatchObject({ code, layer });
  expect(h.docker.calls).toEqual([]);
});

// DoD 2/3. THE SEAM NOW HAS A REAL RESTORE PORT, so "the not-requested path records
// no restore call" is finally FALSIFIABLE rather than merely unfalsified: `boundHarness`
// injects a `restoreDatabaseInto` double that appends to `calls`, and the not-requested
// arm asserts that list is EMPTY. Before this row there was no injectable port at all
// (see `mem:gotcha-asserting-a-port-was-not-called-when-no-port-is-wired`), which is why
// the older form of these arms had to prove the ABSENCE of the surface instead.
//
// Three independent assertions still stand behind the claim, none trusting the flag:
// the request really ran (DECIDED + a minted receipt carrying the digest), no injected
// port recorded a restore — neither the backup port nor a restore verb on any docker or
// ssh argv — and the module binds the surface it is supposed to bind and no other.

/** Every verb that would move database bytes back into a live destination. */
const RESTORE_VERBS: readonly string[] = ["pg_restore", "psql", "mysql", "mongorestore", "restore", "pg_dump"];
const rollbackCommandSource = (): string =>
  readFileSync(fileURLToPath(new URL("./rollback-command.ts", import.meta.url)), "utf8");

it("restores no database when the operator did not request one", async () => {
  const h = harness();
  expect(h.input.envelope.payload["restoreDatabase"]).toBe(false);
  const decision = await h.handler(h.input);
  // Asserted FIRST: an arm that silently ran no rollback would satisfy every
  // "nothing happened" clause below for the wrong reason.
  expect(decision.disposition).toBe("DECIDED");
  const receipt = readDeployReceipt(h.store, PROJECT_ID, deployReceiptId(PROJECT_ID, environment, h.input.envelope.commandId));
  expect(receipt.ok && receipt.receipt.imageDigest).toBe(digest);

  // READ THE RECORDED CALLS, never the flag: sweep every argv the injected ports saw.
  expect(h.docker.calls.length).toBeGreaterThan(0);
  const swept = [...h.docker.calls, ...h.docker.sshCalls].flatMap(argv => [...argv]);
  expect(swept.filter(token => RESTORE_VERBS.includes(token))).toEqual([]);
});

it("binds the DESTINATION-BOUND restore surface across the seam and its binding, and only that one", () => {
  // THE SEAM SUPPLIES THE PORT; THE BINDING CALLS IT. Asserting the call site on the command
  // alone would red for the wrong reason, and asserting it on the binding alone would leave the
  // production default (`nodeBackupPorts()`) unpinned -- a seam that only ever received an
  // injected double would pass every offline arm while no real dispatch could restore anything.
  const command = rollbackCommandSource();
  expect(command).toMatch(/from "[^"]*backups\/backup-ports\.js"/u);
  expect(command).toMatch(/nodeBackupPorts\s*\(\)/u);
  // BOTH HALVES, SEPARATELY, because the command now calls them at two different points in its
  // lifecycle with a durable commit in between. A pin on the composition alone would be satisfied
  // by a handler that had gone back to doing both at once.
  expect(command).toMatch(/resolveRollbackRestore\s*\(/u);
  expect(command).toMatch(/applyResolvedRestore\s*\(/u);
  // AND THE COMPOSITION IS NOT CALLED HERE. Without this negative, a dead `applyRollbackRestore`
  // left beside the two halves would keep the pins above green while the effect happened at the
  // pre-admission position again.
  expect(command).not.toMatch(/applyRollbackRestore\s*\(/u);

  const binding = readFileSync(fileURLToPath(new URL("./rollback-restore.ts", import.meta.url)), "utf8");
  expect(binding).toMatch(/\.restoreDatabaseInto\s*\(/u);

  // AND ONLY THAT ONE, on BOTH files. `restoreDatabase(path)` verifies a dump inside a throwaway
  // `--network none` container and writes to no database anyone named, so a caller of it would
  // report a rollback as restored while the production schema never moved. Anchored on a CALL,
  // which the `restoreDatabaseInto` call site above cannot satisfy.
  expect(command).not.toMatch(/\.restoreDatabase\s*\(/u);
  expect(binding).not.toMatch(/\.restoreDatabase\s*\(/u);
  // Non-vacuity: both files really were read and really are the modules under test.
  expect(command).toMatch(/createRollbackCommandHandler/u);
  expect(binding).toMatch(/DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE/u);
});

it("refuses a requested restore on an UNWIRED daemon, before Docker and before any durable write", async () => {
  // This daemon has no environment credential at all, so no environment on it has a bound
  // destination. The refusal, its code and its LAYER are unchanged from before this row --
  // what changed is that the case is now the UNBOUND one rather than every restore.
  const h = harness();
  const envelope = { ...h.input.envelope, payload: { ...h.input.envelope.payload, restoreDatabase: true } };
  await expect(h.handler({ ...h.input, envelope })).rejects.toMatchObject({
    code: "DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE", layer: DAEMON_COMMAND_SEAM,
  });
  // The seam refuses AHEAD of the environment guard reservation and of the rollback effect, so
  // nothing was started and nothing durable was minted.
  expect(h.docker.calls).toEqual([]);
  expect(h.docker.sshCalls).toEqual([]);
  expect(readDeployReceipt(h.store, PROJECT_ID,
    deployReceiptId(PROJECT_ID, environment, h.input.envelope.commandId)).ok).toBe(false);
});

/**
 * A BOUND ENVIRONMENT, assembled the way production assembles one (DoD 1, 2, 3).
 *
 * The CURRENT deploy is a SECOND receipt, distinct from the one the rollback targets, and its
 * migration receipt names the dump to restore. That separation is the point: an arm where the
 * current and the kept receipt are the same row cannot tell the correct dump from the one that
 * rewinds a migration too far.
 */
const CREDENTIAL = "rollback-command-environment-credential";
/** Credential-shaped ON PURPOSE, so a leak into any surface would be findable. */
const DATABASE_URL = "postgres://app:r0llback-s3cr3t@db.internal:5432/app";
const CURRENT_DECISION = "current-deploy";
const CURRENT_SHA = "d".repeat(40);
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) continue;
    try { rmSync(root, { force: true, recursive: true }); }
    catch { /* a held handle on Windows must not mask a test failure */ }
  }
});

async function boundHarness(options: { readonly bind?: boolean; readonly fail?: boolean } = {}) {
  const h = harness();
  const root = mkdtempSync(join(tmpdir(), "moe-rollback-command-"));
  roots.push(root);
  const dump = join(root, "pre-migration.sql");
  writeFileSync(dump, "-- the schema the kept deploy ran against\nCREATE TABLE kept();\n");
  const current = recordDeployReceipt(h.store, { projectId: PROJECT_ID, environment, sha: CURRENT_SHA,
    imageDigest: `sha256:${"e".repeat(64)}`, decisionId: CURRENT_DECISION, decidedAt: clock(),
    refusal: null, releaseDecision: null, url: null });
  expect(current).toMatchObject({ ok: true });
  const receipt: MigrationReceipt = {
    applied: ["1700000000002_current.js"], backupRef: `${dump}@sha256:${await backupFileHash(dump)}`,
    decidedAt: clock(), environment, outcome: "APPLIED", projectId: PROJECT_ID,
    receiptId: migrationReceiptId(PROJECT_ID, CURRENT_DECISION), refusal: null,
    requestId: CURRENT_DECISION, sha: CURRENT_SHA, version: MIGRATION_RECEIPT_VERSION,
  };
  recordMigrationReceipt(h.store, receipt);
  const credential = (): string => CREDENTIAL;
  if (options.bind !== false) {
    // A silently refused seed would make every later assertion vacuous.
    expect(setEnvironmentVariable({ credential, now: clock, projectId: PROJECT_ID, store: h.store },
      { environment, name: DEPLOY_MIGRATION_DATABASE_VARIABLE, value: DATABASE_URL })).toMatchObject({ ok: true });
  }
  const calls: { connection: string; path: string }[] = [];
  const bound = { ...h.options, environmentCredential: credential, migrationWorkspace: root,
    backupPorts: { restoreDatabaseInto: async (connection: string, path: string): Promise<void> => {
      calls.push({ connection, path });
      // The real port collapses every thrown message to `BACKUP_FAILED`; the double mirrors it.
      if (options.fail === true) throw new Error("BACKUP_FAILED");
    } } };
  const envelopeFor = (restore: boolean): CommandHandlerInput["envelope"] => ({ ...h.input.envelope,
    expectedVersion: h.store.getAggregateVersion(PROJECT_ID),
    payload: { ...h.input.envelope.payload, restoreDatabase: restore } });
  return { ...h, calls, dump, envelopeFor, handler: createRollbackCommandHandler(bound) };
}

it("(a) applies the CURRENT deploy's recorded dump to the resolved destination, exactly once", async () => {
  const b = await boundHarness();

  const decision = await b.handler({ ...b.input, envelope: b.envelopeFor(true) });

  // The rollback really ran: without this every "it was applied" clause below could be satisfied
  // by a command that refused for an unrelated reason and never reached the restore at all.
  expect(decision.disposition).toBe("DECIDED");
  // READ THE PORT'S RECORDED CALLS. Once, with the dump the CURRENT deploy's migration recorded
  // and the destination the environment credential seam resolved -- neither taken from the payload.
  expect(b.calls).toHaveLength(1);
  expect(b.calls[0]?.path).toBe(b.dump);
  expect(b.calls[0]?.connection).toBe(DATABASE_URL);
});

it("(b) records ZERO calls on the restore port when the operator did not request one", async () => {
  const b = await boundHarness();
  const envelope = b.envelopeFor(false);
  expect(envelope.payload["restoreDatabase"]).toBe(false);

  const decision = await b.handler({ ...b.input, envelope });

  // The command really ran -- otherwise "no restore happened" is true for the wrong reason.
  expect(decision.disposition).toBe("DECIDED");
  expect(b.docker.calls.length).toBeGreaterThan(0);
  // THE EMPTY LIST IS THE ASSERTION, on a port that is wired, bound and demonstrably callable in
  // arm (a) above. Not "nothing failed", not "no error was thrown": no invocation was recorded,
  // and not a no-op one with a null argument either.
  expect(b.calls).toEqual([]);
});

it("(c) still refuses UNAVAILABLE with code and layer when the bound environment has no database", async () => {
  const b = await boundHarness({ bind: false });

  await expect(b.handler({ ...b.input, envelope: b.envelopeFor(true) })).rejects.toMatchObject({
    code: "DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE", layer: DAEMON_COMMAND_SEAM,
  });
  // Zero calls, and no rollback receipt: the schema and the deployment are both untouched.
  expect(b.calls).toEqual([]);
  expect(b.docker.calls).toEqual([]);
  expect(readDeployReceipt(b.store, PROJECT_ID,
    deployReceiptId(PROJECT_ID, environment, b.input.envelope.commandId)).ok).toBe(false);
});

it("(d) a FAILING restore refuses with code and layer, attempts once, and RELEASES the environment", async () => {
  const b = await boundHarness({ fail: true });
  const first = b.input.envelope.commandId;

  await expect(b.handler({ ...b.input, envelope: b.envelopeFor(true) })).rejects.toMatchObject({
    code: "DEPLOY_ROLLBACK_RESTORE_FAILED", detail: ROLLBACK_RESTORE_DETAILS.DEPLOY_ROLLBACK_RESTORE_FAILED,
    layer: ROLLBACK_RESTORE_STAMP,
  });
  // NO AUTOMATIC RETRY. Invisible to an arm that only checks the outcome: a handler that retried
  // three times and then refused would satisfy every other assertion here.
  expect(b.calls).toHaveLength(1);
  // AND NOTHING ELSE MOVED. The apply now sits INSIDE the reserved guard, so "nothing reserved" is
  // no longer true and is no longer claimed: what holds is that the deployment was never touched
  // and that the guard did not stay held. The refusal is recorded as a REFUSED TERMINAL decision
  // with NO deploy receipt -- a receipt would have to be bucketed into the engine's closed refusal
  // roster and would then stand as this environment's CURRENT deploy.
  expect(b.docker.calls).toEqual([]);
  expect(b.docker.sshCalls).toEqual([]);
  expect(readDeployReceipt(b.store, PROJECT_ID, deployReceiptId(PROJECT_ID, environment, first)).ok).toBe(false);

  // THE SAME COMMAND ID ANSWERS FROM THE RECORD, not by trying again. Without this a replay would
  // either apply a second dump or report RECEIPT_INVALID for a decision that is perfectly valid.
  await expect(b.handler({ ...b.input, envelope: b.envelopeFor(true) })).rejects.toMatchObject({
    code: "DEPLOY_ROLLBACK_RESTORE_FAILED", layer: ROLLBACK_RESTORE_STAMP,
  });
  expect(b.calls).toHaveLength(1);

  // A FRESH COMMAND ID IS ADMITTED, which is the only proof the guard was really released: it
  // reaches the port a SECOND time and refuses again because this fixture fails every attempt.
  const second = "second-rollback-after-failed-restore";
  await expect(b.handler({ ...b.input, envelope: { ...b.envelopeFor(true), commandId: second } }))
    .rejects.toMatchObject({ code: "DEPLOY_ROLLBACK_RESTORE_FAILED", layer: ROLLBACK_RESTORE_STAMP });
  expect(b.calls).toHaveLength(2);
  expect(b.docker.calls).toEqual([]);
  // NEITHER id minted a deploy receipt.
  expect(readDeployReceipt(b.store, PROJECT_ID, deployReceiptId(PROJECT_ID, environment, first)).ok).toBe(false);
  expect(readDeployReceipt(b.store, PROJECT_ID, deployReceiptId(PROJECT_ID, environment, second)).ok).toBe(false);
});

it("refuses changed receipt bytes under an already decided command id", async () => {
  const h = harness();
  await h.handler(h.input);
  const count = h.docker.calls.length;
  await expect(h.handler({ ...h.input, envelope: { ...h.input.envelope,
    payload: { ...h.input.envelope.payload, toReceiptRef: "f".repeat(64) } } })).rejects.toMatchObject({ code: "DEPLOY_ROLLBACK_COMMAND_BYTES_CONFLICT" });
  expect(h.docker.calls).toHaveLength(count);
});

it("refuses a second invocation while durable intent has no engine receipt", async () => {
  const h = harness();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const handler = createRollbackCommandHandler({ ...h.options, ports: { ...h.options.ports,
    docker: async (args, stdin) => { entered(); await barrier; return h.docker.docker(args, stdin); } } });
  const first = handler(h.input);
  try {
    await started;
    await expect(createRollbackCommandHandler(h.options)(h.input)).rejects.toMatchObject({ code: "DEPLOY_ROLLBACK_IN_PROGRESS" });
  } finally { release(); await first; }
  expect((await first).disposition).toBe("DECIDED");
});

it("replays engine refusal without converting it to command success", async () => {
  const h = harness();
  const handler = createRollbackCommandHandler({ ...h.options, ports: { ...h.options.ports,
    docker: async () => ({ code: 1, stderr: "docker unavailable", stdout: "" }) } });
  await expect(handler(h.input)).rejects.toMatchObject({ code: "DEPLOY_DOCKER_UNAVAILABLE" });
  await expect(createRollbackCommandHandler(h.options)(h.input)).rejects.toMatchObject({ code: "DEPLOY_DOCKER_UNAVAILABLE" });
  expect(h.docker.calls).toEqual([]);
});

it("reserves the environment before a distinct concurrent command can admit", async () => {
  const h = harness();
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const handler = createRollbackCommandHandler({ ...h.options, ports: { ...h.options.ports,
    docker: async (args, stdin) => { entered(); await barrier; return h.docker.docker(args, stdin); } } });
  const first = handler(h.input);
  try {
    await started;
    await expect(h.handler({ ...h.input, envelope: { ...h.input.envelope, commandId: "concurrent-rollback" } }))
      .rejects.toMatchObject({ code: "DEPLOY_ROLLBACK_IN_PROGRESS" });
    expect(h.docker.calls).toEqual([]);
  } finally { release(); await first; }
  expect((await first).disposition).toBe("DECIDED");
});

it("recovers the receipt after restart if the final command write was interrupted", async () => {
  const restartable = openRestartableStore(), h = harness(restartable.store);
  const original = h.store.commitExpectedVersionDecisionLegs.bind(h.store);
  const interruptedStore = new Proxy(h.store, { get(target, property) {
    if (property === "commitExpectedVersionDecisionLegs") return (input: Parameters<typeof original>[0]) => {
      if (input.commandKind === "deployment.rollback") throw new Error("injected final write interruption");
      return original(input);
    };
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await expect(createRollbackCommandHandler({ ...h.options, store: interruptedStore })(h.input))
    .rejects.toThrow("injected final write interruption");
  const count = h.docker.calls.length;
  const replay = await createRollbackCommandHandler({ ...h.options, store: reopen(restartable) })(h.input);
  expect(replay.disposition).toBe("REPLAYED");
  expect(h.docker.calls).toHaveLength(count);
});

it("keeps uncertain intent closed across a store restart", async () => {
  const restartable = openRestartableStore(), h = harness(restartable.store);
  const handler = createRollbackCommandHandler({ ...h.options, ports: { ...h.options.ports,
    target: () => { throw new Error("injected target interruption"); } } });
  await expect(handler(h.input)).rejects.toThrow("injected target interruption");
  await expect(createRollbackCommandHandler({ ...h.options, store: reopen(restartable) })(h.input))
    .rejects.toMatchObject({ code: "DEPLOY_ROLLBACK_IN_PROGRESS" });
  expect(h.docker.calls).toEqual([]);
});

function projectWrite(store: ReturnType<typeof openStore>, commandId: string): void {
  const payload = new TextEncoder().encode(JSON.stringify({ projectId: PROJECT_ID, marker: commandId }));
  store.commitExpectedVersionDecision({ commandKind: "test.project-write", committedResultBytes: payload,
    correlationId: commandId, decidedAt: clock(), key: { projectId: PROJECT_ID, principalId: "test", commandId },
    requestBytes: payload, targetAggregateId: PROJECT_ID, expectedVersion: store.getAggregateVersion(PROJECT_ID),
    events: [{ eventId: commandId, eventType: "TestProjectWritten", payload }] });
}

it("keeps project state and both versions unchanged through private rollback admission and completion", async () => {
  const store = openStore();
  projectWrite(store, "project-before-rollback");
  const before = readDurableLedger(store, PROJECT_ID).aggregates.get(PROJECT_ID);
  const h = harness(store);
  const handler = createRollbackCommandHandler({ ...h.options, ports: { ...h.options.ports,
    docker: async (args, stdin) => {
      expect(store.getAggregateVersion(PROJECT_ID)).toBe(before?.currentVersion);
      expect(readDurableLedger(store, PROJECT_ID).aggregates.get(PROJECT_ID)).toEqual(before);
      return h.docker.docker(args, stdin);
    } } });
  await handler(h.input);
  expect(store.getAggregateVersion(PROJECT_ID)).toBe(before?.currentVersion);
  expect(readDurableLedger(store, PROJECT_ID).aggregates.get(PROJECT_ID)).toEqual(before);
});

it("completes and replays when an unrelated project writer wins immediately before terminal commit", async () => {
  const restartable = openRestartableStore(), h = harness(restartable.store);
  let raced = false;
  const racedStore = new Proxy(h.store, { get(target, property) {
    const value: unknown = Reflect.get(target, property, target);
    if ((property === "commitExpectedVersionDecision" || property === "commitExpectedVersionDecisionLegs")
      && typeof value === "function") return (input: { commandKind: string }) => {
      if (input.commandKind === "deployment.rollback" && !raced) {
        raced = true;
        projectWrite(h.store, "unrelated-project-writer");
      }
      return value.call(target, input);
    };
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const decided = await createRollbackCommandHandler({ ...h.options, store: racedStore })(h.input);
  expect(raced).toBe(true);
  expect(decided.disposition).toBe("DECIDED");
  const calls = h.docker.calls.length;
  const reopened = reopen(restartable);
  expect(await createRollbackCommandHandler({ ...h.options, store: reopened })(h.input))
    .toEqual({ ...decided, disposition: "REPLAYED" });
  expect(h.docker.calls).toHaveLength(calls);
  expect(readDurableLedger(reopened, PROJECT_ID).aggregates.get(PROJECT_ID)?.result)
    .toEqual({ projectId: PROJECT_ID, marker: "unrelated-project-writer" });
});

it("holds the environment against a distinct command after uncertain execution and restart", async () => {
  const restartable = openRestartableStore(), h = harness(restartable.store);
  const handler = createRollbackCommandHandler({ ...h.options, ports: { ...h.options.ports,
    target: () => { throw new Error("injected target interruption"); } } });
  await expect(handler(h.input)).rejects.toThrow("injected target interruption");
  const reopened = reopen(restartable);
  await expect(createRollbackCommandHandler({ ...h.options, store: reopened })({ ...h.input,
    envelope: { ...h.input.envelope, expectedVersion: reopened.getAggregateVersion(PROJECT_ID),
      commandId: "different-command-after-crash" } })).rejects.toMatchObject({ code: "DEPLOY_ROLLBACK_IN_PROGRESS" });
  expect(h.docker.calls).toEqual([]);
});

it("releases the environment after a receipt-backed refusal so a fresh command can be admitted", async () => {
  const h = harness();
  let calls = 0;
  const handler = createRollbackCommandHandler({ ...h.options, ports: { ...h.options.ports,
    docker: async () => { calls += 1; return { code: 1, stderr: "docker unavailable", stdout: "" }; } } });
  await expect(handler(h.input)).rejects.toMatchObject({ code: "DEPLOY_DOCKER_UNAVAILABLE" });
  const afterFirst = calls;
  await expect(handler({ ...h.input, envelope: { ...h.input.envelope, commandId: "next-rollback" } }))
    .rejects.toMatchObject({ code: "DEPLOY_DOCKER_UNAVAILABLE" });
  expect(calls).toBeGreaterThan(afterFirst);
  const afterSecond = calls;
  await expect(handler(h.input)).rejects.toMatchObject({ code: "DEPLOY_DOCKER_UNAVAILABLE" });
  expect(calls).toBe(afterSecond);
});
