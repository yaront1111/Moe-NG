import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteEventStore } from "@moe/store";
import { expect, it } from "vitest";
import { HEALTH_FAILURE_THRESHOLD, HEALTH_PROBE_RING_LIMIT, HEALTH_PROBE_VERSION } from "./health-probe-contracts.js";
import type { HealthProbe } from "./health-probe-contracts.js";
import { recordDeployReceipt } from "../deployment/deploy-ledger.js";

const observation = (n: number, environment = "preview", status: HealthProbe["status"] = "SUCCESS"): HealthProbe => ({
  version: HEALTH_PROBE_VERSION, environment, sha: n.toString(16).padStart(40, "0"),
  status, latencyMs: n, at: new Date(1_700_000_000_000 + n).toISOString(),
});

async function subject(): Promise<typeof import("./health-probe-ring.js")> {
  const path = "./health-probe-ring.js";
  const module = await import(path).catch(() => null) as typeof import("./health-probe-ring.js") | null;
  expect(module, "the production bounded ring must exist").not.toBeNull();
  if (module === null) throw new Error("missing bounded ring");
  return module;
}

function directory(): string { return mkdtempSync(join(tmpdir(), "moe-health-ring-")); }

it("publishes bounded probe contracts and the stable missing URL refusal", async () => {
  const path = "./health-probe-contracts.js";
  const contract: unknown = await import(path).catch(() => null);
  expect(contract).toMatchObject({
    HEALTH_PROBE_VERSION: "moe-health-probe/1",
    HEALTH_PROBE_RING_LIMIT: 1440,
    HEALTH_FAILURE_THRESHOLD: 3,
    PROBE_URL_MISSING: "PROBE_URL_MISSING",
  });
});

it("physically evicts the oldest samples per environment without changing the event store", async () => {
  const { createHealthProbeRing } = await subject();
  const root = directory();
  const main = join(root, "events.sqlite");
  const store = SqliteEventStore.openForProject(main, "project-health");
  const marker = new TextEncoder().encode("{}");
  store.commit({ aggregateId: "marker", commandId: "marker", commandBytes: marker,
    committedAt: "2026-09-06T00:00:00.000Z", expectedVersion: 0,
    events: [{ eventId: "marker", eventType: "Marker", payload: marker }] });
  const rawMain = new DatabaseSync(main);
  const before = rawMain.prepare("SELECT COUNT(*) AS n FROM domain_events").get()?.n;
  expect(before).toBe(1);
  try {
    const ring = createHealthProbeRing(`${main}.health.sqlite`, "project-health");
    expect(ring.append(observation(1, "production"))).toMatchObject({ ok: true });
    for (let n = 1; n <= HEALTH_PROBE_RING_LIMIT; n++) expect(ring.append(observation(n))).toMatchObject({ ok: true });
    expect(ring.read("preview")).toMatchObject({ ok: true, value: expect.any(Array) });
    const atBound = ring.read("preview");
    if (!atBound.ok) throw new Error(atBound.code);
    expect(atBound.value).toHaveLength(HEALTH_PROBE_RING_LIMIT);
    expect(atBound.value[0]).toEqual(observation(1));
    expect(ring.append(observation(HEALTH_PROBE_RING_LIMIT + 1))).toMatchObject({ ok: true });
    const after = ring.read("preview");
    if (!after.ok) throw new Error(after.code);
    expect(after.value).toHaveLength(HEALTH_PROBE_RING_LIMIT);
    expect(after.value[0]).toEqual(observation(2));
    expect(after.value.at(-1)).toEqual(observation(HEALTH_PROBE_RING_LIMIT + 1));
    expect(ring.read("production")).toEqual({ ok: true, value: [observation(1, "production")] });
    const database = new DatabaseSync(`${main}.health.sqlite`);
    try { expect(database.prepare("SELECT COUNT(*) AS n FROM health_probes").get()?.n).toBe(HEALTH_PROBE_RING_LIMIT + 1); }
    finally { database.close(); }
    expect(rawMain.prepare("SELECT COUNT(*) AS n FROM domain_events").get()?.n).toBe(before);
  } finally { rawMain.close(); store.close(); rmSync(root, { force: true, recursive: true }); }
});

