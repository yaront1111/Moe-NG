import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { expect, it } from "vitest";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { recordDeployReceipt } from "../deployment/deploy-ledger.js";
import type { ScheduleTimer } from "../orchestrator/durable-schedule.js";
import { HEALTH_PROBE_JOB_ID, healthProbeJobId } from "./health-probe-contracts.js";
import { DEFAULT_PROBE_INTERVAL_MS, createProbeIntervalRecord } from "./probe-interval-record.js";

const PROJECT = "project-probe-schedule";
const CREDENTIAL = "test-operator-credential";
const CLOCK = (): string => "2026-08-09T12:00:00.000Z";
const PORTS: Readonly<Record<string, number>> = { preview: 49103, production: 49102, staging: 49101 };

/** Records every arm it hands out and every release, so "one live handle" is measured, not assumed. */
class FakeTimer implements ScheduleTimer {
  time = 0;
  private nextHandle = 0;
  readonly arms: { handle: number; interval: number; tick: () => void; due: number; cleared: boolean }[] = [];
  set = (tick: () => void, interval: number): number => {
    const handle = ++this.nextHandle;
    this.arms.push({ cleared: false, due: this.time + interval, handle, interval, tick });
    return handle;
  };
  clear = (handle: unknown): void => {
    const arm = this.arms.find((candidate) => candidate.handle === handle);
    if (arm !== undefined) arm.cleared = true;
  };
  live = (): readonly { interval: number }[] => this.arms.filter((arm) => !arm.cleared);
  liveIntervals = (): readonly number[] => this.live().map((arm) => arm.interval).sort((a, b) => a - b);
  /** Drives ticks by hand and flushes the microtask queue after each: no real timer, no wall clock. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const due = this.arms.filter((arm) => !arm.cleared && arm.due <= end).sort((a, b) => a.due - b.due)[0];
      if (due === undefined) break;
      this.time = due.due;
      due.due += due.interval;
      due.tick();
      await new Promise<void>((done) => setImmediate(done));
    }
    this.time = end;
  }
}

interface Probed { readonly counts: Map<string, number>; readonly http: (url: string) => Promise<number>; }
function probeCounter(): Probed {
  const counts = new Map<string, number>();
  return {
    counts,
    http: async (url: string): Promise<number> => {
      const environment = Object.keys(PORTS).find((name) => url.includes(`:${PORTS[name]}`)) ?? "unknown";
      counts.set(environment, (counts.get(environment) ?? 0) + 1);
      return 200;
    },
  };
}

function deploy(store: SqliteEventStore, environment: string): void {
  const result = recordDeployReceipt(store, {
    decidedAt: CLOCK(), decisionId: `deploy-${environment}`, environment, imageDigest: `sha256:${"b".repeat(64)}`,
    projectId: PROJECT, refusal: null, releaseDecision: null, sha: "a".repeat(40),
    url: `http://127.0.0.1:${PORTS[environment]}`,
  });
  if (!result.ok) throw new Error(result.code);
}

const registrations = (store: SqliteEventStore): readonly { id: string; intervalMs: number }[] =>
  store.readEvents(`durable-schedule/${PROJECT}`)
    .map((event) => JSON.parse(new TextDecoder().decode(event.payload)) as { id: string; intervalMs: number });

interface DaemonContext {
  boot: () => void;
  shutdown: () => void;
  counts: Map<string, number>;
  store: SqliteEventStore;
  timer: FakeTimer;
}

async function withDaemon(
  environments: readonly string[], intervals: ReadonlyMap<string, number>,
  body: (context: DaemonContext) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "moe-probe-schedule-"));
  const storePath = join(root, "store.db");
  const timer = new FakeTimer();
  const { counts, http } = probeCounter();
  let current: ReturnType<typeof createStoreDependencies> | null = null;
  const shutdown = (): void => { current?.close(); current = null; };
  const boot = (): void => {
    shutdown();
    current = createStoreDependencies({
      credential: CREDENTIAL, healthProbeHttp: http, principalId: "operator-local",
      projectId: PROJECT, schedule: { timer }, storePath,
    });
  };
  // The genesis install owns the empty store; seeding before it refuses
  // GENESIS_INSTALL_REFUSED (RECOVERY_INITIAL_INSTALL_HISTORY_PRESENT).
  boot();
  shutdown();
  const store = SqliteEventStore.openForProject(storePath, PROJECT);
  try {
    for (const environment of environments) deploy(store, environment);
    const record = createProbeIntervalRecord({ projectId: PROJECT, store });
    for (const [environment, intervalMs] of intervals) {
      const written = record.write(environment, intervalMs);
      if (!written.ok) throw new Error(`${written.code}@${written.layer}`);
    }
    await body({ boot, counts, shutdown, store, timer });
  } finally {
    shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
    // TEARDOWN IS ASSERTED, not assumed: every handle the timer ever created has been released.
    expect(timer.arms.filter((arm) => !arm.cleared)).toEqual([]);
  }
}

it("probes two environments at their own stored rates over one window", async () => {
  await withDaemon(["staging", "production"], new Map([["staging", 10_000], ["production", 20_000]]),
    async ({ boot, counts, timer }) => {
      boot();
      expect(timer.liveIntervals()).toEqual([10_000, 20_000, DEFAULT_PROBE_INTERVAL_MS]);
      await timer.advance(60_000);
      // COUNTS, not the intervals the timer was ASKED for: 60s/10s = 6 and 60s/20s = 3.
      expect(counts.get("staging")).toBe(6);
      expect(counts.get("production")).toBe(3);
    });
});

it("applies a changed interval on the next sweep, with no daemon restart", async () => {
  await withDaemon(["staging", "production"], new Map([["staging", 10_000], ["production", 20_000]]),
    async ({ boot, counts, store, timer }) => {
      boot();
      await timer.advance(60_000);
      expect([counts.get("staging"), counts.get("production")]).toEqual([6, 3]);

      const rewritten = createProbeIntervalRecord({ projectId: PROJECT, store }).write("staging", 30_000);
      expect(rewritten).toEqual({ ok: true, value: 30_000 });
      // The SAME provider keeps running: nothing closed, nothing rebuilt from disk. The sweep that
      // ends this window is what reconciles staging onto its new rate — a bounded latency of one
      // sweep interval, which is the honest cost of not restarting.
      await timer.advance(60_000);
      expect(timer.liveIntervals()).toEqual([20_000, 30_000, DEFAULT_PROBE_INTERVAL_MS]);

      const before = { production: counts.get("production") ?? 0, staging: counts.get("staging") ?? 0 };
      await timer.advance(60_000);
      // A full window at the NEW rate: staging halves to 2 while production is untouched at 3.
      expect((counts.get("staging") ?? 0) - before.staging).toBe(2);
      expect((counts.get("production") ?? 0) - before.production).toBe(3);
    });
});

it("re-registers at boot without overwriting the stored intervals or doubling the schedule", async () => {
  await withDaemon(["staging", "production"], new Map([["staging", 10_000], ["production", 20_000]]),
    async ({ boot, counts, shutdown, store, timer }) => {
      boot();
      await timer.advance(60_000);
      const before = { armed: timer.liveIntervals(), registered: registrations(store) };
      expect([counts.get("staging"), counts.get("production")]).toEqual([6, 3]);
      shutdown();
      expect(timer.live()).toEqual([]);

      boot(); // THE SECOND BOOT — the defect reproduced red in step 1 lives exactly here.
      // BYTE-UNCHANGED: not merely "still 10000", but no additional registration event at all.
      expect(registrations(store)).toEqual(before.registered);
      expect(registrations(store).filter((entry) => entry.id === healthProbeJobId("staging")))
        .toEqual([{ id: healthProbeJobId("staging"), intervalMs: 10_000 }]);
      expect(registrations(store).filter((entry) => entry.id === HEALTH_PROBE_JOB_ID))
        .toEqual([{ id: HEALTH_PROBE_JOB_ID, intervalMs: DEFAULT_PROBE_INTERVAL_MS }]);
      // NO DOUBLE SCHEDULE, measured as set-minus-clear on the timer's own ledger.
      expect(timer.liveIntervals()).toEqual(before.armed);
      await timer.advance(60_000);
      // RATE EQUAL BEFORE AND AFTER, per environment: the second window matches the first exactly.
      expect([counts.get("staging"), counts.get("production")]).toEqual([12, 6]);
    });
});

it("schedules an environment that first appears between boots at the default rate", async () => {
  await withDaemon(["staging"], new Map([["staging", 10_000]]), async ({ boot, counts, shutdown, store, timer }) => {
    boot();
    expect(timer.liveIntervals()).toEqual([10_000, DEFAULT_PROBE_INTERVAL_MS]);
    shutdown();

    deploy(store, "preview"); // never deployed before, and it has NO stored interval
    boot();
    // No new arm: the sweep it belongs to is already running at the default.
    expect(timer.liveIntervals()).toEqual([10_000, DEFAULT_PROBE_INTERVAL_MS]);
    await timer.advance(60_000);
    expect(counts.get("preview")).toBe(1);
    expect(counts.get("staging")).toBe(6);
  });
});

it("hands an environment back to the sweep when its interval record is cleared", async () => {
  await withDaemon(["staging"], new Map([["staging", 10_000]]), async ({ boot, counts, store, timer }) => {
    boot();
    await timer.advance(60_000);
    expect(counts.get("staging")).toBe(6);
    // Smuggle an unadmissible record in: replay drops it, so `staging` is no longer dedicated.
    const payload = new TextEncoder().encode(JSON.stringify({ environment: "staging", intervalMs: 1 }));
    const aggregateId = `probe-interval/${PROJECT}`;
    store.commit({
      aggregateId, commandBytes: payload, commandId: "33333333-3333-4333-8333-333333333333",
      committedAt: CLOCK(), expectedVersion: store.getAggregateVersion(aggregateId),
      events: [{ eventId: "44444444-4444-4444-8444-444444444444", eventType: "moe.probe-interval.set", payload }],
    });
    // Exactly ONE probe per sweep tick: the stale dedicated arm goes inert instead of double-probing.
    await timer.advance(60_000);
    expect(counts.get("staging")).toBe(7);
  });
});

it("gives two environments that share one interval two independent jobs", async () => {
  await withDaemon(["staging", "production"], new Map([["staging", 10_000], ["production", 10_000]]),
    async ({ boot, counts, timer }) => {
      boot();
      // `arm()` dedups by JOB ID, not by interval: an equal interval must not collapse two jobs
      // into one, and the only way to see that is two arms AND two probe counts.
      expect(timer.liveIntervals()).toEqual([10_000, 10_000, DEFAULT_PROBE_INTERVAL_MS]);
      await timer.advance(60_000);
      expect([counts.get("staging"), counts.get("production")]).toEqual([6, 6]);
    });
});
