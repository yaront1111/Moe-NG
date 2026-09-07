import { afterEach, expect, it } from "vitest";
import { closeStores, openStore } from "../review/review-test-fixtures.js";
import { deploymentInfrastructureFiles } from "../repository/deployment/deployment-infrastructure-templates.js";
import { readDeployReceipt, recordDeployReceipt } from "./deploy-ledger.js";
import type { ContainerState } from "./deploy-ports.js";
import { createDockerDouble } from "./deploy-ports.js";
import { DEPLOY_ENGINE_STAMP } from "./deploy-receipt-contracts.js";
import {
  candidateContainerName, createDeployService, healthArgv, runCandidateArgv,
} from "./deploy-service.js";

afterEach(closeStores);
const projectId = "project-review-1", environment = "production", sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
// A SECOND kept image under the SAME sha. A rebuild would produce exactly this
// divergence, so an engine that ignored the receipt could not tell them apart.
const altDigest = `sha256:${"c".repeat(64)}`;
const network = "product";

interface HarnessOptions {
  readonly missing?: boolean;
  readonly healthy?: boolean;
  /** What `image inspect` reports; the arm targeting altDigest sets it to altDigest. */
  readonly dockerDigest?: string;
}

function seed(store: ReturnType<typeof openStore>, decisionId: string, imageDigest: string): string {
  const prior = recordDeployReceipt(store, { projectId, environment, sha, imageDigest, decisionId,
    decidedAt: "2026-09-06T01:00:00.000Z", refusal: null, releaseDecision: null, url: null });
  if (!prior.ok) throw new Error(prior.code);
  return prior.receipt.receiptId;
}

function harness(options: HarnessOptions = {}) {
  const { dockerDigest = digest, healthy = true, missing = false } = options;
  const store = openStore();
  const receiptId = seed(store, "original", digest);
  const altReceiptId = seed(store, "original-alt", altDigest);
  const name = candidateContainerName(environment, sha, "rollback-1");
  const altName = candidateContainerName(environment, sha, "rollback-2");
  const health: Record<string, readonly ContainerState[]> = healthy
    ? { [name]: ["HEALTHY"], [altName]: ["HEALTHY"] } : {};
  const docker = createDockerDouble({ proxyConfig: deploymentInfrastructureFiles("", []).get("docker/Caddyfile") ?? "",
    running: { app: "HEALTHY" }, imageDigest: dockerDigest, health });
  const builds: unknown[] = [];
  const service = createDeployService({ projectId, store, healthBudgetMs: 1, pollMs: 1, sleep: async () => {},
    ports: { build: async request => { builds.push(request); return docker.build(request); },
      docker: async (args, stdin) => missing && args[0] === "image" ? { code: 1, stderr: "absent", stdout: "" } : docker.docker(args, stdin),
      ssh: docker.ssh, transfer: docker.transfer, target: () => ({ network, sshTarget: null, url: null }), releaseDecision: () => null } });
  return { service, builds, docker, store, name, altName,
    request: { decisionId: "rollback-1", environment, receiptId },
    altRequest: { decisionId: "rollback-2", environment, receiptId: altReceiptId } };
}

/** The kept receipt's OWN digest, read back through the production reader. */
function keptDigest(context: ReturnType<typeof harness>, receiptId: string): string {
  const kept = readDeployReceipt(context.store, projectId, receiptId);
  if (!kept.ok) throw new Error(kept.code);
  if (kept.receipt.imageDigest === null) throw new Error("kept receipt carries no image digest");
  return kept.receipt.imageDigest;
}

const argvFor = (context: ReturnType<typeof harness>, verb: string): readonly string[] | undefined =>
  context.docker.calls.find(args => args[0] === verb);

/** Every verb that produces or fetches image bytes — DoD 2's forbidden set. */
const BUILD_VERBS: readonly string[] = ["build", "buildx", "save", "load", "pull", "commit", "import"];

