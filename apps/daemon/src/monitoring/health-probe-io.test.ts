import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { expect, it } from "vitest";
import { recordDeployReceipt } from "../deployment/deploy-ledger.js";
import { DEPLOY_ENGINE_PRINCIPAL_ID, DEPLOY_RECEIPT_COMMAND_KIND, deployAggregateId, deployReceiptId }
  from "../deployment/deploy-receipt-contracts.js";
import { HEALTH_PROBE_VERSION } from "./health-probe-contracts.js";
import type { HealthProbe } from "./health-probe-contracts.js";
import { createHealthProbeJob, createHealthProbeRing, probeEnvironment } from "./health-probe-ring.js";
import type { HealthHttpPort, HealthProbeOptions, HealthProbeRing } from "./health-probe-ring.js";

const PROJECT = "project-probe-io";
const ENVIRONMENT = "preview";
const SHA = "a".repeat(40);
const AT = "2026-09-06T03:00:00.000Z";
const SAMPLE: HealthProbe = Object.freeze({ version: HEALTH_PROBE_VERSION, environment: ENVIRONMENT,
  sha: SHA, status: "SUCCESS", latencyMs: 1, at: AT });
const refused = (code: string) => ({ ok: false, code, layer: "DAEMON_INGRESS" });
interface Fixture { readonly store: SqliteEventStore; readonly ring: HealthProbeRing; readonly path: string }

async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const temporaryRoot = realpathSync(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, "moe-probe-io-"));
  const store = SqliteEventStore.openForProject(join(directory, "events.sqlite"), PROJECT);
  const path = join(directory, "events.sqlite.health.sqlite");
  try { await body({ store, path, ring: createHealthProbeRing(path, PROJECT) }); }
  finally {
    store.close();
    if (dirname(resolve(directory)) !== temporaryRoot) throw new Error("unsafe probe fixture cleanup");
    rmSync(directory, { force: true, recursive: true });
  }
}

function deploy(store: SqliteEventStore, url: string | null, environment = ENVIRONMENT, decisionId = "first"): void {
  const result = recordDeployReceipt(store, { projectId: PROJECT, environment, decisionId,
    sha: SHA, imageDigest: `sha256:${"b".repeat(64)}`, refusal: null, releaseDecision: null,
    url, decidedAt: AT });
  expect(result.ok).toBe(true);
}

function options(fixture: Fixture, extra: Partial<HealthProbeOptions> = {}): HealthProbeOptions {
  return { ...fixture, projectId: PROJECT, environment: ENVIRONMENT,
    signal: new AbortController().signal, clock: () => AT, ...extra };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly finish: (value: T) => void } {
  let finish: (value: T) => void = () => { throw new Error("deferred not initialized"); };
  const promise = new Promise<T>((done) => { finish = done; });
  return { promise, finish };
}

it("uses the real default HTTP port at /health and retains no response body", async () => {
  await withFixture(async (fixture) => {
    const requests: string[] = [];
    const responseBody = "response-content-is-not-a-probe-observation";
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(responseBody);
    });
    try {
      await new Promise<void>((done, reject) => {
        server.once("error", reject); server.listen(0, "127.0.0.1", done);
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("HTTP server did not bind");
      deploy(fixture.store, `http://127.0.0.1:${String(address.port)}/product/path?ignored=1`);
      const result = await probeEnvironment(options(fixture));
      expect(requests).toEqual(["/health"]);
      expect(result).toEqual({ ok: true, value: { ...SAMPLE, latencyMs: expect.any(Number) } });
      if (!result.ok) throw new Error(result.code);
      expect(Number.isSafeInteger(result.value.latencyMs) && result.value.latencyMs >= 0).toBe(true);
      expect(fixture.ring.read(ENVIRONMENT)).toEqual({ ok: true, value: [result.value] });
      expect(Object.keys(result.value).sort()).toEqual(["at", "environment", "latencyMs", "sha", "status", "version"]);
      expect(readFileSync(fixture.path).includes(Buffer.from(responseBody))).toBe(false);
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    }
  });
});

it.each(["http-500", "synchronous-throw", "rejected-promise"] as const)("records FAILURE for %s", async (mode) => {
  await withFixture(async (fixture) => {
    deploy(fixture.store, "http://127.0.0.1:43210");
    let calls = 0;
    const http: HealthHttpPort = () => {
      calls += 1;
      if (mode === "synchronous-throw") throw new Error("unretained transport diagnostic");
      return mode === "rejected-promise" ? Promise.reject(new Error("unretained rejection")) : Promise.resolve(500);
    };
    const result = await probeEnvironment(options(fixture, { http }));
    expect(calls).toBe(1);
    expect(result).toEqual({ ok: true, value: { ...SAMPLE, status: "FAILURE", latencyMs: expect.any(Number) } });
    if (!result.ok) throw new Error(result.code);
    expect(fixture.ring.read(ENVIRONMENT)).toEqual({ ok: true, value: [result.value] });
    expect(Object.keys(result.value).sort()).toEqual(["at", "environment", "latencyMs", "sha", "status", "version"]);
  });
});

