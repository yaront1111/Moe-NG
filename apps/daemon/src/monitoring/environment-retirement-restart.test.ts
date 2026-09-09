import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandEnvelope } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { expect, it } from "vitest";

import { OPERATOR_CAPABILITIES } from "../daemon-command-registry.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { readDeployLedger, recordDeployReceipt } from "../deployment/deploy-ledger.js";
import type { ScheduleTimer } from "../orchestrator/durable-schedule.js";
import { ENVIRONMENT_RETIREMENT_COMMAND_KIND } from "./environment-retirement-command-contracts.js";
import { ENVIRONMENT_RETIREMENT_EDGE_RESULT_CODE } from "./environment-retirement-command.js";
import { HEALTH_PROBE_SIDECAR_SUFFIX, HEALTH_PROBE_VERSION } from "./health-probe-contracts.js";
import { createHealthProbeRing } from "./health-probe-ring.js";
import { DEFAULT_PROBE_INTERVAL_MS, createProbeIntervalRecord } from "./probe-interval-record.js";

/**
 * THE INTEGRATION PROOF FOR THE RETIREMENT SPLIT (task-de80c663), and deliberately ONLY the part
 * no child row could prove alone.
 *
 * `environment-retirement-command.test.ts` (task-509f0437) already drives dispatch -> tick -> no
 * new sample on ONE live composition, and `health-probe-schedule.test.ts` (task-f18bddee) already
 * restarts the daemon around a retirement written straight into the record. Neither crosses the
 * two: the first says verbatim that nothing is closed or rebuilt from disk, and the second never
 * touches the command edge. What is unproven until here is that the OPERATOR'S WRITE and the
 * SWEEP'S READ are the same durable fact ACROSS A RESTART -- the defect epic rail 4 names, where
 * something this platform starts is not stopped by the thing meant to stop it.
 *
 * Every arm below therefore retires through `registry.get(kind).handler(...)` on the live
 * composition. Reaching into `createEnvironmentRetirementRecord` here would re-test child 1 and
 * skip the seam entirely.
 */

const PROJECT = "environment-retirement-restart-test";
const AGGREGATE = `environment-retirement/${PROJECT}`;
const CREDENTIAL = "retirement-restart-operator-credential";
const CLOCK = (): string => "2026-09-09T12:00:00.000Z";
const PORTS: Readonly<Record<string, number>> = { production: 49212, staging: 49211 };
const SHA = "a".repeat(40);

function deploy(store: SqliteEventStore, environment: string, decisionId?: string): void {
  const result = recordDeployReceipt(store, {
    decidedAt: CLOCK(), decisionId: decisionId ?? `deploy-${environment}`, environment,
    imageDigest: `sha256:${"b".repeat(64)}`, projectId: PROJECT, refusal: null,
    releaseDecision: null, sha: SHA, url: `http://127.0.0.1:${PORTS[environment]}`,
  });
  if (!result.ok) throw new Error(result.code);
}

/** Records every arm handed out and every release, so "one live handle" stays measurable. */
class FakeTimer implements ScheduleTimer {
  time = 0;
  private nextHandle = 0;
  readonly arms: { handle: number; interval: number; tick: () => void; due: number;
    cleared: boolean }[] = [];
  set = (tick: () => void, interval: number): number => {
    const handle = ++this.nextHandle;
    this.arms.push({ cleared: false, due: this.time + interval, handle, interval, tick });
    return handle;
  };
  clear = (handle: unknown): void => {
    const arm = this.arms.find((candidate) => candidate.handle === handle);
    if (arm !== undefined) arm.cleared = true;
  };
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const due = this.arms.filter((arm) => !arm.cleared && arm.due <= end)
        .sort((a, b) => a.due - b.due)[0];
      if (due === undefined) break;
      this.time = due.due;
      due.due += due.interval;
      due.tick();
      await new Promise<void>((done) => setImmediate(done));
    }
    this.time = end;
  }
}

const envelopeOf = (payload: Readonly<Record<string, unknown>>): RuntimeCommandEnvelope => ({
  commandId: "cmd-retire-restart", commandKind: ENVIRONMENT_RETIREMENT_COMMAND_KIND,
  correlationId: "corr-retire-restart", expectedVersion: 0,
  payload: payload as RuntimeCommandEnvelope["payload"], requestDigest: "a".repeat(64),
  schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, sessionCredential: CREDENTIAL,
  targetAggregateId: AGGREGATE,
});

type RetirementEntry = NonNullable<
  ReturnType<ReturnType<ReturnType<typeof createStoreDependencies>["provide"]>["registry"]["get"]>
>;

