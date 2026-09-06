import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { closeStores, openStore, openRestartableStore } from "../review/review-test-fixtures.js";
import { deploymentInfrastructureFiles } from "../repository/deployment/deployment-infrastructure-templates.js";
import { CONTROLLED_PROFILE_VERSION } from "../repository/controlled-profile/controlled-profile-generator.js";
import {
  DEPLOY_BUILD_FAILED, DEPLOY_DOCKER_UNAVAILABLE, DEPLOY_ENGINE_STAMP, DEPLOY_HEALTH_TIMEOUT,
  DEPLOY_TARGET_MISSING, deployImageTag,
} from "./deploy-receipt-contracts.js";
import {
  createDockerDouble, dockerSaveArgv, sshDockerLoadArgv, nodeDockerRunner, DEPLOY_COMMAND_TIMEOUT_MS,
} from "./deploy-ports.js";
import type { DockerDouble, DockerDoubleOptions, DeployTarget, DockerRunner } from "./deploy-ports.js";
import { readDeployLedger, readPreviousDeployReceipt } from "./deploy-ledger.js";
import {
  NO_RELEASE_DECISION_NOTE, buildArgv, candidateContainerName, createDeployService, healthArgv,
  runCandidateArgv,
} from "./deploy-service.js";

/**
 * OFFLINE. Every port is the state-machine double: no test here reaches the
 * network or a real docker daemon, and none spawns a child.
 *
 * Every store handle is registered with the shared fixture and closed by
 * `afterEach(closeStores)`, which vitest runs on the THROWING path too — so a
 * failing assertion cannot leak a handle or a temp directory.
 */

afterEach(closeStores);
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const PROJECT = "project-review-1";
const ENVIRONMENT = "production";
const STAGING = "staging";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const CONTEXT = "/workspace/app";
const INCUMBENT = "app";
const PROXY_CONFIG = deploymentInfrastructureFiles(CONTROLLED_PROFILE_VERSION, []).get("docker/Caddyfile") ?? "";
const LOCAL: DeployTarget = { network: "moe-net", sshTarget: null, url: "https://app.example.test" };
const REMOTE: DeployTarget = { ...LOCAL, sshTarget: "deployer@host.example.test" };

interface Harness {
  readonly candidate: string;
  readonly docker: DockerDouble;
  readonly store: ReturnType<typeof openStore>;
  deploy(overrides?: { decisionId?: string; sha?: string }): ReturnType<
    ReturnType<typeof createDeployService>["deploy"]
  >;
}

/**
 * The candidate reports `starting` once and then `healthy`, so the poll loop is
 * genuinely exercised rather than short-circuited on its first probe.
 */
function harness(options: {
  readonly decisionId?: string;
  readonly double?: DockerDoubleOptions;
  readonly environment?: string;
  readonly release?: string | null;
  readonly sha?: string;
  readonly target?: DeployTarget | null;
  readonly wrapDocker?: (runner: DockerRunner) => DockerRunner;
} = {}): Harness {
  const environment = options.environment ?? ENVIRONMENT;
  const sha = options.sha ?? SHA;
  const decisionId = options.decisionId ?? "decision-1";
  const candidate = candidateContainerName(environment, sha, decisionId);
  const docker = createDockerDouble({
    proxyConfig: PROXY_CONFIG,
    health: { [candidate]: ["STARTING", "HEALTHY"] },
    running: { [INCUMBENT]: "HEALTHY" },
    ...options.double,
  });
  const store = openStore();
  const service = createDeployService({
    clock: () => "2026-09-06T00:00:00.000Z",
    // Zero-cost time: the budget is exercised in poll COUNTS, never in wall clock.
    pollMs: 1, healthBudgetMs: 10, sleep: () => Promise.resolve(),
    ports: {
      docker: options.wrapDocker?.(docker.docker) ?? docker.docker,
      releaseDecision: () => options.release ?? null,
      ssh: docker.ssh,
      target: () => (options.target === undefined ? LOCAL : options.target),
      transfer: docker.transfer,
    },
    projectId: PROJECT, store,
  });
  return {
    candidate, deploy: (overrides = {}) => service.deploy({
      context: CONTEXT, decisionId: overrides.decisionId ?? decisionId,
      environment, sha: overrides.sha ?? sha,
    }),
    docker, store,
  };
}