it.each(["http://operator@127.0.0.1/product", "file:///not-a-network-target", "not a URL"])(
  "refuses invalid probe URL without HTTP: case %#", async (url) => {
    await withFixture(async (fixture) => {
      deploy(fixture.store, url);
      let calls = 0;
      const result = await probeEnvironment(options(fixture, { http: async () => { calls += 1; return 200; } }));
      expect([result, calls]).toEqual([refused("PROBE_URL_INVALID"), 0]);
      expect(fixture.ring.read(ENVIRONMENT)).toEqual({ ok: true,
        value: [{ ...SAMPLE, status: "UNPROBEABLE", latencyMs: expect.any(Number) }] });
    });
  },
);

it.each(["pre-aborted", "no-receipt"] as const)("writes no history when %s", async (mode) => {
  await withFixture(async (fixture) => {
    const controller = new AbortController();
    if (mode === "pre-aborted") { deploy(fixture.store, "http://127.0.0.1:43210"); controller.abort(); }
    let calls = 0;
    const result = await probeEnvironment(options(fixture, {
      signal: controller.signal, http: async () => { calls += 1; return 200; },
    }));
    expect(result).toEqual(refused(mode === "pre-aborted" ? "PROBE_ABORTED" : "PROBE_RECEIPT_MISSING"));
    expect([calls, existsSync(fixture.path)]).toEqual([0, false]);
    expect(fixture.ring.read(ENVIRONMENT)).toEqual({ ok: true, value: [] });
  });
});

it("does not attribute an awaited response to a newer deploy receipt", async () => {
  await withFixture(async (fixture) => {
    deploy(fixture.store, "http://127.0.0.1:43210");
    const reply = deferred<number>();
    let calls = 0;
    const pending = probeEnvironment(options(fixture, { http: () => { calls += 1; return reply.promise; } }));
    expect(calls).toBe(1);
    deploy(fixture.store, "http://127.0.0.1:43211", ENVIRONMENT, "newer");
    reply.finish(200);
    expect(await pending).toEqual(refused("PROBE_RECEIPT_CHANGED"));
    expect(fixture.ring.read(ENVIRONMENT)).toEqual({ ok: true, value: [] });
    expect(existsSync(fixture.path)).toBe(false);
  });
});

it("probes later environments after a missing URL and reports only the stable failure code", async () => {
  await withFixture(async (fixture) => {
    deploy(fixture.store, null);
    deploy(fixture.store, "http://127.0.0.1:43210/app", "production");
    const requests: string[] = [];
    const job = createHealthProbeJob({ store: fixture.store, projectId: PROJECT, clock: () => AT,
      http: async (url) => { requests.push(url); return 204; } });
    await expect(job(new AbortController().signal)).rejects.toThrowError(/^PROBE_URL_MISSING$/u);
    expect(requests).toEqual(["http://127.0.0.1:43210/health"]);
    expect(fixture.ring.read(ENVIRONMENT)).toEqual({ ok: true,
      value: [{ ...SAMPLE, status: "UNPROBEABLE", latencyMs: expect.any(Number) }] });
    expect(fixture.ring.read("production")).toEqual({ ok: true,
      value: [{ ...SAMPLE, environment: "production", latencyMs: expect.any(Number) }] });
  });
});

it("leaves no post-abort job writes when an HTTP callback completes late", async () => {
  await withFixture(async (fixture) => {
    deploy(fixture.store, "http://127.0.0.1:43210");
    const controller = new AbortController();
    const reply = deferred<number>();
    let calls = 0;
    const job = createHealthProbeJob({ store: fixture.store, projectId: PROJECT,
      http: () => { calls += 1; return reply.promise; } });
    const pending = job(controller.signal);
    expect(calls).toBe(1);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
    reply.finish(200);
    await Promise.resolve();
    expect(fixture.ring.read(ENVIRONMENT)).toEqual({ ok: true, value: [] });
    expect(existsSync(fixture.path)).toBe(false);
  });
});