interface Restartable {
  /** Tears the composition down and builds a NEW one off the SAME store path. */
  readonly boot: () => void;
  readonly counts: Map<string, number>;
  /** The LIVE registry entry for the kind, so an arm can prove a restart replaced it. */
  readonly entry: () => RetirementEntry;
  readonly retire: (environment: string) => unknown;
  readonly ring: ReturnType<typeof createHealthProbeRing>;
  readonly store: SqliteEventStore;
  readonly timer: FakeTimer;
}

const sampleOf = (environment: string): Record<string, unknown> => ({
  version: HEALTH_PROBE_VERSION, environment, sha: SHA, status: "SUCCESS",
  latencyMs: expect.any(Number), at: expect.any(String),
});

/** The ring read, unwrapped, so an arm compares SAMPLES rather than a result wrapper. */
function samples(ring: Restartable["ring"], environment: string): readonly unknown[] {
  const read = ring.read(environment);
  if (!read.ok) throw new Error(`${read.code}@${read.layer}`);
  return read.value;
}

/**
 * THE PRODUCTION COMPOSITION, torn down and rebuilt on demand. `boot()` is the restart under
 * test: it closes the live provider and calls `createStoreDependencies` again against the same
 * store path, which is exactly what `daemon-store-foundation-composition.ts` does on daemon
 * start -- a fresh registry, a fresh retirement record and a fresh sweep, holding nothing from
 * the previous process but the durable store.
 */
async function withRestartableDaemon(
  intervals: ReadonlyMap<string, number>, body: (context: Restartable) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "moe-retirement-restart-"));
  const storePath = join(root, "store.db");
  const timer = new FakeTimer();
  const counts = new Map<string, number>();
  const http = async (url: string): Promise<number> => {
    const environment = Object.keys(PORTS).find((name) => url.includes(`:${PORTS[name]}`))
      ?? "unknown";
    counts.set(environment, (counts.get(environment) ?? 0) + 1);
    return 200;
  };
  let current: ReturnType<typeof createStoreDependencies> | null = null;
  const shutdown = (): void => { current?.close(); current = null; };
  const boot = (): void => {
    shutdown();
    current = createStoreDependencies({ credential: CREDENTIAL, healthProbeHttp: http,
      principalId: "operator-local", projectId: PROJECT, schedule: { timer }, storePath });
  };
  // The genesis install owns the empty store; seeding before it refuses GENESIS_INSTALL_REFUSED.
  boot();
  shutdown();
  const store = SqliteEventStore.openForProject(storePath, PROJECT);
  try {
    for (const environment of Object.keys(PORTS)) deploy(store, environment);
    for (const [environment, intervalMs] of intervals) {
      const written = createProbeIntervalRecord({ projectId: PROJECT, store })
        .write(environment, intervalMs);
      if (!written.ok) throw new Error(`${written.code}@${written.layer}`);
    }
    // `provide()` PER CALL against whatever composition is live NOW, exactly as the daemon's
    // request path does it. A registry captured once could not tell a restart apart.
    const entry = (): RetirementEntry => {
      if (current === null) throw new Error("NO_LIVE_COMPOSITION");
      const found = current.provide().registry.get(ENVIRONMENT_RETIREMENT_COMMAND_KIND);
      if (found === undefined) throw new Error("RETIREMENT_ENTRY_ABSENT");
      return found;
    };
    await body({
      boot, counts, entry, store, timer,
      ring: createHealthProbeRing(`${storePath}${HEALTH_PROBE_SIDECAR_SUFFIX}`, PROJECT),
      retire: (environment: string): unknown => {
        return entry().handler({
          envelope: envelopeOf({ environment }),
          principal: {
            capabilities: OPERATOR_CAPABILITIES, principalId: "operator-local", projectId: PROJECT,
          },
        });
      },
    });
  } finally {
    shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
    // TEARDOWN IS ASSERTED, not assumed -- epic rail 4. Every handle every boot ever created has
    // been released, so no probe schedule outlives the composition that armed it.
    expect(timer.arms.filter((arm) => !arm.cleared)).toEqual([]);
  }
}

/**
 * PARENT DoD 2. Retirement is a durable, replayable fact: a daemon restart does not resurrect the
 * retired environment into the sweep.
 *
 * The write happens through the OPERATOR COMMAND on one composition and is read back by a
 * DIFFERENT composition's sweep -- different registry object, different retirement record,
 * different in-memory everything. If the two were wired to anything other than the same durable
 * aggregate, `staging` would start being probed again after `boot()` and this arm would red.
 */
