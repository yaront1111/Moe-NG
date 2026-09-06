import type { SqliteEventStore } from "@moe/store";

import {
  DEPLOY_BUILD_FAILED, DEPLOY_DOCKER_UNAVAILABLE, DEPLOY_ENGINE_STAMP, DEPLOY_HEALTH_TIMEOUT,
  DEPLOY_TARGET_MISSING, admitDeploySha, admitEnvironmentName, deployImageTag, deployReceiptId,
} from "./deploy-receipt-contracts.js";
import type { DeployReceiptV1, DeployRefusal, DeployRefusalCode } from "./deploy-receipt-contracts.js";
import { createProxyPort, DEPLOY_HEALTH_BUDGET_MS, DEPLOY_HEALTH_POLL_MS, lastStderrLine } from "./deploy-ports.js";
import type { DeployPorts, DeployRunResult, DeployTarget } from "./deploy-ports.js";
import { readDeployReceipt, recordDeployReceipt } from "./deploy-ledger.js";
import { deploymentInfrastructureFiles } from "../repository/deployment/deployment-infrastructure-templates.js";

/** Build a caller-selected sha, health-check the candidate, then switch the public route.
 * Caddy's synchronous reload is the cutover, not mere signal delivery.
 * A proxy-local mkdir lease fences other daemon processes too. Interrupted
 * recovery retains the lease and BOTH containers instead of guessing which
 * one is live. A stale lease requires operator recovery; no automatic steal.
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

/** Decision-scoped name: retries never remove an already-serving candidate. */
export function candidateContainerName(
  environment: string, sha: string, decisionId: string,
): string {
  const decision = decisionId.replace(/[^a-zA-Z0-9]/gu, "").slice(0, 12).toLowerCase();
  return `moe-deploy-${environment}-${sha.slice(0, 12)}-${decision}`;
}

/** The build argv. The tag carries the sha VALUE; every later rollback resolves through it. */
export const buildArgv = (tag: string, context: string): readonly string[] =>
  ["build", "--tag", tag, context];

/** Internal candidate: no public port conflict with the incumbent or proxy. */
export const runCandidateArgv = (
  name: string, network: string, tag: string,
): readonly string[] => ["run", "--detach", "--name", name, "--network", network, tag];

/** Probe the candidate by name: the public URL would prove only the incumbent's health. */
export const healthArgv = (name: string): readonly string[] =>
  ["inspect", "--format", "{{.State.Health.Status}}", name];

const refusal = (code: DeployRefusalCode, detail: string): DeployRefusal =>
  ({ code, detail, layer: DEPLOY_ENGINE_STAMP });

const nodeSleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

type ProxyPort = ReturnType<typeof createProxyPort>;
interface ProxyLease { readonly proxy: string; readonly incumbent: string; readonly config: string; readonly upstream: string }
const oneName = (result: DeployRunResult): string | null =>
  result.code === 0 && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(result.stdout.trim()) ? result.stdout.trim() : null;
const proxyBody = (text: string): string => text.split(/\r?\n/u).map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#")).join("\n");
const generatedProxyBody = proxyBody(deploymentInfrastructureFiles("", []).get("docker/Caddyfile") ?? "");

