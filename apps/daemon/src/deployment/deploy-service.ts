import type { SqliteEventStore } from "@moe/store";

import {
  DEPLOY_BUILD_FAILED, DEPLOY_DOCKER_UNAVAILABLE, DEPLOY_ENGINE_STAMP, DEPLOY_HEALTH_TIMEOUT,
  DEPLOY_TARGET_MISSING, admitDeploySha, admitEnvironmentName, deployImageTag,
} from "./deploy-receipt-contracts.js";
import type { DeployReceiptV1, DeployRefusal, DeployRefusalCode } from "./deploy-receipt-contracts.js";
import { DEPLOY_HEALTH_BUDGET_MS, DEPLOY_HEALTH_POLL_MS, lastStderrLine } from "./deploy-ports.js";
import type { DeployPorts, DeployRunResult, DeployTarget } from "./deploy-ports.js";
import { recordDeployReceipt } from "./deploy-ledger.js";

/**
 * The deploy effect: build the image at a landed sha, put a candidate beside
 * whatever is already running, and prove the CANDIDATE is healthy before
 * calling the deploy done.
 *
 * Nothing here chooses an environment, a sha, or a moment — the caller names
 * both and the ports do the work. One receipt is recorded per deploy.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: it does not move traffic and it
 * does not stop the incumbent on the success path. The switch point does not
 * exist in the shipped infrastructure yet; adding one is
 * task-db63dacc7cbe49cab9826e9b49c8669f, which depends on this module. The seam
 * where it attaches is marked below.
 */

export const PRODUCTION_ENVIRONMENT = "production" as const;
/** The exact wording a production deploy carries when the goal has no decision. */
export const NO_RELEASE_DECISION_NOTE = "no release decision" as const;

export interface DeployRequest {
  /** The docker build context: the workspace holding the generated Dockerfile. */
  readonly context: string;
  readonly decisionId: string;
  readonly environment: string;
  /** The LANDED sha. It becomes the image tag, verbatim. */
  readonly sha: string;
}

export interface DeployServiceConfig {
  readonly clock?: () => string;
  readonly healthBudgetMs?: number;
  readonly pollMs?: number;
  readonly ports: DeployPorts;
  readonly projectId: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly store: SqliteEventStore;
}

export interface DeployReport {
  readonly detail: string;
  readonly environment: string;
  readonly outcome: "DEPLOYED" | "REFUSED";
  readonly receipt: DeployReceiptV1 | null;
}

/**
 * The candidate's name. Deterministic in the deploy DECISION, not merely in the
 * sha: the same sha deployed twice is two decisions and therefore two
 * candidates, so neither deploy can destroy the other's container. A REPLAY of
 * one decision reproduces one name, and that collision is handled by REUSE
 * below rather than by removing something that may already be serving.
 */
export function candidateContainerName(
  environment: string, sha: string, decisionId: string,
): string {
  const decision = decisionId.replace(/[^a-zA-Z0-9]/gu, "").slice(0, 12).toLowerCase();
  return `moe-deploy-${environment}-${sha.slice(0, 12)}-${decision}`;
}

/** The build argv. The tag carries the sha VALUE; every later rollback resolves through it. */
export const buildArgv = (tag: string, context: string): readonly string[] =>
  ["build", "--tag", tag, context];

/**
 * The candidate publishes NO host port: it joins the network internally and is
 * reachable by name. That is what lets it start beside the incumbent instead of
 * fighting it for a bound port.
 */
export const runCandidateArgv = (
  name: string, network: string, tag: string,
): readonly string[] => ["run", "--detach", "--name", name, "--network", network, tag];

/**
 * THE PROBE NAMES THE CANDIDATE, and that is the whole point. A probe addressed
 * at the environment's public url would be answered by the OLD container, so
 * every deploy would "pass" health instantly while proving nothing about the
 * image just built.
 */
export const healthArgv = (name: string): readonly string[] =>
  ["inspect", "--format", "{{.State.Health.Status}}", name];

const refusal = (code: DeployRefusalCode, detail: string): DeployRefusal =>
  ({ code, detail, layer: DEPLOY_ENGINE_STAMP });

const nodeSleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