const argvFor = (docker: DockerDouble, verb: string): readonly string[] | undefined =>
  docker.calls.find((call) => call[0] === verb);

describe("the deploy engine builds at the landed sha (DoD 1)", () => {
  it("tags the image with the sha VALUE and passes the context, byte for byte", async () => {
    const context = harness();
    const report = await context.deploy();

    expect(report.outcome).toBe("DEPLOYED");
    // BYTE-FOR-BYTE against the sha VALUE bound above. `toMatch(/[0-9a-f]{40}/)`
    // would pass for the WRONG sha, and every later rollback resolves through
    // this tag.
    expect(argvFor(context.docker, "build")).toEqual([
      "build", "--tag", `moe-deploy-production:${SHA}`, CONTEXT,
    ]);
    expect(argvFor(context.docker, "build")?.[2]).toBe(deployImageTag(ENVIRONMENT, SHA));
    expect(argvFor(context.docker, "build")?.[2]?.split(":")[1]).toBe(SHA);
  });

  it("starts the candidate with NO published host port and probes it BY NAME", async () => {
    const context = harness();
    await context.deploy();

    const run = argvFor(context.docker, "run");
    expect(run).toEqual(runCandidateArgv(context.candidate, "moe-net", deployImageTag(ENVIRONMENT, SHA)));
    expect(run).toEqual([
      "run", "--detach", "--name", context.candidate, "--network", "moe-net",
      `moe-deploy-production:${SHA}`,
    ]);
    // No `-p` / `--publish` anywhere: a published host port is bound at container
    // create, so a candidate that published one could not start beside the incumbent.
    expect(run?.some((token) => token === "-p" || token === "--publish")).toBe(false);
    // The probe argv NAMES THE CANDIDATE. A probe addressed at the environment's
    // url would be answered by the OLD container and pass instantly.
    expect(context.docker.calls.filter((call) => call[0] === "inspect")
      .every((call) => call[call.length - 1] === context.candidate)).toBe(true);
    expect(argvFor(context.docker, "inspect")).toEqual(healthArgv(context.candidate));
  });

  it("sends `docker save` and `ssh docker load` as two argv arrays, asserted independently", async () => {
    const context = harness({ target: REMOTE });
    const report = await context.deploy();

    expect(report.outcome).toBe("DEPLOYED");
    const tag = deployImageTag(ENVIRONMENT, SHA);
    expect(context.docker.calls).toContainEqual(["save", tag]);
    expect(dockerSaveArgv(tag)).toEqual(["save", tag]);
    expect(context.docker.sshCalls).toContainEqual([REMOTE.sshTarget, "docker", "load"]);
    expect(sshDockerLoadArgv(REMOTE.sshTarget as string)).toEqual([
      REMOTE.sshTarget, "docker", "load",
    ]);
  });

  it("surfaces the FIRST child's failure, the exit code a shell pipe would swallow", async () => {
    const context = harness({
      double: { saveStderr: "Error response from daemon: no such image: sha-not-built" },
      target: REMOTE,
    });
    const report = await context.deploy();

    expect(report.outcome).toBe("REFUSED");
    const receipt = readDeployLedger(context.store, PROJECT).get(ENVIRONMENT)?.current;
    expect(receipt?.refusal?.code).toBe(DEPLOY_BUILD_FAILED);
    expect(receipt?.refusal?.layer).toBe(DEPLOY_ENGINE_STAMP);
    expect(receipt?.refusal?.detail)
      .toBe("docker save: Error response from daemon: no such image: sha-not-built");
    // `save` failing means `load` must never be treated as the whole answer.
    expect(context.docker.state(context.candidate)).toBe("ABSENT");
  });
});