async function acquireProxy(port: ProxyPort): Promise<ProxyLease | string> {
  const proxy = oneName(await port.discover("proxy"));
  if (proxy === null) return "DEPLOY_PROXY_MISSING_OR_AMBIGUOUS";
  if ((await port.lock(proxy)).code !== 0) return "DEPLOY_PROXY_BUSY";
  let acquired = false;
  try {
    const read = await port.read(proxy);
    // Match the rewrite's horizontal grammar exactly: Unicode indentation must
    // never be admitted then left unchanged while its backend is retired.
    const matches = [...read.stdout.matchAll(/^[\t ]*reverse_proxy ([a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}):3000[\t ]*$/gmu)];
    const upstream = matches.length === 1 ? matches[0]?.[1] : undefined;
    if (read.code !== 0 || upstream === undefined) return "DEPLOY_PROXY_CONFIG_UNSUPPORTED";
    // Custom routes may leave public traffic on another backend/listener. Only
    // the generated topology is ours to flip, not arbitrary valid Caddy syntax.
    if (proxyBody(read.stdout).replace(`reverse_proxy ${upstream}:3000`, "reverse_proxy app:3000") !== generatedProxyBody) {
      return "DEPLOY_PROXY_CONFIG_UNSUPPORTED";
    }
    // `app` is a compose DNS alias, NOT its generated container name.
    const incumbent = upstream === "app" ? oneName(await port.discover("app")) : upstream;
    if (incumbent === null) return "DEPLOY_PROXY_INCUMBENT_MISSING";
    acquired = true;
    return { proxy, incumbent, config: read.stdout, upstream };
  } finally { if (!acquired) await port.unlock(proxy); }
}

/** No tool output/config bytes enter a receipt: phase literals are stable and credential-free. */
async function restoreProxy(port: ProxyPort, lease: ProxyLease): Promise<boolean> {
  return (await port.write(lease.proxy, lease.config)).code === 0 && (await port.reload(lease.proxy)).code === 0;
}

async function flipProxy(port: ProxyPort, lease: ProxyLease, name: string) {
  const next = lease.config.replace(/^([\t ]*reverse_proxy )[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}(:3000[\t ]*)$/mu,
    (_line, prefix: string, suffix: string) => `${prefix}${name}${suffix}`);
  const written = await port.write(lease.proxy, next);
  const reloaded = written.code === 0 ? await port.reload(lease.proxy) : written;
  // Killing a Docker CLI does not prove its remote exec stopped. Never race a
  // late write/reload with rollback and candidate removal after a timeout.
  if (reloaded.code === null) return { detail: "DEPLOY_PROXY_RECOVERY_REQUIRED", recoveryRequired: true };
  const detail = written.code !== 0 ? "DEPLOY_PROXY_WRITE_FAILED"
    : reloaded.code !== 0 ? "DEPLOY_PROXY_RELOAD_FAILED" : null;
  if (detail === null) return { detail, recoveryRequired: false };
  // Restore a definitively finished failure and acknowledge the old config
  // before deleting the candidate. Failed recovery leaves both alive.
  const recovered = await restoreProxy(port, lease);
  return { detail: recovered ? detail : "DEPLOY_PROXY_RECOVERY_REQUIRED", recoveryRequired: !recovered };
}

function readReplay(config: DeployServiceConfig, request: DeployRequest): DeployReport | null {
  const { environment, sha } = request;
  const historical = readDeployReceipt(config.store, config.projectId,
    deployReceiptId(config.projectId, environment, request.decisionId));
  if (historical.ok) {
    const receipt = historical.receipt;
    return receipt.sha === sha
      ? { outcome: receipt.outcome, detail: `replayed ${receipt.outcome}`, environment, receipt }
      : { outcome: "REFUSED", detail: "DEPLOY_DECISION_REPLAY_MISMATCH", environment, receipt: null };
  }
  return historical.code === "DEPLOY_RECEIPT_NOT_FOUND" ? null
    : { outcome: "REFUSED", detail: historical.code, environment, receipt: null };
}