it("keeps an operator-dispatched retirement across a daemon restart", async () => {
  await withRestartableDaemon(new Map(),
    async ({ boot, counts, entry, retire, ring, store, timer }) => {
      boot();
      await timer.advance(DEFAULT_PROBE_INTERVAL_MS);
      // THE SWEEP WAS ACTUALLY SAMPLING `staging` first, or every "no new sample" below would be
      // vacuously true against a daemon that never probed it at all.
      expect(samples(ring, "staging")).toEqual([sampleOf("staging")]);

      expect(retire("staging")).toMatchObject({
        disposition: "DECIDED", resultCode: ENVIRONMENT_RETIREMENT_EDGE_RESULT_CODE,
      });
      const retiredAt = samples(ring, "staging");
      const ledger = readDeployLedger(store, PROJECT);

      // THE RESTART. Nothing survives it but the store on disk.
      const probedBefore = counts.get("production") ?? 0;
      const servedBefore = entry(), armedBefore = timer.arms.length;
      boot();
      // THE RESTART REALLY HAPPENED, asserted rather than assumed. Without this pair a `boot()`
      // that silently did nothing would leave the arm passing on the FIRST composition and the
      // whole DoD-2 claim would be vacuous. Every arm the old composition held was released
      // (epic rail 4 -- what it starts, it stops) and the rebuilt daemon armed its own sweep, and
      // the served entry is a DIFFERENT object, so the dispatch surface was rebuilt too.
      expect(timer.arms.slice(0, armedBefore).filter((arm) => !arm.cleared)).toEqual([]);
      expect(timer.arms.length).toBeGreaterThan(armedBefore);
      expect(entry()).not.toBe(servedBefore);

      await timer.advance(DEFAULT_PROBE_INTERVAL_MS * 2);

      expect(samples(ring, "staging")).toEqual(retiredAt);
      // AND THE REBUILT DAEMON IS ALIVE: `production` kept being probed by the NEW composition
      // across the same windows, so "no new staging sample" is the retirement being replayed and
      // not a sweep that failed to re-arm.
      expect((counts.get("production") ?? 0) - probedBefore).toBeGreaterThanOrEqual(2);
      expect(samples(ring, "production")).toHaveLength(counts.get("production") ?? 0);
      // ONE durable fact, not one per boot: the restart replays it, it does not re-append it.
      expect(store.readEvents(AGGREGATE)).toHaveLength(1);
      // AND THE LEDGER IS UNTOUCHED BY THE RESTART, so nothing "fixed" the sweep by forgetting a
      // receipt -- the append-only ledger DoD 3 protects still holds both environments.
      expect(readDeployLedger(store, PROJECT)).toEqual(ledger);
    });
});

/**
 * PARENT DoD 3, THE NEGATIVE HALF. Retirement is a fact LAYERED OVER the deploy ledger, never a
 * receipt deletion -- and the distinction is not academic. The sweep derives its roster from
 * `readDeployLedger`, so a "fix" that dropped the environment's receipts would ALSO have made the
 * restart arm above pass. This arm is what tells the two apart: it captures the ledger and the
 * ring BEFORE the operator's command and asserts on their CONTENT afterwards, because a reader
 * that silently answered empty would satisfy any shallower check.
 */
it("retires without destroying the environment's receipts or its probe history", async () => {
  await withRestartableDaemon(new Map(), async ({ boot, retire, ring, store, timer }) => {
    boot();
    await timer.advance(DEFAULT_PROBE_INTERVAL_MS);
    const before = readDeployLedger(store, PROJECT);
    const staging = before.get("staging");
    if (staging === undefined) throw new Error("STAGING_ABSENT_FROM_LEDGER");
    const history = samples(ring, "staging");
    expect(history).toEqual([sampleOf("staging")]);

    expect(retire("staging")).toMatchObject({ resultCode: ENVIRONMENT_RETIREMENT_EDGE_RESULT_CODE });

    const after = readDeployLedger(store, PROJECT);
    // (b) THE ENVIRONMENT SET IS UNCHANGED. The retired name is STILL in the ledger -- retirement
    // removes it from the SWEEP, not from the record of what was deployed.
    expect([...after.keys()].sort()).toEqual(["production", "staging"]);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    // (b) AND THE RECEIPT COUNT IS UNCHANGED, named rather than only deep-compared, so a ledger
    // emptied on BOTH sides could not pass the equality that follows.
    const retained = after.get("staging");
    expect(retained?.receipts).toHaveLength(1);
    expect(staging.receipts).toHaveLength(1);
    // (a) HISTORY SURVIVES, ON CONTENT. The receipt still carries the deployed SHA, the live URL
    // and the DEPLOYED outcome -- the three fields an operator reads to answer "what was there".
    expect(retained?.current).toMatchObject({
      environment: "staging", outcome: "DEPLOYED", sha: SHA,
      url: `http://127.0.0.1:${PORTS["staging"]}`,
    });
    expect(after).toEqual(before);
    // (a) AND THE PROBE RING KEEPS THE SAMPLES IT ALREADY HELD.
    expect(samples(ring, "staging")).toEqual(history);
  });
});

