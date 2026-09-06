import { afterEach, describe, expect, it } from "vitest";

import { closeStores, openStore } from "../review/review-test-fixtures.js";
import {
  DEPLOY_BUILD_FAILED, DEPLOY_DOCKER_UNAVAILABLE, DEPLOY_ENGINE_STAMP, DEPLOY_HEALTH_TIMEOUT,
  DEPLOY_TARGET_MISSING, deployImageTag,
} from "./deploy-receipt-contracts.js";
import {
  createDockerDouble, dockerSaveArgv, sshDockerLoadArgv,
} from "./deploy-ports.js";
import type { DockerDouble, DockerDoubleOptions, DeployTarget } from "./deploy-ports.js";
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

const PROJECT = "project-review-1";
const ENVIRONMENT = "production";
const STAGING = "staging";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const CONTEXT = "/workspace/app";
const INCUMBENT = "app";
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
} = {}): Harness {
  const environment = options.environment ?? ENVIRONMENT;
  const sha = options.sha ?? SHA;
  const decisionId = options.decisionId ?? "decision-1";
  const candidate = candidateContainerName(environment, sha, decisionId);
  const docker = createDockerDouble({
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
      docker: docker.docker,
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
    const replay = await context.deploy();

    expect(replay.outcome).toBe("DEPLOYED");
    const state = readDeployLedger(context.store, PROJECT).get(ENVIRONMENT);
    // ONE row, not two: the receipt id is a pure function of the decision.
    expect(state?.receipts).toHaveLength(1);
    expect(state?.current.sha).toBe(SHA);
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

describe("this module stops at a healthy candidate", () => {
  it("never stops or removes the incumbent on the success path", async () => {
    const context = harness();
    const report = await context.deploy();

    expect(report.outcome).toBe("DEPLOYED");
    // Moving traffic and retiring the incumbent is task-db63dacc7cbe49cab9826e9b49c8669f.
    expect(context.docker.state(INCUMBENT)).toBe("HEALTHY");
    expect(context.docker.calls.filter((call) => call[0] === "stop")).toEqual([]);
    expect(context.docker.calls.filter((call) => call[0] === "rm")).toEqual([]);
    expect(context.docker.serving()).toContain(INCUMBENT);
    expect(context.docker.serving()).toContain(context.candidate);
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