describe("a health refusal leaves a DEFINED state (DoD 3)", () => {
  it("refuses with code AND layer when the candidate never reports healthy", async () => {
    const context = harness({ double: { health: {}, running: { [INCUMBENT]: "HEALTHY" } } });
    const report = await context.deploy();

    expect(report.outcome).toBe("REFUSED");
    const receipt = readDeployLedger(context.store, PROJECT).get(ENVIRONMENT)?.current;
    expect(receipt?.refusal?.code).toBe(DEPLOY_HEALTH_TIMEOUT);
    expect(receipt?.refusal?.layer).toBe(DEPLOY_ENGINE_STAMP);
    expect(receipt?.imageDigest).toBeNull();
    expect(context.docker.state(INCUMBENT)).toBe("HEALTHY");
    expect(context.docker.state(context.candidate)).toBe("REMOVED");
    expect(context.docker.config()).toBe(PROXY_CONFIG);
    expect(context.docker.upstream()).toBe(INCUMBENT);
    expect(context.docker.writes).toEqual([]);
    expect(context.docker.calls.some((call) => call.includes("reload"))).toBe(false);
  });

  it("leaves the incumbent RUNNING and the candidate REMOVED, read from the port's final state", async () => {
    const context = harness({
      double: { health: { [candidateContainerName(ENVIRONMENT, SHA, "decision-1")]: ["STARTING"] },
        running: { [INCUMBENT]: "HEALTHY" } },
    });
    await context.deploy();

    // The STATE, not the return value: a half-deployed environment reporting a
    // refusal while leaking a stray container is as undefined as a half-deploy.
    expect(context.docker.state(INCUMBENT)).toBe("HEALTHY");
    expect(context.docker.state(context.candidate)).toBe("REMOVED");
    expect(context.docker.serving()).toEqual([INCUMBENT]);
    expect(context.docker.calls).toContainEqual(["rm", "--force", context.candidate]);
  });
});

describe("every refusal names its code and its layer (DoD 4)", () => {
  it("refuses DEPLOY_TARGET_MISSING when no target is bound", async () => {
    const context = harness({ target: null });
    const report = await context.deploy();

    expect(report.outcome).toBe("REFUSED");
    const receipt = readDeployLedger(context.store, PROJECT).get(ENVIRONMENT)?.current;
    expect(receipt?.refusal?.code).toBe(DEPLOY_TARGET_MISSING);
    expect(receipt?.refusal?.layer).toBe(DEPLOY_ENGINE_STAMP);
    // Nothing was invoked: a missing target is answered before any effect.
    expect(context.docker.calls).toEqual([]);
  });

  it("refuses DEPLOY_DOCKER_UNAVAILABLE when docker does not answer at all", async () => {
    const context = harness({ double: { dockerUnavailable: true } });
    const report = await context.deploy();

    expect(report.outcome).toBe("REFUSED");
    const receipt = readDeployLedger(context.store, PROJECT).get(ENVIRONMENT)?.current;
    expect(receipt?.refusal?.code).toBe(DEPLOY_DOCKER_UNAVAILABLE);
    expect(receipt?.refusal?.layer).toBe(DEPLOY_ENGINE_STAMP);
    expect(context.docker.state(context.candidate)).toBe("ABSENT");
  });

  it("carries docker's ACTUAL last stderr line into DEPLOY_BUILD_FAILED", async () => {
    const planted = "failed to solve: process \"/bin/sh -c pnpm build\" did not complete successfully: exit code: 137";
    const context = harness({ double: { buildStderr: `Step 7/9 : RUN pnpm build\n${planted}\n` } });
    const report = await context.deploy();

    expect(report.outcome).toBe("REFUSED");
    const receipt = readDeployLedger(context.store, PROJECT).get(ENVIRONMENT)?.current;
    expect(receipt?.refusal?.code).toBe(DEPLOY_BUILD_FAILED);
    expect(receipt?.refusal?.layer).toBe(DEPLOY_ENGINE_STAMP);
    // THE EXACT PLANTED TEXT. A generic "build failed" message cannot pass this,
    // and a receipt read weeks later is undiagnosable without it.
    expect(receipt?.refusal?.detail).toBe(planted);
  });
});

