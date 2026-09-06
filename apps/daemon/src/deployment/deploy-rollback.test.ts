import { afterEach, expect, it } from "vitest";
import { closeStores, openStore } from "../review/review-test-fixtures.js";
import { deploymentInfrastructureFiles } from "../repository/deployment/deployment-infrastructure-templates.js";
import { recordDeployReceipt } from "./deploy-ledger.js";
import { createDockerDouble } from "./deploy-ports.js";
import { candidateContainerName, createDeployService } from "./deploy-service.js";

afterEach(closeStores);
const projectId = "project-review-1", environment = "production", sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
function harness(missing = false, healthy = true) {
  const store = openStore();
  const prior = recordDeployReceipt(store, { projectId, environment, sha, imageDigest: digest, decisionId: "original",
    decidedAt: "2026-09-06T01:00:00.000Z", refusal: null, releaseDecision: null, url: null });
  if (!prior.ok) throw new Error(prior.code);
  const name = candidateContainerName(environment, sha, "rollback-1");
  const docker = createDockerDouble({ proxyConfig: deploymentInfrastructureFiles("", []).get("docker/Caddyfile") ?? "",
    running: { app: "HEALTHY" }, imageDigest: digest, health: healthy ? { [name]: ["HEALTHY"] } : {} });
  const builds: unknown[] = [];
  const service = createDeployService({ projectId, store, healthBudgetMs: 1, pollMs: 1, sleep: async () => {},
    ports: { build: async request => { builds.push(request); return docker.build(request); },
      docker: async (args, stdin) => missing && args[0] === "image" ? { code: 1, stderr: "absent", stdout: "" } : docker.docker(args, stdin),
      ssh: docker.ssh, transfer: docker.transfer, target: () => ({ network: "product", sshTarget: null, url: null }), releaseDecision: () => null } });
  return { service, builds, docker, name, request: { decisionId: "rollback-1", environment, receiptId: prior.receipt.receiptId } };
}

it("offers an explicit receipt-selected rollback operation", () => {
  expect("rollback" in harness().service).toBe(true);
});

it("switches only to the selected immutable image without rebuilding or transferring", async () => {
  const context = harness();
  const report = await context.service.rollback(context.request);
  expect(report.outcome).toBe("DEPLOYED");
  expect(report.receipt?.imageDigest).toBe(digest);
  expect(report.receipt?.sha).toBe(sha);
  expect(context.builds).toEqual([]);
  expect(context.docker.calls.find(args => args[0] === "run")?.at(-1)).toBe(digest);
  expect(context.docker.calls.some(args => args[0] === "save")).toBe(false);
  expect(context.docker.upstream()).toBe(context.name);
  expect(context.docker.state("app")).toBe("STOPPED");
});

it("refuses a missing image while retaining the serving incumbent", async () => {
  const context = harness(true);
  const report = await context.service.rollback(context.request);
  expect(report.outcome).toBe("REFUSED");
  expect(report.receipt?.refusal?.detail).toBe("DEPLOY_ROLLBACK_IMAGE_UNAVAILABLE");
  expect(context.docker.calls.some(args => args[0] === "run")).toBe(false);
  expect(context.docker.state("app")).toBe("HEALTHY");
  expect(context.docker.locked()).toBe(false);
});

it("retains the serving incumbent when the rollback candidate is unhealthy", async () => {
  const context = harness(false, false);
  expect((await context.service.rollback(context.request)).outcome).toBe("REFUSED");
  expect(context.docker.state("app")).toBe("HEALTHY");
  expect(context.docker.state(context.name)).toBe("REMOVED");
});

it("refuses a receipt from another environment before any Docker effect", async () => {
  const context = harness();
  expect((await context.service.rollback({ ...context.request, environment: "staging" })).detail).toBe("DEPLOY_ROLLBACK_RECEIPT_INVALID");
  expect(context.docker.calls).toEqual([]);
});

it("replays a completed rollback without repeating any container effect", async () => {
  const context = harness();
  const first = await context.service.rollback(context.request);
  const count = context.docker.calls.length;
  const replay = await context.service.rollback(context.request);
  expect(replay.receipt?.receiptId).toBe(first.receipt?.receiptId);
  expect(replay.outcome).toBe("DEPLOYED");
  expect(context.docker.calls).toHaveLength(count);
});