it("reads every member after reopen and retains insertion order under a backwards clock", async () => {
  const { createHealthProbeRing } = await subject();
  const root = directory();
  try {
    const path = join(root, "health.sqlite");
    const ring = createHealthProbeRing(path, "project-health");
    expect(ring.read("preview")).toEqual({ ok: true, value: [] });
    expect(ring.append(observation(20))).toMatchObject({ ok: true });
    expect(ring.append(observation(10))).toMatchObject({ ok: true });
    expect(createHealthProbeRing(path, "project-health").read("preview"))
      .toEqual({ ok: true, value: [observation(20), observation(10)] });
    expect(createHealthProbeRing(path, "foreign-project").read("preview")).toEqual({ ok: true, value: [] });
  } finally { rmSync(root, { force: true, recursive: true }); }
});

it("derives health solely from the supplied ring without storing a verdict", async () => {
  const { deriveHealthState } = await subject();
  const rows: HealthProbe[] = [];
  expect(deriveHealthState(rows)).toBe("DEGRADED");
  rows.push(observation(1));
  expect(deriveHealthState(rows)).toBe("UP");
  rows.push(observation(2, "preview", "FAILURE"));
  expect(deriveHealthState(rows)).toBe("DEGRADED");
  rows.push(observation(3, "preview", "FAILURE"), observation(4, "preview", "FAILURE"));
  expect(deriveHealthState(rows)).toBe("DOWN");
  rows.push(observation(5, "preview", "UNPROBEABLE"));
  expect(deriveHealthState(rows)).toBe("DEGRADED");
  rows.push(observation(5));
  expect(deriveHealthState(rows)).toBe("UP");
});

function deploy(store: SqliteEventStore, url: string | null, decisionId = "deploy-1"): void {
  const result = recordDeployReceipt(store, { projectId: "project-health", environment: "preview",
    sha: "a".repeat(40), imageDigest: `sha256:${"b".repeat(64)}`, refusal: null, releaseDecision: null,
    url, decidedAt: "2026-09-06T00:00:00.000Z", decisionId });
  expect(result.ok).toBe(true);
}

it("reads the real deploy URL and appends only a bounded observation, never response data", async () => {
  const { createHealthProbeRing, probeEnvironment } = await subject();
  expect(probeEnvironment).toBeTypeOf("function");
  const root = directory();
  const store = SqliteEventStore.openForProject(join(root, "events.sqlite"), "project-health");
  try {
    deploy(store, "http://127.0.0.1:43210/product");
    const ring = createHealthProbeRing(join(root, "health.sqlite"), "project-health");
    const requests: string[] = [];
    const result = await probeEnvironment({ store, ring, projectId: "project-health", environment: "preview",
      signal: new AbortController().signal, clock: () => "2026-09-06T01:00:00.000Z",
      http: async (url, signal) => { requests.push(url); expect(signal.aborted).toBe(false); return 204; } });
    expect(requests).toEqual(["http://127.0.0.1:43210/health"]);
    expect(result).toEqual({ ok: true, value: { version: HEALTH_PROBE_VERSION, environment: "preview",
      sha: "a".repeat(40), status: "SUCCESS", latencyMs: expect.any(Number), at: "2026-09-06T01:00:00.000Z" } });
    expect(ring.read("preview")).toMatchObject({ ok: true, value: [expect.objectContaining({ status: "SUCCESS" })] });
  } finally { store.close(); rmSync(root, { force: true, recursive: true }); }
});

it("records UNPROBEABLE and never UP when a deployed environment loses its URL", async () => {
  const { createHealthProbeRing, probeEnvironment, deriveHealthState } = await subject();
  expect(probeEnvironment).toBeTypeOf("function");
  const root = directory();
  const store = SqliteEventStore.openForProject(join(root, "events.sqlite"), "project-health");
  try {
    const ring = createHealthProbeRing(join(root, "health.sqlite"), "project-health");
    expect(ring.append(observation(1))).toMatchObject({ ok: true });
    deploy(store, null);
    let calls = 0;
    expect(await probeEnvironment({ store, ring, projectId: "project-health", environment: "preview",
      signal: new AbortController().signal, http: async () => { calls++; return 200; } }))
      .toEqual({ ok: false, code: "PROBE_URL_MISSING", layer: "DAEMON_INGRESS" });
    const read = ring.read("preview");
    if (!read.ok) throw new Error(read.code);
    expect(calls).toBe(0);
    expect(read.value.at(-1)?.status).toBe("UNPROBEABLE");
    expect(deriveHealthState(read.value)).toBe("DEGRADED");
  } finally { store.close(); rmSync(root, { force: true, recursive: true }); }
});