describe("the previous receipt is kept and readable (DoD 6)", () => {
  it("keeps BOTH receipts retrievable and distinguishable by sha across two deploys", async () => {
    const first = harness({ decisionId: "decision-1" });
    await first.deploy();
    const second = createDeployService({
      clock: () => "2026-09-06T01:00:00.000Z",
      pollMs: 1, healthBudgetMs: 10, sleep: () => Promise.resolve(),
      ports: {
        docker: createDockerDouble({
          proxyConfig: PROXY_CONFIG,
          running: { [INCUMBENT]: "HEALTHY" },
          health: { [candidateContainerName(ENVIRONMENT, OTHER_SHA, "decision-2")]: ["HEALTHY"] },
        }).docker,
        releaseDecision: () => null, ssh: first.docker.ssh, target: () => LOCAL,
        transfer: first.docker.transfer,
      },
      projectId: PROJECT, store: first.store,
    });
    const later = await second.deploy({
      context: CONTEXT, decisionId: "decision-2", environment: ENVIRONMENT, sha: OTHER_SHA,
    });

    expect(later.outcome).toBe("DEPLOYED");
    // THE CALL task-da60dc4b39c SHOULD USE:
    // readPreviousDeployReceipt(store, projectId, environment): DeployReceiptV1 | null
    const previous = readPreviousDeployReceipt(first.store, PROJECT, ENVIRONMENT);
    const state = readDeployLedger(first.store, PROJECT).get(ENVIRONMENT);
    expect(previous?.sha).toBe(SHA);
    expect(state?.current.sha).toBe(OTHER_SHA);
    expect(previous?.sha).not.toBe(state?.current.sha);
    expect(previous?.receiptId).not.toBe(state?.current.receiptId);
    expect(state?.receipts).toHaveLength(2);
  });

  it("replays the same decision rather than losing the previous entry", async () => {
    const context = harness({ decisionId: "decision-1" });
    await context.deploy();
    const calls = context.docker.calls.length;
    const replay = await context.deploy();

    expect(replay.outcome).toBe("DEPLOYED");
    const state = readDeployLedger(context.store, PROJECT).get(ENVIRONMENT);
    // ONE row, not two: the receipt id is a pure function of the decision.
    expect(state?.receipts).toHaveLength(1);
    expect(state?.current.sha).toBe(SHA);
    expect(context.docker.calls).toHaveLength(calls);
  });

  it("replays a refusal before effects, rather than deploying behind a REFUSED receipt", async () => {
    const context = harness({ double: { lockHeld: true } });
    try {
      const first = await context.deploy();
      expect(first.receipt?.refusal).toEqual({ code: DEPLOY_BUILD_FAILED, layer: DEPLOY_ENGINE_STAMP,
        detail: "DEPLOY_PROXY_BUSY" });
      await context.docker.docker(["exec", "proxy", "rmdir", "/tmp/moe-deploy-lock"]);
      const calls = context.docker.calls.length;
      const replay = await context.deploy();
      expect(replay.outcome).toBe("REFUSED");
      expect(replay.receipt).toEqual(first.receipt);
      expect(context.docker.calls).toHaveLength(calls);
      expect(context.docker.state(context.candidate)).toBe("ABSENT");
    } finally { closeStores(); }
  });

  it("answers null for an environment that has deployed only once, and nothing for one that never has", async () => {
    const context = harness();
    await context.deploy();

    // Null means "nothing to roll back TO" — never the CURRENT receipt, which
    // would make a rollback a no-op wearing a success.
    expect(readPreviousDeployReceipt(context.store, PROJECT, ENVIRONMENT)).toBeNull();
    expect(readPreviousDeployReceipt(context.store, PROJECT, STAGING)).toBeNull();
  });
});

