import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { HealthHttpPort } from "../monitoring/health-probe-ring.js";
import { createHealthProbeRing, deriveHealthState, probeEnvironment } from "../monitoring/health-probe-ring.js";
import { deploymentInfrastructureFiles } from "../repository/deployment/deployment-infrastructure-templates.js";
import { PROJECT_ID, closeStores, openStore } from "../review/review-test-fixtures.js";
import { recordDeployReceipt } from "./deploy-ledger.js";
import { createDockerDouble } from "./deploy-ports.js";
import { candidateContainerName, createDeployService } from "./deploy-service.js";

afterEach(closeStores);
const environment = "production", sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`, url = "http://product.example";
/** deriveHealthState calls DOWN only after this many consecutive failures. */
const FAILURES_TO_DOWN = 3;

/**
 * DoD 5. The assertion surface is the LANDED monitoring path — a real probe ring
 * on disk, `probeEnvironment`, and `deriveHealthState` — never an internal flag
 * and never the docker double's own state read directly.
 *
 * The injected HealthHttpPort is the only seam: it answers 200 exactly when the
 * proxy's CURRENT upstream names a container that is actually healthy, so a
 * SUCCESS means the environment really is serving the rolled-back container. A
 * hardcoded 200 would make the recovery assertion unfalsifiable.
 */
function harness() {
  const store = openStore();
  const prior = recordDeployReceipt(store, { projectId: PROJECT_ID, environment, sha, imageDigest: digest,
    decisionId: "original", decidedAt: "2026-09-06T01:00:00.000Z", refusal: null, releaseDecision: null, url });
  if (!prior.ok) throw new Error(prior.code);
  const name = candidateContainerName(environment, sha, "rollback-1");
  // The incumbent is DOWN, not merely absent: this is the outage the rollback answers.
  const docker = createDockerDouble({ proxyConfig: deploymentInfrastructureFiles("", []).get("docker/Caddyfile") ?? "",
    running: { app: "STOPPED" }, imageDigest: digest, health: { [name]: ["HEALTHY"] } });
  const http: HealthHttpPort = async () => docker.state(docker.upstream()) === "HEALTHY" ? 200 : 503;
  const service = createDeployService({ projectId: PROJECT_ID, store, healthBudgetMs: 1, pollMs: 1, sleep: async () => {},
    ports: { build: docker.build, docker: docker.docker, ssh: docker.ssh, transfer: docker.transfer,
      target: () => ({ network: "product", sshTarget: null, url }), releaseDecision: () => null } });
  return { docker, http, name, service, store,
    request: { decisionId: "rollback-1", environment, receiptId: prior.receipt.receiptId } };
}

it("returns the environment to UP through the real probe after a rollback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-rollback-probe-"));
  try {
    const context = harness();
    const ring = createHealthProbeRing(join(directory, "health-probes.sqlite"), PROJECT_ID);
    const signal = new AbortController().signal;
    const probe = () => probeEnvironment({ environment, http: context.http, projectId: PROJECT_ID, ring, signal, store: context.store });
    const state = (): string => {
      const history = ring.read(environment);
      if (!history.ok) throw new Error(history.code);
      return deriveHealthState(history.value);
    };

    // THE OUTAGE FIRST. An arm that only ever observes "UP" would pass against a
    // probe that always succeeds, so the DOWN state is what gives recovery meaning.
    for (let attempt = 0; attempt < FAILURES_TO_DOWN; attempt += 1) {
      const failed = await probe();
      expect(failed.ok && failed.value.status).toBe("FAILURE");
    }
    expect(state()).toBe("DOWN");

    expect((await context.service.rollback(context.request)).outcome).toBe("DEPLOYED");

    const recovered = await probe();
    expect(recovered.ok && recovered.value.status).toBe("SUCCESS");
    expect(state()).toBe("UP");
    // The recovery is the rolled-back container's, not the incumbent's.
    expect(context.docker.upstream()).toBe(context.name);
  } finally {
    rmSync(directory, { force: true, maxRetries: 20, recursive: true, retryDelay: 100 });
  }
});

it("records a probe failure rather than UP while the environment is still down", async () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-rollback-probe-"));
  try {
    const context = harness();
    const ring = createHealthProbeRing(join(directory, "health-probes.sqlite"), PROJECT_ID);
    const result = await probeEnvironment({ environment, http: context.http, projectId: PROJECT_ID, ring,
      signal: new AbortController().signal, store: context.store });
    expect(result.ok && result.value.status).toBe("FAILURE");
    const history = ring.read(environment);
    expect(history.ok && history.value).toHaveLength(1);
    expect(history.ok && deriveHealthState(history.value)).not.toBe("UP");
  } finally {
    rmSync(directory, { force: true, maxRetries: 20, recursive: true, retryDelay: 100 });
  }
});