it("does not persist a late callback after abort even when the HTTP port ignores cancellation", async () => {
  const { createHealthProbeRing, probeEnvironment } = await subject();
  expect(probeEnvironment).toBeTypeOf("function");
  const root = directory();
  const store = SqliteEventStore.openForProject(join(root, "events.sqlite"), "project-health");
  try {
    deploy(store, "http://127.0.0.1:43210");
    const ring = createHealthProbeRing(join(root, "health.sqlite"), "project-health");
    const controller = new AbortController();
    let complete: ((status: number) => void) | undefined;
    const result = probeEnvironment({ store, ring, projectId: "project-health", environment: "preview",
      signal: controller.signal, http: async (_url, signal) => {
        expect(signal.aborted).toBe(false);
        return new Promise<number>((resolve) => { complete = resolve; });
      } });
    expect(complete).toBeTypeOf("function");
    controller.abort(); store.close(); complete?.(200);
    expect(await result).toEqual({ ok: false, code: "PROBE_ABORTED", layer: "DAEMON_INGRESS" });
    expect(ring.read("preview")).toEqual({ ok: true, value: [] });
  } finally { store.close(); rmSync(root, { force: true, recursive: true }); }
});

it("commits incident transitions with the real append and preserves them past ring eviction", async () => {
  const { createHealthProbeRing } = await subject();
  const root = directory();
  try {
    const ring = createHealthProbeRing(join(root, "health.sqlite"), "project-health");
    expect(ring.incidents).toBeTypeOf("function");
    for (let n = 1; n <= 3; n++) expect(ring.append(observation(n, "preview", "FAILURE"))).toMatchObject({ ok: true });
    const opened = ring.incidents("preview");
    if (!opened.ok) throw new Error(opened.code);
    expect(opened.value).toHaveLength(1);
    expect(opened.value[0]?.closedAt).toBeNull();
    expect(ring.append(observation(4))).toMatchObject({ ok: true });
    const closed = ring.incidents("preview");
    if (!closed.ok) throw new Error(closed.code);
    expect(closed.value[0]).toEqual({ ...opened.value[0], closedAt: observation(4).at });
    for (let n = 5; n <= HEALTH_PROBE_RING_LIMIT + 4; n++) expect(ring.append(observation(n))).toMatchObject({ ok: true });
    expect(ring.incidents("preview")).toEqual(closed);
  } finally { rmSync(root, { force: true, recursive: true }); }
});

/** Failures appended AFTER a card is already open. Ten separates all three wrong loops at once: a
 *  per-probe raise reaches eleven cards, a re-raise every HEALTH_FAILURE_THRESHOLD failures reaches
 *  four, and a close-and-silently-reopen holds the count at one but changes the row identity. One
 *  extra failure would only catch the first of those. */
const CONTINUED_FAILURES = 10;

/** DoD 1 and task rail 1: ONE card per outage. Both directions are required — (a) alone is satisfied
 *  by a ring that never opens a second incident for its whole lifetime, which loses the operator the
 *  next outage entirely, and (b) alone is satisfied by a ring that opens one per failing probe. */
it("raises one card per outage: continued failure adds none, and a later outage adds a second", async () => {
  const { createHealthProbeRing } = await subject();
  const root = directory();
  try {
    const ring = createHealthProbeRing(join(root, "health.sqlite"), "project-health");
    // Every boundary is derived from HEALTH_FAILURE_THRESHOLD so raising the threshold moves the
    // arm with production instead of silently testing a shorter outage than the one that opens a card.
    const outageEnd = HEALTH_FAILURE_THRESHOLD, continuedEnd = outageEnd + CONTINUED_FAILURES;
    const recovery = continuedEnd + 1, secondEnd = recovery + HEALTH_FAILURE_THRESHOLD;
    for (let n = 1; n <= outageEnd; n++) {
      expect(ring.append(observation(n, "preview", "FAILURE"))).toMatchObject({ ok: true });
    }
    const opened = ring.incidents("preview");
    if (!opened.ok) throw new Error(opened.code);
    expect(opened.value).toHaveLength(1);
    expect(opened.value[0]?.closedAt).toBeNull();

    // (a) TEN more consecutive failures, every status written EXPLICITLY rather than defaulted —
    // the uncovered gap this arm exists for was a defaulted "SUCCESS" reading as a fourth failure.
    for (let n = outageEnd + 1; n <= continuedEnd; n++) {
      expect(ring.append(observation(n, "preview", "FAILURE"))).toMatchObject({ ok: true });
    }
    const during = ring.incidents("preview");
    if (!during.ok) throw new Error(during.code);
    // BY IDENTITY, not only by count: same id, same openedAt, same openingProbes, still closedAt null.
    expect(during.value).toEqual(opened.value);

    // (b) THE ANTI-VACUITY CONTROL. Recovery closes the card; a fresh outage must open a NEW one.
    expect(ring.append(observation(recovery, "preview", "SUCCESS"))).toMatchObject({ ok: true });
    for (let n = recovery + 1; n <= secondEnd; n++) {
      expect(ring.append(observation(n, "preview", "FAILURE"))).toMatchObject({ ok: true });
    }
    const second = ring.incidents("preview");
    if (!second.ok) throw new Error(second.code);
    expect(second.value).toHaveLength(2);
    expect(second.value[0]).toEqual({ ...opened.value[0], closedAt: observation(recovery).at });
    expect(second.value[1]?.closedAt).toBeNull();
    expect(second.value[1]?.openedAt).toBe(observation(secondEnd).at);
    expect(second.value[1]?.id).not.toBe(opened.value[0]?.id);
    // The second card's EVIDENCE is the second outage's own three failures — not the recovery that
    // preceded them and not a probe carried over from the first. A card opened on stale evidence
    // still counts as two cards and would pass every assertion above it.
    expect(second.value[1]?.openingProbes).toEqual(Array.from({ length: HEALTH_FAILURE_THRESHOLD },
      (_, index) => observation(secondEnd - HEALTH_FAILURE_THRESHOLD + 1 + index, "preview", "FAILURE")));
  } finally { rmSync(root, { force: true, recursive: true }); }
});