describe("a production deploy reads the release decision, and never decides one (DoD 7)", () => {
  it("CITES the release decision when the port answers one, and does not refuse", async () => {
    const context = harness({ release: "release-2026-09-06-a" });
    const report = await context.deploy();

    expect(report.outcome).toBe("DEPLOYED");
    expect(report.detail).toContain("cites release decision release-2026-09-06-a");
    expect(readDeployLedger(context.store, PROJECT).get(ENVIRONMENT)?.current.releaseDecision)
      .toBe("release-2026-09-06-a");
  });

  it("states 'no release decision' when the port answers null, and does not refuse", async () => {
    const context = harness({ release: null });
    const report = await context.deploy();

    expect(report.outcome).toBe("DEPLOYED");
    expect(report.detail).toContain("no release decision");
    expect(NO_RELEASE_DECISION_NOTE).toBe("no release decision");
    expect(readDeployLedger(context.store, PROJECT).get(ENVIRONMENT)?.current.releaseDecision)
      .toBeNull();
  });
});

describe("the probe reads the candidate, not the container it replaces", () => {
  it("does NOT succeed while the OLD container is healthy and the candidate is only starting", async () => {
    // The subtlest bug available here: a probe addressed at the environment's
    // public url is answered by the incumbent, so every deploy 'passes' health
    // instantly while proving nothing about the image just built.
    const candidate = candidateContainerName(ENVIRONMENT, SHA, "decision-1");
    const context = harness({
      double: { health: { [INCUMBENT]: ["HEALTHY"], [candidate]: ["STARTING"] },
        running: { [INCUMBENT]: "HEALTHY" } },
    });
    const report = await context.deploy();

    expect(report.outcome).toBe("REFUSED");
    const receipt = readDeployLedger(context.store, PROJECT).get(ENVIRONMENT)?.current;
    expect(receipt?.refusal?.code).toBe(DEPLOY_HEALTH_TIMEOUT);
    expect(context.docker.state(INCUMBENT)).toBe("HEALTHY");
  });
});