const malformed: readonly [string, unknown][] = [
  ["null", null], ["array", []], ["extra field", { ...SAMPLE, extra: true }],
  ["version", { ...SAMPLE, version: "unknown/1" }], ["sha", { ...SAMPLE, sha: "bad" }],
  ["status", { ...SAMPLE, status: "UP" }], ["environment", { ...SAMPLE, environment: "../foreign" }],
  ["latency negative", { ...SAMPLE, latencyMs: -1 }], ["latency fractional", { ...SAMPLE, latencyMs: 0.5 }],
  ["latency infinite", { ...SAMPLE, latencyMs: Infinity }], ["latency NaN", { ...SAMPLE, latencyMs: NaN }],
  ["timestamp", { ...SAMPLE, at: "not a timestamp" }], ["symbol key", { ...SAMPLE, [Symbol("extra")]: true }],
];

it.each(malformed)("rejects malformed append before creating a sidecar: %s", async (_name, input) => {
  await withFixture(async (fixture) => {
    expect(fixture.ring.append(input as HealthProbe)).toEqual(refused("PROBE_RECORD_INVALID"));
    expect(existsSync(fixture.path)).toBe(false);
  });
});

it("rejects an accessor without evaluating it or creating a sidecar", async () => {
  await withFixture(async (fixture) => {
    let calls = 0;
    const input: unknown = Object.defineProperty({ ...SAMPLE }, "at", {
      enumerable: true, get: () => { calls += 1; return AT; },
    });
    expect(fixture.ring.append(input as HealthProbe)).toEqual(refused("PROBE_RECORD_INVALID"));
    expect([calls, existsSync(fixture.path)]).toEqual([0, false]);
  });
});

function appendUnverifiableTip(store: SqliteEventStore, mode: "malformed-receipt" | "unknown-tip"): void {
  const aggregateId = deployAggregateId(PROJECT, ENVIRONMENT), encoder = new TextEncoder();
  const expectedVersion = store.getAggregateVersion(aggregateId);
  if (mode === "unknown-tip") {
    const result = store.commit({ aggregateId, commandId: "unknown-tip", expectedVersion, committedAt: AT,
      commandBytes: encoder.encode("{}"),
      events: [{ eventId: "unknown-tip-event", eventType: "UnknownDeploymentEvent", payload: encoder.encode("{}") }] });
    expect(result.disposition).toBe("COMMITTED");
    return;
  }
  const receiptId = deployReceiptId(PROJECT, ENVIRONMENT, "malformed-newer");
  const result = store.commitExpectedVersionDecision({
    commandKind: DEPLOY_RECEIPT_COMMAND_KIND, committedResultBytes: encoder.encode("{"),
    correlationId: "malformed-newer", decidedAt: AT, expectedVersion, targetAggregateId: aggregateId,
    key: { commandId: receiptId, principalId: DEPLOY_ENGINE_PRINCIPAL_ID, projectId: PROJECT },
    requestBytes: encoder.encode("{}"), events: [{ eventId: `${receiptId}-DeployRecorded`,
      eventType: "EnvironmentDeployed", payload: encoder.encode(JSON.stringify({
        environment: ENVIRONMENT, outcome: "DEPLOYED", receiptId, sha: SHA,
      })) }],
  });
  expect(result.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
}

it.each(["malformed-receipt", "unknown-tip"] as const)("refuses an unverifiable deployment tip before HTTP: %s", async (mode) => {
  await withFixture(async (fixture) => {
    deploy(fixture.store, "http://127.0.0.1:43210");
    appendUnverifiableTip(fixture.store, mode);
    let calls = 0;
    const result = await probeEnvironment(options(fixture, { http: async () => { calls++; return 200; } }));
    expect([result.ok, calls]).toEqual([false, 0]);
    expect(result).toEqual(refused("PROBE_DEPLOYMENT_UNVERIFIED"));
    expect(fixture.ring.read(ENVIRONMENT)).toEqual({ ok: true, value: [] });
    expect(existsSync(fixture.path)).toBe(false);
  });
});

it.each(["malformed-receipt", "unknown-tip"] as const)("rejects a deployment tip corrupted during HTTP: %s", async (mode) => {
  await withFixture(async (fixture) => {
    deploy(fixture.store, "http://127.0.0.1:43210");
    const reply = deferred<number>();
    let calls = 0;
    const pending = probeEnvironment(options(fixture, { http: () => { calls++; return reply.promise; } }));
    expect(calls).toBe(1);
    appendUnverifiableTip(fixture.store, mode);
    reply.finish(200);
    expect(await pending).toEqual(refused("PROBE_RECEIPT_CHANGED"));
    expect(fixture.ring.read(ENVIRONMENT)).toEqual({ ok: true, value: [] });
    expect(existsSync(fixture.path)).toBe(false);
  });
});