/**
 * DoD 2, swept over EVERY recorded argv rather than one path's `builds` array.
 * The docker double records `build` and `transfer`'s `save` into `calls` too, so
 * one sweep covers the build port, the transfer port and the raw runner. A sweep
 * that enumerates zero cases is green for the wrong reason, so emptiness must be
 * declared by the caller and is asserted rather than tolerated.
 */
function expectNoRebuild(
  context: ReturnType<typeof harness>, recorded: "some docker calls" | "no docker call",
): void {
  if (recorded === "no docker call") expect(context.docker.calls).toEqual([]);
  else expect(context.docker.calls.length).toBeGreaterThan(0);
  // argv[1] as well as argv[0]: `docker image load|import|pull` and `buildx build`
  // both hide the build verb in the second position.
  const swept = context.docker.calls.flatMap(argv => [argv[0] ?? "", argv[1] ?? ""]);
  expect(swept.filter(verb => BUILD_VERBS.includes(verb))).toEqual([]);
  expect(context.builds).toEqual([]);
  expect(context.docker.sshCalls).toEqual([]);
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
  expectNoRebuild(context, "some docker calls");
  expect(context.docker.upstream()).toBe(context.name);
  expect(context.docker.state("app")).toBe("STOPPED");
});

// DoD 1. The expected value is READ BACK from the kept receipt rather than taken
// from the module constant the harness also seeded: an assertion against that
// constant agrees with itself and holds even if the engine ignored the receipt.
it("redeploys the image named by the kept receipt it read back, byte for byte", async () => {
  const context = harness();
  expect((await context.service.rollback(context.request)).outcome).toBe("DEPLOYED");
  const kept = keptDigest(context, context.request.receiptId);
  expect(argvFor(context, "run")).toEqual(runCandidateArgv(context.name, network, kept));
  expect(argvFor(context, "image")).toEqual(["image", "inspect", "--format", "{{.Id}}", kept]);
  expectNoRebuild(context, "some docker calls");
});

// DoD 1's drill, committed. Two kept receipts under the SAME sha differ only in
// image; the engine must follow the one the request names. An engine deriving
// the tag from the sha cannot satisfy both arms.
it("follows the receipt the request names when two kept receipts share a sha", async () => {
  const context = harness({ dockerDigest: altDigest });
  expect((await context.service.rollback(context.altRequest)).outcome).toBe("DEPLOYED");
  const kept = keptDigest(context, context.altRequest.receiptId);
  expect(kept).toBe(altDigest);
  expect(kept).not.toBe(keptDigest(context, context.request.receiptId));
  expect(argvFor(context, "run")).toEqual(runCandidateArgv(context.altName, network, kept));
  expect(argvFor(context, "image")).toEqual(["image", "inspect", "--format", "{{.Id}}", kept]);
  expectNoRebuild(context, "some docker calls");
});

// DoD 4. The END state (`upstream()` is the candidate, `app` is STOPPED) is
// equally true of a stop-then-start implementation, so it cannot carry this
// property. The ORDER can. Both argv shapes come from the production builders
// at deploy-service.ts:69-75 rather than being retyped here.
it("retires the incumbent only after the candidate answered healthy and the proxy switched", async () => {
  const context = harness();
  expect((await context.service.rollback(context.request)).outcome).toBe("DEPLOYED");
  const kept = keptDigest(context, context.request.receiptId);
  const indexesOf = (expected: readonly string[]): readonly number[] =>
    context.docker.calls.flatMap((argv, index) =>
      argv.length === expected.length && argv.every((token, at) => token === expected[at]) ? [index] : []);

  const started = indexesOf(runCandidateArgv(context.name, network, kept));
  // `startCandidate` probes for an EXISTING container before it runs one, so the
  // first health argv precedes the run. The CONFIRMING probe is the last.
  const probes = indexesOf(healthArgv(context.name));
  const retired = indexesOf(["stop", "app"]);
  const switched = context.docker.calls.findIndex(argv => argv.includes("reload"));

  expect(started).toHaveLength(1);
  expect(retired).toHaveLength(1);
  expect(probes.length).toBeGreaterThan(0);
  const confirmed = probes[probes.length - 1] ?? -1;
  expect(confirmed).toBeGreaterThan(started[0] ?? -1);
  expect(switched).toBeGreaterThan(confirmed);
  expect(retired[0] ?? -1).toBeGreaterThan(switched);
});