export function createDeployService(config: DeployServiceConfig) {
  const clock = config.clock ?? (() => new Date().toISOString());
  const sleep = config.sleep ?? nodeSleep;
  const budget = config.healthBudgetMs ?? DEPLOY_HEALTH_BUDGET_MS;
  const poll = config.pollMs ?? DEPLOY_HEALTH_POLL_MS;
  const { ports } = config;

  /** One seam for both targets: a remote call is the same docker argv over ssh. */
  const run = async (target: DeployTarget, args: readonly string[], stdin?: string): Promise<DeployRunResult> => {
    try {
      const result = await (target.sshTarget === null ? ports.docker(args, stdin) : ports.ssh([target.sshTarget, "docker", ...args], stdin));
      return target.sshTarget !== null && result.code === 255 ? { ...result, code: null } : result;
    } catch { return { code: null, stderr: "DEPLOY_EFFECT_UNAVAILABLE", stdout: "" }; }
  };

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
    const historical = readReplay(config, request);
    if (historical !== null) return historical;
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
      const receipt = record(request, target, null, refused, releaseDecision);
      if (receipt !== null && receipt.sha !== sha) return report("REFUSED", "DEPLOY_DECISION_REPLAY_MISMATCH", null);
      return report(receipt?.outcome ?? "REFUSED", receipt?.outcome === "DEPLOYED" ? "replayed DEPLOYED" : code, receipt);
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
    const proxyPort = createProxyPort((args, stdin) => run(target, args, stdin), target.network);
    const lease = await acquireProxy(proxyPort);
    if (typeof lease === "string") return refuse(target, DEPLOY_BUILD_FAILED, lease);
    let keepLock = false; let keepCandidate = false; let candidateStarted = false;
    const name = candidateContainerName(environment, sha, request.decisionId);
    try {
      const replay = readReplay(config, request);
      if (replay !== null) return replay;
      const tag = deployImageTag(environment, sha);
      const built = await run(target, buildArgv(tag, request.context));
      // docker's OWN last stderr line: a generic message is undiagnosable from a receipt weeks later.
      if (built.code !== 0) return refuse(target, DEPLOY_BUILD_FAILED, lastStderrLine(built.stderr));
      if (target.sshTarget !== null) {
        const moved = await ports.transfer(tag, target.sshTarget);
        if (moved.code !== 0) return refuse(target, DEPLOY_BUILD_FAILED, lastStderrLine(moved.stderr));
      }
      candidateStarted = true;
      const started = await startCandidate(target, name, tag);
      if (started.code !== 0) {
        return refuse(target, DEPLOY_BUILD_FAILED, lastStderrLine(started.stderr));
      }
      const healthy = await awaitHealthy(target, name);
      if (!healthy) {
        return refuse(target, DEPLOY_HEALTH_TIMEOUT, `${name} did not report healthy within ${String(budget)}ms`);
      }
      const inspected = await run(target, ["image", "inspect", "--format", "{{.Id}}", tag]);
      const digest = inspected.stdout.trim();
      if (inspected.code !== 0 || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
        return refuse(target, DEPLOY_BUILD_FAILED, "DEPLOY_IMAGE_DIGEST_UNAVAILABLE");
      }
      const flipped = await flipProxy(proxyPort, lease, name);
      keepLock = flipped.recoveryRequired;
      keepCandidate = flipped.detail === null || flipped.recoveryRequired;
      if (flipped.detail !== null) return refuse(target, DEPLOY_BUILD_FAILED, flipped.detail);
      // A concurrent same-decision BUSY refusal may have consumed this receipt id.
      // Do not retire the incumbent or claim success behind a conflicting receipt.
      const receipt = record(request, target, digest, null, releaseDecision);
      if (receipt === null || receipt.outcome !== "DEPLOYED" || receipt.sha !== sha) {
        keepLock = !(await restoreProxy(proxyPort, lease));
        keepCandidate = keepLock;
        return report("REFUSED", keepLock ? "DEPLOY_PROXY_RECOVERY_REQUIRED" : "DEPLOY_RECEIPT_CONFLICT", receipt);
      }
      // Caddy /load is synchronous and zero-downtime; a signal is NOT sufficient.
      // https://caddyserver.com/docs/api#post-load
      const stopped = lease.incumbent === name ? null : await run(target, ["stop", lease.incumbent]);
      const cleanup = stopped !== null && stopped.code !== 0 ? "; DEPLOY_INCUMBENT_STOP_FAILED" : "";
      return report("DEPLOYED", `${name} healthy at ${tag}${cleanup}`, receipt);
    } finally {
      if (candidateStarted && !keepCandidate && lease.incumbent !== name) await run(target, ["rm", "--force", name]);
      if (!keepLock) await proxyPort.unlock(lease.proxy);
    }
  };

  return Object.freeze({ deploy });
}