export function createDeployService(config: DeployServiceConfig) {
  const clock = config.clock ?? (() => new Date().toISOString());
  const sleep = config.sleep ?? nodeSleep;
  const budget = config.healthBudgetMs ?? DEPLOY_HEALTH_BUDGET_MS;
  const poll = config.pollMs ?? DEPLOY_HEALTH_POLL_MS;
  const { ports } = config;

  /** One seam for both targets: a remote call is the same docker argv over ssh. */
  const run = (target: DeployTarget, args: readonly string[]): Promise<DeployRunResult> =>
    target.sshTarget === null
      ? ports.docker(args)
      : ports.ssh([target.sshTarget, "docker", ...args]);

  const record = (
    request: DeployRequest, target: DeployTarget | null,
    imageDigest: string | null, refused: DeployRefusal | null, releaseDecision: string | null,
  ): DeployReceiptV1 | null => {
    const result = recordDeployReceipt(config.store, {
      decidedAt: clock(), decisionId: request.decisionId, environment: request.environment,
      imageDigest, projectId: config.projectId, refusal: refused, releaseDecision,
      sha: request.sha, url: target?.url ?? null,
    });
    return result.ok ? result.receipt : null;
  };

  /**
   * Polls the CANDIDATE until docker calls it healthy or the budget expires.
   * The budget exceeds docker's own worst case to `unhealthy` (start-period
   * plus retries x interval); a shorter one would refuse before docker had
   * decided anything.
   */
  const awaitHealthy = async (target: DeployTarget, name: string): Promise<boolean> => {
    for (let waited = 0; waited <= budget; waited += poll) {
      const probe = await run(target, healthArgv(name));
      if (probe.code === 0 && probe.stdout.trim().toLowerCase() === "healthy") return true;
      if (waited + poll > budget) break;
      await sleep(poll);
    }
    return false;
  };

  /** Reuses an existing container of this name rather than recreating it: a replay, not a race. */
  const startCandidate = async (
    target: DeployTarget, name: string, tag: string,
  ): Promise<DeployRunResult> => {
    const existing = await run(target, healthArgv(name));
    if (existing.code === 0) return existing;
    return run(target, runCandidateArgv(name, target.network, tag));
  };

  const deploy = async (request: DeployRequest): Promise<DeployReport> => {
    const { environment, sha } = request;
    const releaseDecision = ports.releaseDecision(environment, sha);
    // DoD-7: a READ. It neither invents an approval nor refuses for the lack of
    // one — deciding a release is Gate 3's authority, not this module's.
    const citation = environment !== PRODUCTION_ENVIRONMENT ? ""
      : releaseDecision === null
        ? `; ${NO_RELEASE_DECISION_NOTE}`
        : `; cites release decision ${releaseDecision}`;
    const report = (
      outcome: "DEPLOYED" | "REFUSED", detail: string, receipt: DeployReceiptV1 | null,
    ): DeployReport => ({ detail: `${detail}${citation}`, environment, outcome, receipt });
    const refuse = (
      target: DeployTarget | null, code: DeployRefusalCode, detail: string,
    ): DeployReport => {
      const refused = refusal(code, detail);
      return report("REFUSED", code, record(request, target, null, refused, releaseDecision));
    };

    // BEFORE ANY EFFECT: a sha or environment the receipt decoder would refuse
    // must not reach docker. Otherwise the container would start and the
    // receipt would fail to record — an effect with no durable trace, which is
    // the one outcome worse than a refusal.
    if (admitDeploySha(sha) === null || admitEnvironmentName(environment) === null) {
      return report("REFUSED", "deploy request is not a landed sha for a named environment", null);
    }
    const target = ports.target(environment);
    if (target === null) {
      return refuse(null, DEPLOY_TARGET_MISSING, `no deploy target bound for ${environment}`);
    }
    const version = await run(target, ["version", "--format", "{{.Server.Version}}"]);
    if (version.code !== 0) {
      return refuse(target, DEPLOY_DOCKER_UNAVAILABLE, lastStderrLine(version.stderr));
    }
    const tag = deployImageTag(environment, sha);
    const built = await run(target, buildArgv(tag, request.context));
    // docker's OWN last stderr line: a generic message is undiagnosable from a receipt weeks later.
    if (built.code !== 0) return refuse(target, DEPLOY_BUILD_FAILED, lastStderrLine(built.stderr));
    if (target.sshTarget !== null) {
      const moved = await ports.transfer(tag, target.sshTarget);
      if (moved.code !== 0) return refuse(target, DEPLOY_BUILD_FAILED, lastStderrLine(moved.stderr));
    }
    const name = candidateContainerName(environment, sha, request.decisionId);
    const started = await startCandidate(target, name, tag);
    if (started.code !== 0) {
      return refuse(target, DEPLOY_BUILD_FAILED, lastStderrLine(started.stderr));
    }
    let healthy = false;
    try {
      healthy = await awaitHealthy(target, name);
    } finally {
      // THE FAILURE PATH TIDIES UP IN A `finally`, not after the assertions: a
      // refusal that leaks a stray container leaves the environment as
      // undefined as a half-deploy would. The INCUMBENT is never touched here —
      // it keeps running, which is what makes the refused state a defined one.
      if (!healthy) await run(target, ["rm", "--force", name]);
    }
    if (!healthy) {
      return refuse(target, DEPLOY_HEALTH_TIMEOUT, `${name} did not report healthy within ${String(budget)}ms`);
    }
    const inspected = await run(target, ["image", "inspect", "--format", "{{.Id}}", tag]);
    const digest = inspected.stdout.trim();
    // === THE FLIP SEAM ===
    // The candidate is healthy and the incumbent is still running. Moving
    // traffic and retiring the incumbent attaches HERE, and belongs to
    // task-db63dacc7cbe49cab9826e9b49c8669f; this module stops at a healthy
    // candidate and a recorded receipt.
    return report("DEPLOYED", `${name} healthy at ${tag}`,
      record(request, target, digest, null, releaseDecision));
  };

  return Object.freeze({ deploy });
}