describe("the proxy flip keeps a healthy public route", () => {
  it.each(["\u00a0reverse_proxy app:3000", "\treverse_proxy app:3000\u00a0"])(
    "refuses Unicode directive whitespace before an unchanged route can be retired: %s", async (directive) => {
      const proxyConfig = PROXY_CONFIG.replace("\treverse_proxy app:3000", directive);
      expect(proxyConfig).not.toBe(PROXY_CONFIG);
      const context = harness({ double: { proxyConfig } });
      try {
        const report = await context.deploy();
        expect(report.receipt?.refusal).toEqual({ code: DEPLOY_BUILD_FAILED, layer: DEPLOY_ENGINE_STAMP,
          detail: "DEPLOY_PROXY_CONFIG_UNSUPPORTED" });
        expect(context.docker.state(context.candidate)).toBe("ABSENT");
        expect(context.docker.state(INCUMBENT)).toBe("HEALTHY");
        expect(context.docker.config()).toBe(proxyConfig);
        expect(context.docker.writes).toEqual([]);
      } finally { closeStores(); }
    },
  );

  it("refuses a custom topology that would flip an unpublished listener instead of public 3000", async () => {
    const proxyConfig = ":3000 {\n\treverse_proxy {\n\t\tto app:3000\n\t}\n}\n:3001 {\n\treverse_proxy app:3000\n}\n";
    const context = harness({ double: { proxyConfig } });
    try {
      const report = await context.deploy();
      expect(report.receipt?.refusal).toEqual({ code: DEPLOY_BUILD_FAILED, layer: DEPLOY_ENGINE_STAMP,
        detail: "DEPLOY_PROXY_CONFIG_UNSUPPORTED" });
      expect(context.docker.state(context.candidate)).toBe("ABSENT");
      expect(context.docker.state(INCUMBENT)).toBe("HEALTHY");
      expect(context.docker.config()).toBe(proxyConfig);
      expect(context.docker.writes).toEqual([]);
    } finally { closeStores(); }
  });

  it("rechecks a replay after acquiring the lease, refusing a raced different sha before effects", async () => {
    let release = () => {}; let versions = 0;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const laterName = candidateContainerName(ENVIRONMENT, OTHER_SHA, "decision-1");
    const context = harness({
      double: { health: { [candidateContainerName(ENVIRONMENT, SHA, "decision-1")]: ["HEALTHY"], [laterName]: ["HEALTHY"] } },
      wrapDocker: (base) => async (args, stdin) => {
        if (args[0] === "version" && ++versions === 2) await wait;
        return base(args, stdin);
      },
    });
    const first = context.deploy(); const second = context.deploy({ sha: OTHER_SHA });
    try {
      expect((await first).outcome).toBe("DEPLOYED");
      release();
      expect(await second).toEqual({ outcome: "REFUSED", detail: "DEPLOY_DECISION_REPLAY_MISMATCH", environment: ENVIRONMENT, receipt: null });
      expect(context.docker.upstream()).toBe(context.candidate);
      expect(context.docker.state(laterName)).toBe("ABSENT");
    } finally { release(); await Promise.all([first, second]); closeStores(); }
  });

  it("treats SSH exit 255 as uncertain completion, not a refused remote reload", async () => {
    const context = harness({ target: REMOTE, double: { reloadCodes: [255], reloadAppliesOnFailure: true } });
    try {
      const report = await context.deploy();
      expect(report.receipt?.refusal).toEqual({ code: DEPLOY_BUILD_FAILED, layer: DEPLOY_ENGINE_STAMP,
        detail: "DEPLOY_PROXY_RECOVERY_REQUIRED" });
      expect(context.docker.state(INCUMBENT)).toBe("HEALTHY");
      expect(context.docker.state(context.candidate)).toBe("HEALTHY");
      expect(context.docker.locked()).toBe(true);
    } finally { closeStores(); }
  });
  it("rewrites the directive, never an upstream mentioned in a comment", async () => {
    const context = harness({ double: { proxyConfig: `# reverse_proxy app:3000\n${PROXY_CONFIG}` } });
    try {
      const report = await context.deploy();
      expect(report.outcome).toBe("DEPLOYED");
      expect(context.docker.config()).toContain("# reverse_proxy app:3000\n");
      expect(context.docker.config()).toContain(`\treverse_proxy ${context.candidate}:3000\n`);
      expect(context.docker.upstream()).toBe(context.candidate);
      expect(context.docker.serving()).toEqual([context.candidate]);
    } finally { closeStores(); }
  });

  it.each([
    { double: { reloadCodes: [1] }, detail: "DEPLOY_PROXY_RELOAD_FAILED" },
    { double: { rewriteCodes: [1] }, detail: "DEPLOY_PROXY_WRITE_FAILED" },
  ])("restores the old route after $detail", async ({ double, detail }) => {
    const context = harness({ double });
    try {
      const report = await context.deploy();
      expect(report.receipt?.refusal).toEqual({ code: DEPLOY_BUILD_FAILED, layer: DEPLOY_ENGINE_STAMP, detail });
      expect(context.docker.state(INCUMBENT)).toBe("HEALTHY");
      expect(context.docker.upstream()).toBe(INCUMBENT);
      expect(context.docker.config()).toBe(PROXY_CONFIG);
      expect(context.docker.state(context.candidate)).toBe("REMOVED");
      expect(context.docker.locked()).toBe(false);
      for (const transition of context.docker.transitions) expect(transition.serving.length).toBeGreaterThan(0);
    } finally { closeStores(); }
  });

  it.each([
    { reloadCodes: [null], reloadAppliesOnFailure: true },
    { reloadCodes: [1, 1] },
    { rewriteCodes: [null] },
  ])("keeps both containers and the lock on uncertain commands or failed restoration", async (double) => {
    const context = harness({ double });
    try {
      const report = await context.deploy();
      expect(report.receipt?.refusal).toEqual({ code: DEPLOY_BUILD_FAILED, layer: DEPLOY_ENGINE_STAMP,
        detail: "DEPLOY_PROXY_RECOVERY_REQUIRED" });
      expect(context.docker.state(INCUMBENT)).toBe("HEALTHY");
      expect(context.docker.state(context.candidate)).toBe("HEALTHY");
      expect(context.docker.locked()).toBe(true);
    } finally { closeStores(); }
  });

  it.each([
    { double: { proxyNames: [] }, detail: "DEPLOY_PROXY_MISSING_OR_AMBIGUOUS" },
    { double: { proxyNames: ["proxy", "another"] }, detail: "DEPLOY_PROXY_MISSING_OR_AMBIGUOUS" },
    { double: { lockHeld: true }, detail: "DEPLOY_PROXY_BUSY" },
    { double: { proxyConfig: "unsupported configuration" }, detail: "DEPLOY_PROXY_CONFIG_UNSUPPORTED" },
  ])("refuses $detail before starting a candidate", async ({ double, detail }) => {
    const context = harness({ double });
    try {
      const report = await context.deploy();
      expect(report.receipt?.refusal).toEqual({ code: DEPLOY_BUILD_FAILED, layer: DEPLOY_ENGINE_STAMP, detail });
      expect(context.docker.state(INCUMBENT)).toBe("HEALTHY");
      expect(context.docker.state(context.candidate)).toBe("ABSENT");
    } finally { closeStores(); }
  });

  it("serializes concurrent deploys at the proxy rather than per service instance", async () => {
    const context = harness();
    try {
      const reports = await Promise.all([context.deploy(), context.deploy({ decisionId: "decision-2" })]);
      expect(reports.map((report) => report.outcome).sort()).toEqual(["DEPLOYED", "REFUSED"]);
      expect(reports.find((report) => report.outcome === "REFUSED")?.receipt?.refusal)
        .toEqual({ code: DEPLOY_BUILD_FAILED, layer: DEPLOY_ENGINE_STAMP, detail: "DEPLOY_PROXY_BUSY" });
      expect(context.docker.locked()).toBe(false);
    } finally { closeStores(); }
  });

  it("never returns DEPLOYED behind a concurrent refusal for the same decision", async () => {
    const context = harness();
    try {
      const reports = await Promise.all([context.deploy(), context.deploy()]);
      expect(reports.map((report) => report.outcome)).toEqual(["REFUSED", "REFUSED"]);
      for (const report of reports) expect(report.receipt?.refusal).toEqual({
        code: DEPLOY_BUILD_FAILED, layer: DEPLOY_ENGINE_STAMP, detail: "DEPLOY_PROXY_BUSY",
      });
      expect(context.docker.state(INCUMBENT)).toBe("HEALTHY");
      expect(context.docker.state(context.candidate)).toBe("ABSENT");
      expect(context.docker.calls.some((call) => call[0] === "run")).toBe(false);
      expect(context.docker.upstream()).toBe(INCUMBENT);
    } finally { closeStores(); }
  });

  it("reloads before stopping the incumbent, with no gap at any transition", async () => {
    const context = harness();
    try {
      const report = await context.deploy();
      expect(report.outcome).toBe("DEPLOYED");
      expect(context.docker.state(INCUMBENT)).toBe("STOPPED");
      expect(context.docker.upstream()).toBe(context.candidate);
      expect(context.docker.transitions.length).toBeGreaterThan(5);
      for (const [index, state] of context.docker.transitions.entries()) {
        expect(state.serving.length, `transition ${index}: ${state.argv.join(" ")}`).toBeGreaterThan(0);
      }

    } finally { closeStores(); }
  });

  it("records exact rewrite and reload argv before the incumbent stop", async () => {
    const context = harness();
    try {
      expect((await context.deploy()).outcome).toBe("DEPLOYED");
      const rewrite = ["exec", "-i", "proxy", "tee", "/etc/caddy/Caddyfile"];
      const reload = ["exec", "proxy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"];
      expect(context.docker.calls).toContainEqual(rewrite);
      expect(context.docker.calls).toContainEqual(reload);
      const index = (argv: string[]) => context.docker.calls.findIndex((call) => JSON.stringify(call) === JSON.stringify(argv));
      expect(index(reload)).toBeGreaterThan(index(rewrite));
      expect(index(["stop", INCUMBENT])).toBeGreaterThan(index(reload));
      expect(context.docker.writes[0]).toContain(`reverse_proxy ${context.candidate}:3000`);
      expect(context.docker.locked()).toBe(false);
    } finally { closeStores(); }
  });

  it("refuses a malformed sha BEFORE any effect, so no container outlives its receipt", async () => {
    // The receipt decoder would refuse to record this, so the container must
    // never start: an effect with no durable trace is worse than a refusal.
    const context = harness({ sha: "not-a-sha" });
    const report = await context.deploy({ sha: "not-a-sha" });

    expect(report.outcome).toBe("REFUSED");
    expect(context.docker.calls).toEqual([]);
    expect(context.docker.serving()).toEqual([INCUMBENT]);
    expect(readDeployLedger(context.store, PROJECT).size).toBe(0);
  });

  it("refuses an environment name the receipt decoder would reject, before any effect", async () => {
    const context = harness({ environment: "Production DB" });
    const report = await context.deploy();

    expect(report.outcome).toBe("REFUSED");
    expect(context.docker.calls).toEqual([]);
  });

  it("builds argv through the shipped builders, so an assertion is about shipped bytes", async () => {
    const context = harness();
    await context.deploy();

    expect(buildArgv(deployImageTag(ENVIRONMENT, SHA), CONTEXT))
      .toEqual(argvFor(context.docker, "build"));
  });
});