// DoD 4's "no point at which neither serves", answered by the double's STATE
// MACHINE rather than its argv log: only the state machine knows what was
// RUNNING at each step (deploy-ports.ts:279-283). A gap would appear as a
// transition serving nobody.
it("never leaves the environment with no container serving during a rollback", async () => {
  const context = harness();
  expect((await context.service.rollback(context.request)).outcome).toBe("DEPLOYED");
  expect(context.docker.transitions.length).toBeGreaterThan(1);
  const gaps = context.docker.transitions.filter(step => step.serving.length === 0);
  expect(gaps.map(step => step.argv.join(" "))).toEqual([]);
  expect(context.docker.transitions.at(-1)?.serving).toEqual([context.name]);
});

it("refuses a missing image while retaining the serving incumbent", async () => {
  const context = harness({ missing: true });
  const report = await context.service.rollback(context.request);
  expect(report.outcome).toBe("REFUSED");
  // The SHIPPED triple, code AND layer, not the detail alone. DoD 2 calls
  // DEPLOY_ROLLBACK_IMAGE_UNAVAILABLE "the tree's code"; it is the DETAIL under
  // code DEPLOY_BUILD_FAILED (deploy-service.ts:296 via refusal() at :77-78).
  // Promoting it is forbidden — see the step note and completion record.
  // DEPLOY_ENGINE_STAMP is imported, never retyped, so moving the stamp reds this.
  expect(report.receipt?.refusal).toMatchObject({
    code: "DEPLOY_BUILD_FAILED", detail: "DEPLOY_ROLLBACK_IMAGE_UNAVAILABLE", layer: DEPLOY_ENGINE_STAMP,
  });
  expect(context.docker.calls.some(args => args[0] === "run")).toBe(false);
  expectNoRebuild(context, "some docker calls");
  expect(context.docker.state("app")).toBe("HEALTHY");
  expect(context.docker.locked()).toBe(false);
});

it("retains the serving incumbent when the rollback candidate is unhealthy", async () => {
  const context = harness({ healthy: false });
  expect((await context.service.rollback(context.request)).outcome).toBe("REFUSED");
  expect(context.docker.state("app")).toBe("HEALTHY");
  expect(context.docker.state(context.name)).toBe("REMOVED");
  expectNoRebuild(context, "some docker calls");
});

it("refuses a receipt from another environment before any Docker effect", async () => {
  const context = harness();
  const report = await context.service.rollback({ ...context.request, environment: "staging" });
  expect(report.outcome).toBe("REFUSED");
  // At the ENGINE this refusal is the report DETAIL and no receipt is minted
  // (deploy-service.ts:349-352), so there is no DEPLOY_ENGINE_STAMP to pin here.
  // The layer for this code lives at the command seam; rollback-command.test.ts
  // pins it as DAEMON_COMMAND_SEAM. Both ends are asserted so the refusal cannot
  // migrate between layers unnoticed.
  expect(report.detail).toBe("DEPLOY_ROLLBACK_RECEIPT_INVALID");
  expect(report.receipt).toBeNull();
  expectNoRebuild(context, "no docker call");
});

it("replays a completed rollback without repeating any container effect", async () => {
  const context = harness();
  const first = await context.service.rollback(context.request);
  const count = context.docker.calls.length;
  const replay = await context.service.rollback(context.request);
  expect(replay.receipt?.receiptId).toBe(first.receipt?.receiptId);
  expect(replay.outcome).toBe("DEPLOYED");
  expect(context.docker.calls).toHaveLength(count);
  expectNoRebuild(context, "some docker calls");
});
