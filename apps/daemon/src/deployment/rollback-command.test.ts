import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { afterEach, expect, it } from "vitest";
import type { CommandHandlerInput } from "../http/http-contract.js";
import { closeStores, openStore, openRestartableStore, reopen, PROJECT_ID } from "../review/review-test-fixtures.js";
import { deploymentInfrastructureFiles } from "../repository/deployment/deployment-infrastructure-templates.js";
import { recordDeployReceipt, readDeployReceipt } from "./deploy-ledger.js";
import { createDockerDouble } from "./deploy-ports.js";
import { candidateContainerName } from "./deploy-service.js";
import { deployReceiptId } from "./deploy-receipt-contracts.js";
import { createRollbackCommandHandler } from "./rollback-command.js";

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

it.each([
  ["principal", "OPERATOR_PRINCIPAL_REQUIRED"], ["project", "DEPLOY_ROLLBACK_PROJECT_MISMATCH"],
  ["target", "DEPLOY_ROLLBACK_TARGET_INVALID"], ["version", "EXPECTED_VERSION_CONFLICT"],
  ["restore", "DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE"], ["extra", "DEPLOY_ROLLBACK_REQUEST_INVALID"],
  ["missing", "DEPLOY_ROLLBACK_REQUEST_INVALID"], ["receipt", "DEPLOY_ROLLBACK_RECEIPT_INVALID"],
  ["environment", "DEPLOY_ROLLBACK_RECEIPT_INVALID"],
])("refuses %s before Docker effects", async (mutation, code) => {
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
  await expect(h.handler({ envelope, principal })).rejects.toMatchObject({ code });
  expect(h.docker.calls).toEqual([]);
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

it("consumes the offered version before a distinct concurrent command can admit", async () => {
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
      .rejects.toMatchObject({ code: "EXPECTED_VERSION_CONFLICT" });
    expect(h.docker.calls).toEqual([]);
  } finally { release(); await first; }
  expect((await first).disposition).toBe("DECIDED");
});

it("recovers the receipt after restart if the final command write was interrupted", async () => {
  const restartable = openRestartableStore(), h = harness(restartable.store);
  const original = h.store.commitExpectedVersionDecision.bind(h.store);
  const interruptedStore = new Proxy(h.store, { get(target, property) {
    if (property === "commitExpectedVersionDecision") return (input: Parameters<typeof original>[0]) => {
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