/**
 * PARENT DoD 1 AND 3(c)(d) IN ONE WINDOW, because they are one story about one environment.
 *
 * (c) RETIREMENT IS NOT ESCAPABLE BY OWNING AN INTERVAL. There are TWO probe paths -- the sweep
 * (`createHealthProbeJob`) and the per-environment job (`createEnvironmentHealthProbeJob`) -- and
 * an environment with its own interval is served by the SECOND. An arm that only retired a
 * sweep-served environment would leave the faster path unproven, and the faster path is the one an
 * operator reaches for on the environment they care most about. Child 2 covers this from the
 * record; here it goes through the REAL COMMAND, which is the only version that says an OPERATOR
 * can do it.
 *
 * (d) A DEPLOY AFTER RETIREMENT ENDS IT, and this arm PINS that answer rather than leaving it for
 * production to discover. `environment-retirement-record.ts` scopes a retirement to the successful
 * generation observed at write time (`latestSuccessful(state) === cutoff`), so a later successful
 * receipt supersedes it and the environment returns to monitoring on its own. That is the right
 * default -- an operator who deploys to an environment is asking for it back -- but it is only
 * safe because it is DELIBERATE, and it is only deliberate if an arm says so.
 */
it("cannot be escaped by a dedicated interval, and ends when a new deploy lands", async () => {
  await withRestartableDaemon(new Map([["staging", 10_000]]),
    async ({ boot, counts, retire, ring, store, timer }) => {
      boot();
      // THE DEDICATED PATH IS THE ONE SERVING `staging`: its own 10s interval is armed alongside
      // the default sweep, so the samples below come from `createEnvironmentHealthProbeJob`.
      await timer.advance(30_000);
      const dedicatedSamples = samples(ring, "staging").length;
      expect(dedicatedSamples).toBe(3);
      expect(counts.get("staging")).toBe(3);

      expect(retire("staging")).toMatchObject({
        resultCode: ENVIRONMENT_RETIREMENT_EDGE_RESULT_CODE,
      });
      // (c) BOTH PATHS STOP. This window spans several dedicated ticks AND a full default sweep
      // tick, so a retirement honoured by only one of the two would show up here as growth.
      await timer.advance(DEFAULT_PROBE_INTERVAL_MS);
      expect(samples(ring, "staging")).toHaveLength(dedicatedSamples);
      expect(counts.get("staging")).toBe(3);
      // AND THE DAEMON IS STILL PROBING: production advanced over the very same window.
      expect(counts.get("production") ?? 0).toBeGreaterThan(0);
      // (c) AND IT SURVIVES A RESTART ON THE DEDICATED PATH TOO -- restore resolution is a THIRD
      // reader of the retirement fact, and a permissive fallback there would re-arm the job.
      boot();
      await timer.advance(DEFAULT_PROBE_INTERVAL_MS);
      expect(samples(ring, "staging")).toHaveLength(dedicatedSamples);

      // (d) A NEW SUCCESSFUL DEPLOY SUPERSEDES THE RETIRED GENERATION, so probing RESUMES without
      // an un-retire command and without a restart. Asserted as GROWTH from the retired count.
      deploy(store, "staging", "redeploy-after-retirement");
      // MEASURED, AND WORTH NAMING: a dedicated arm that a restart declined to create comes back
      // only when RECONCILIATION runs, and reconciliation runs on the SWEEP's tick. So the wait
      // after a redeploy is bounded by the DEFAULT interval even for an environment that owns a
      // faster one. Advancing only 30s here left the count at 3 and read as "a redeploy does not
      // un-retire", which is the wrong conclusion -- the window, not the behaviour, was short.
      await timer.advance(DEFAULT_PROBE_INTERVAL_MS + 10_000);
      expect(samples(ring, "staging").length).toBeGreaterThan(dedicatedSamples);
      // AND THE OPERATOR CAN RETIRE IT AGAIN: the second retirement is a SECOND durable fact
      // scoped to the new generation, so retirement is repeatable rather than one-shot.
      expect(retire("staging")).toMatchObject({
        resultCode: ENVIRONMENT_RETIREMENT_EDGE_RESULT_CODE,
      });
      expect(store.readEvents(AGGREGATE)).toHaveLength(2);
      const resumed = samples(ring, "staging").length;
      await timer.advance(DEFAULT_PROBE_INTERVAL_MS);
      expect(samples(ring, "staging")).toHaveLength(resumed);
      // AND THE LEDGER GREW BY EXACTLY THE ONE RECEIPT THE DEPLOY APPENDED -- append-only, never
      // rewritten by either retirement.
      expect(readDeployLedger(store, PROJECT).get("staging")?.receipts).toHaveLength(2);
    });
});
