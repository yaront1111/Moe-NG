import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { expect, it } from "vitest";
import {
  DEFAULT_PROBE_INTERVAL_MS, MAX_PROBE_INTERVAL_MS, MIN_PROBE_INTERVAL_MS, createProbeIntervalRecord,
} from "./probe-interval-record.js";
import type { ProbeIntervalCode, ProbeIntervalRecord } from "./probe-interval-record.js";

const PROJECT = "probe-interval-test";
const AGGREGATE = `probe-interval/${PROJECT}`;
/** Every refusal is asserted whole: ok, the stable code, AND the layer that refused. */
const refusal = (code: ProbeIntervalCode) => ({ ok: false, code, layer: "DAEMON_INGRESS" });

async function withRecord(
  body: (record: ProbeIntervalRecord, store: SqliteEventStore) => void | Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "moe-probe-interval-"));
  const store = SqliteEventStore.openForProject(join(root, "store.db"), PROJECT);
  try { await body(createProbeIntervalRecord({ store, projectId: PROJECT }), store); }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

it("resolves an unset environment to the exported default and stores nothing for it", async () => {
  await withRecord((record, store) => {
    expect(record.read("staging")).toEqual({ ok: true, value: DEFAULT_PROBE_INTERVAL_MS });
    // The default is RESOLVED, never written: `stored()` reports only real operator settings, which
    // is what lets the scheduler tell "left at 60 s" apart from "deliberately set to 60 s".
    expect(record.stored()).toEqual({ ok: true, value: new Map() });
    expect(store.readEvents(AGGREGATE)).toHaveLength(0);
  });
});

it("keeps each environment's interval independent of every other environment's", async () => {
  await withRecord((record) => {
    expect(record.write("staging", 30_000)).toEqual({ ok: true, value: 30_000 });
    expect(record.write("production", 120_000)).toEqual({ ok: true, value: 120_000 });
    // Two environments, two DIFFERENT values, both read back: a store keeping one global value
    // passes a single-environment arm and fails this one.
    expect(record.read("staging")).toEqual({ ok: true, value: 30_000 });
    expect(record.read("production")).toEqual({ ok: true, value: 120_000 });
    expect(record.read("preview")).toEqual({ ok: true, value: DEFAULT_PROBE_INTERVAL_MS });
    expect(record.stored()).toEqual({ ok: true, value: new Map([["staging", 30_000], ["production", 120_000]]) });
  });
});

it("accepts both bounds exactly and refuses one millisecond outside either", async () => {
  await withRecord((record, store) => {
    expect(record.write("staging", MIN_PROBE_INTERVAL_MS - 1)).toEqual(refusal("PROBE_INTERVAL_OUT_OF_RANGE"));
    expect(record.write("staging", MIN_PROBE_INTERVAL_MS)).toEqual({ ok: true, value: MIN_PROBE_INTERVAL_MS });
    expect(record.write("staging", MAX_PROBE_INTERVAL_MS)).toEqual({ ok: true, value: MAX_PROBE_INTERVAL_MS });
    expect(record.write("staging", MAX_PROBE_INTERVAL_MS + 1)).toEqual(refusal("PROBE_INTERVAL_OUT_OF_RANGE"));
    // A refused write must not reach the log at all: exactly the two accepted values are durable.
    expect(store.readEvents(AGGREGATE).map((event) =>
      (JSON.parse(new TextDecoder().decode(event.payload)) as { intervalMs: number }).intervalMs))
      .toEqual([MIN_PROBE_INTERVAL_MS, MAX_PROBE_INTERVAL_MS]);
    expect(record.read("staging")).toEqual({ ok: true, value: MAX_PROBE_INTERVAL_MS });
  });
});

/**
 * 1000 and 4999 are INTEGER and > 0, so the scheduler's own `validInterval` would accept them.
 * Asserting this module's OWN code here is what stops the arm degrading into a test of
 * `durable-schedule`: `PROBE_INTERVAL_OUT_OF_RANGE` is disjoint from `SCHEDULE_INPUT_INVALID`,
 * so no other layer can answer first and keep this green.
 */
it.each([1000, 4999, 5000.5, Number.NaN, Number.POSITIVE_INFINITY, -30_000, 0])(
  "refuses interval %s with this module's own out-of-range code, not the scheduler's", async (interval) => {
    await withRecord((record, store) => {
      expect(record.write("staging", interval)).toEqual(refusal("PROBE_INTERVAL_OUT_OF_RANGE"));
      expect(store.readEvents(AGGREGATE)).toHaveLength(0);
      expect(record.read("staging")).toEqual({ ok: true, value: DEFAULT_PROBE_INTERVAL_MS });
    });
  });

it.each(["Staging", "1staging", "pro_duction", "", "with space", "a".repeat(64)])(
  "refuses environment %s on both read and write with its own code and layer", async (environment) => {
    await withRecord((record, store) => {
      // A VALID interval, so the only thing that can refuse is the environment admission.
      expect(record.write(environment, 30_000)).toEqual(refusal("PROBE_INTERVAL_ENVIRONMENT_INVALID"));
      expect(record.read(environment)).toEqual(refusal("PROBE_INTERVAL_ENVIRONMENT_INVALID"));
      expect(store.readEvents(AGGREGATE)).toHaveLength(0);
    });
  });

it("replaces a prior interval rather than accumulating alongside it", async () => {
  await withRecord((record, store) => {
    expect(record.write("staging", 15_000)).toEqual({ ok: true, value: 15_000 });
    expect(record.write("staging", 45_000)).toEqual({ ok: true, value: 45_000 });
    expect(record.read("staging")).toEqual({ ok: true, value: 45_000 });
    // Both appends are durable history, but the RESOLVED set holds exactly one entry per environment.
    expect(store.readEvents(AGGREGATE)).toHaveLength(2);
    expect(record.stored()).toEqual({ ok: true, value: new Map([["staging", 45_000]]) });
  });
});

it("refuses with its store code when the append fails, without inventing a value", async () => {
  await withRecord((_record, store) => {
    const failing = createProbeIntervalRecord({
      projectId: PROJECT,
      store: { commit: () => { throw new Error("not disclosed"); }, readEvents: (id) => store.readEvents(id) },
    });
    expect(failing.write("staging", 30_000)).toEqual(refusal("PROBE_INTERVAL_STORE_FAILED"));
    expect(failing.read("staging")).toEqual({ ok: true, value: DEFAULT_PROBE_INTERVAL_MS });
  });
});

it("falls back to the default when a durable record no longer admits", async () => {
  await withRecord((record, store) => {
    expect(record.write("staging", 30_000)).toEqual({ ok: true, value: 30_000 });
    const payload = new TextEncoder().encode(JSON.stringify({ environment: "staging", intervalMs: 1 }));
    store.commit({
      aggregateId: AGGREGATE, commandId: "11111111-1111-4111-8111-111111111111", commandBytes: payload,
      committedAt: new Date(0).toISOString(), expectedVersion: store.getAggregateVersion(AGGREGATE),
      events: [{ eventId: "22222222-2222-4222-8222-222222222222", eventType: "moe.probe-interval.set", payload }],
    });
    // Fail CLOSED means the safe rate, never the unbounded one that was smuggled into the log.
    expect(record.read("staging")).toEqual({ ok: true, value: DEFAULT_PROBE_INTERVAL_MS });
    expect(record.stored()).toEqual({ ok: true, value: new Map() });
  });
});
