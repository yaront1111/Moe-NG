import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { afterEach, expect, it } from "vitest";
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
const environment = "staging", sha = "a".repeat(40), digest = `sha256:${"b".repeat(64)}`;
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
  if (mutation === "environment") payload["environment"] = "production";
  await expect(h.handler({ envelope, principal })).rejects.toMatchObject({ code, layer });
  expect(h.docker.calls).toEqual([]);
});

// DoD 3. THE MEASURED SHAPE OF THIS SEAM: there is no injectable backup port to
// record against. `RollbackCommandOptions = Omit<DeployCommandOptions, "buildContext">`
// carries none, and rollback-command.ts's only mention of BackupPorts is the
// comment at :86 explaining why the operation refuses. So "the not-requested path
// records no restore call" is asserted three ways, none of which trusts the flag:
// the request really ran, no injected port recorded a restore verb, and the module
// has no restore surface to call. The third is what distinguishes "port never
// called" from "port never wired" — here it is provably the latter.

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

it("binds no database restore surface at the rollback seam at all", () => {
  const source = rollbackCommandSource();
  // A call site, not the payload key `restoreDatabase` nor the explanatory comment.
  expect(source).not.toMatch(/\.restoreDatabase\s*\(/u);
  expect(source).not.toMatch(/from "[^"]*backups\//u);
  expect(source).not.toMatch(/nodeBackupPorts/u);
  // Non-vacuity: the file really was read and really is the module under test.
  expect(source).toMatch(/DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE/u);
});

it("refuses a requested database restore before reading the receipt or touching Docker", async () => {
  const h = harness();
  const envelope = { ...h.input.envelope, payload: { ...h.input.envelope.payload, restoreDatabase: true } };
  await expect(h.handler({ ...h.input, envelope })).rejects.toMatchObject({
    code: "DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE", layer: DAEMON_COMMAND_SEAM,
  });
  // rollback-command.ts:88 refuses AHEAD of readDeployReceipt, so nothing was
  // started and nothing durable was minted.
  expect(h.docker.calls).toEqual([]);
  expect(h.docker.sshCalls).toEqual([]);
  expect(readDeployReceipt(h.store, PROJECT_ID,
    deployReceiptId(PROJECT_ID, environment, h.input.envelope.commandId)).ok).toBe(false);
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