it.each(["read", "incidents"] as const)("refuses a nonexistent relative sidecar on %s", async (method) => {
  const { createHealthProbeRing } = await subject();
  const root = directory();
  try {
    const path = join("missing-health", basename(root), "health.sqlite");
    expect([isAbsolute(path), existsSync(path)]).toEqual([false, false]);
    const ring = createHealthProbeRing(path, "project-health");
    expect(ring[method]("preview"))
      .toEqual({ ok: false, code: "PROBE_STORE_UNAVAILABLE", layer: "DAEMON_INGRESS" });
    expect(existsSync(path)).toBe(false);
  } finally { rmSync(root, { force: true, recursive: true }); }
});

it.each(["read", "incidents"] as const)("does not initialize an existing empty SQLite sidecar on %s", async (method) => {
  const { createHealthProbeRing } = await subject();
  const root = directory();
  try {
    const path = join(root, "health.sqlite");
    const schema = () => {
      const database = new DatabaseSync(path);
      try {
        return [database.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get()?.n,
          database.prepare("PRAGMA application_id").get()?.application_id,
          database.prepare("PRAGMA user_version").get()?.user_version];
      } finally { database.close(); }
    };
    expect(schema()).toEqual([0, 0, 0]);
    expect(existsSync(path)).toBe(true);
    const result = createHealthProbeRing(path, "project-health")[method]("preview");
    const after = schema();
    expect(result).toEqual({ ok: false, code: "PROBE_STORE_UNAVAILABLE", layer: "DAEMON_INGRESS" });
    expect(after).toEqual([0, 0, 0]);
  } finally { rmSync(root, { force: true, recursive: true }); }
});

it("does not attribute the running URL to a refused deployment candidate", async () => {
  const { createHealthProbeRing, probeEnvironment } = await subject();
  const root = directory();
  const store = SqliteEventStore.openForProject(join(root, "events.sqlite"), "project-health");
  try {
    const url = "http://127.0.0.1:43210", candidateSha = "c".repeat(40);
    deploy(store, url);
    const refused = recordDeployReceipt(store, {
      projectId: "project-health", environment: "preview", sha: candidateSha,
      imageDigest: null, refusal: { code: "DEPLOY_BUILD_FAILED", detail: "build failed", layer: "DAEMON_DEPLOY_ENGINE" },
      releaseDecision: null, url, decidedAt: "2026-09-06T02:00:00.000Z", decisionId: "failed-candidate",
    });
    expect(refused.ok).toBe(true);
    const ring = createHealthProbeRing(join(root, "health.sqlite"), "project-health");
    let calls = 0;
    const result = await probeEnvironment({ store, ring, projectId: "project-health", environment: "preview",
      signal: new AbortController().signal, http: async () => { calls++; return 200; } });
    expect([result.ok, calls]).toEqual([false, 0]);
    expect(result).toEqual({ ok: false, code: "PROBE_DEPLOYMENT_UNVERIFIED", layer: "DAEMON_INGRESS" });
    const read = ring.read("preview");
    if (!read.ok) throw new Error(read.code);
    expect(read.value.some((probe) => probe.sha === candidateSha && probe.status === "SUCCESS")).toBe(false);
  } finally { store.close(); rmSync(root, { force: true, recursive: true }); }
});
