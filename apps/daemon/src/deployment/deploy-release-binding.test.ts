import { afterEach, expect, it, vi } from "vitest";
import type { SqliteEventStore } from "@moe/store";
import { closeStores, driveThrough, envelope, GOAL_ID, openStore, PROJECT_ID, send }
  from "../bootstrap/bootstrap-test-fixtures.js";
import type { CommandHandlerInput } from "../http/http-contract.js";
import { recordReleaseReceipt } from "../release/release-receipt-ledger.js";
import { CONTROLLED_PROFILE_VERSION } from "../repository/controlled-profile/controlled-profile-generator.js";
import { deploymentInfrastructureFiles } from "../repository/deployment/deployment-infrastructure-templates.js";
import { createDeployCommandHandler } from "./deploy-command.js";
import { readCurrentDeployReceipt } from "./deploy-ledger.js";
import { createDockerDouble } from "./deploy-ports.js";
import { candidateContainerName } from "./deploy-service.js";

// Production command/receipt composition stays intact; no test may spawn a host effect.
const effects = vi.hoisted(() => ({ build: vi.fn(), docker: vi.fn(), ssh: vi.fn(), transfer: vi.fn() }));
vi.mock("./deploy-ports.js", async (original) => ({
  ...await original<typeof import("./deploy-ports.js")>(),
  nodeDockerRunner: effects.docker, nodeSshRunner: effects.ssh, nodeImageTransfer: effects.transfer,
}));
vi.mock("./deploy-image-build.js", async (original) => ({
  ...await original<typeof import("./deploy-image-build.js")>(), nodeDeployBuild: effects.build,
}));
afterEach(() => { closeStores(); vi.clearAllMocks(); });

const NOW = "2026-09-06T12:00:00.000Z";
const SHA = "a".repeat(40);
const COMMAND_ID = "deploy-with-release";

function world() {
  const store = openStore(); driveThrough(store, "goal.close");
  expect(send(store, envelope("deployment.set_target", 0, { environment: "production", network: "moe-release",
    sshTarget: null, url: "https://product.example.test" })).ok).toBe(true);
  const docker = createDockerDouble({
    proxyConfig: deploymentInfrastructureFiles(CONTROLLED_PROFILE_VERSION, []).get("docker/Caddyfile")!,
    health: { [candidateContainerName("production", SHA, COMMAND_ID)]: ["HEALTHY"] },
  });
  effects.build.mockImplementation(docker.build); effects.docker.mockImplementation(docker.docker);
  effects.ssh.mockImplementation(docker.ssh); effects.transfer.mockImplementation(docker.transfer);
  const input: CommandHandlerInput = { principal: { principalId: "principal-1", projectId: PROJECT_ID, capabilities: [] },
    envelope: { commandId: COMMAND_ID, commandKind: "deployment.deploy", correlationId: "release-binding",
      targetAggregateId: `deploy:${GOAL_ID}`, expectedVersion: 0, payload: { environment: "production", sha: SHA },
      requestDigest: "d".repeat(64), schemaVersion: "moe-runtime-command/1", sessionCredential: "test-session" } };
  const deploy = (source: SqliteEventStore = store) => createDeployCommandHandler({
    store: source, operatorPrincipalId: "principal-1", projectId: PROJECT_ID, buildContext: "/workspace/product",
    clock: () => NOW,
  })(input);
  return { store, deploy };
}

function release(store: SqliteEventStore, goalId = GOAL_ID, sha = SHA, refused = false) {
  const result = recordReleaseReceipt(store, { projectId: PROJECT_ID, goalId, sha, decidedAt: NOW,
    dossierSha256: "d".repeat(64), outcome: refused ? "REFUSED" : "RELEASED",
    refusalCode: refused ? "RELEASE_EVIDENCE_INCOMPLETE" : null,
    prUrl: refused ? null : "https://github.com/example/product/pull/1" });
  if (!result.ok) throw new Error(result.code);
  return result.receipt.receiptId;
}

it("production deploy receipts cite the release for the exact goal and SHA", async () => {
  const fixture = world(); const receiptId = release(fixture.store);
  await fixture.deploy();
  expect(readCurrentDeployReceipt(fixture.store, PROJECT_ID, "production"))
    .toMatchObject({ outcome: "DEPLOYED", sha: SHA, releaseDecision: receiptId });
  expect(effects.build).toHaveBeenCalledOnce();
});

it.each(["missing", "other goal", "other SHA", "refused"])("keeps release decision null when %s", async (kind) => {
  const fixture = world();
  if (kind !== "missing") release(fixture.store, kind === "other goal" ? "another-goal" : GOAL_ID,
    kind === "other SHA" ? "b".repeat(40) : SHA, kind === "refused");
  await fixture.deploy();
  expect(readCurrentDeployReceipt(fixture.store, PROJECT_ID, "production"))
    .toMatchObject({ outcome: "DEPLOYED", sha: SHA, releaseDecision: null });
});

it("refuses a corrupt matching release receipt before any host effect", async () => {
  const fixture = world(); const receiptId = release(fixture.store);
  const corrupt = new Proxy(fixture.store, { get(target, key) {
    if (key === "getCommandDecision") return (decisionKey: Parameters<SqliteEventStore["getCommandDecision"]>[0]) => {
      const decision = target.getCommandDecision(decisionKey);
      return decisionKey.commandId === receiptId && decision !== null
        ? { ...decision, resultBytes: new TextEncoder().encode("{}") } : decision;
    };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await expect(fixture.deploy(corrupt)).rejects.toMatchObject({ code: "RELEASE_RECEIPT_INVALID" });
  for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
  expect(readCurrentDeployReceipt(fixture.store, PROJECT_ID, "production")).toBeNull();
});