describe("the host argv port handles failed stdin without leaking a child", () => {
  it("finally removes a real temporary store even when the test arm throws", () => {
    const fixture = openRestartableStore();
    expect(existsSync(fixture.path)).toBe(true);
    try {
      expect(() => { try { throw new Error("DRILL_THROW"); } finally { closeStores(); } }).toThrow("DRILL_THROW");
      expect(existsSync(dirname(fixture.path))).toBe(false);
    } finally { closeStores(); }
  });

  it("restores the old route if the receipt id is consumed while reload is in flight", async () => {
    let ready = () => {}; let release = () => {}; let paused = false;
    const arrived = new Promise<void>((resolve) => { ready = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const context = harness({ wrapDocker: (base) => async (args, stdin) => {
      if (args.includes("reload") && !paused) { paused = true; ready(); await wait; }
      return base(args, stdin);
    } });
    const first = context.deploy();
    try {
      await arrived;
      const second = await context.deploy();
      expect(second.receipt?.refusal).toEqual({ code: DEPLOY_BUILD_FAILED, layer: DEPLOY_ENGINE_STAMP,
        detail: "DEPLOY_PROXY_BUSY" });
      release();
      const report = await first;
      expect(report.outcome).toBe("REFUSED");
      expect(report.detail).toContain("DEPLOY_RECEIPT_CONFLICT");
      expect(report.receipt?.refusal).toEqual(second.receipt?.refusal);
      expect(context.docker.state(INCUMBENT)).toBe("HEALTHY");
      expect(context.docker.state(context.candidate)).toBe("REMOVED");
      expect(context.docker.upstream()).toBe(INCUMBENT);
      expect(context.docker.locked()).toBe(false);
    } finally { release(); await first; closeStores(); }
  });
  it.each(["stdin", "timeout"])("waits for close after %s uncertainty", async (failure) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
    });
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
    vi.useFakeTimers();
    const pending = nodeDockerRunner(["exec", "-i", "proxy", "tee", "/etc/caddy/Caddyfile"], PROXY_CONFIG);
    let settled = false;
    void pending.then(() => { settled = true; });
    try {
      expect(spawn).toHaveBeenLastCalledWith("docker", ["exec", "-i", "proxy", "tee", "/etc/caddy/Caddyfile"],
        { shell: false, windowsHide: true });
      if (failure === "stdin") expect(() => child.stdin.emit("error", new Error("pipe closed"))).not.toThrow();
      else await vi.advanceTimersByTimeAsync(DEPLOY_COMMAND_TIMEOUT_MS);
      expect(child.kill).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      child.emit("close", 1);
      expect(await pending).toMatchObject({ code: null,
        stderr: failure === "stdin" ? "\nDEPLOY_STDIN_UNAVAILABLE" : "\nDEPLOY_COMMAND_TIMED_OUT" });
    } finally {
      child.emit("close", null); await pending;
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      vi.useRealTimers(); vi.mocked(spawn).mockReset();
    }
  });
});
