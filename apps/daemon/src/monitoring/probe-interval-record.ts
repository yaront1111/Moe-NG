import { randomUUID } from "node:crypto";
import type { SqliteEventStore } from "@moe/store";
import { admitEnvironmentName } from "../deployment/deploy-receipt-contracts.js";

/**
 * The per-environment health-probe interval, as a durable operator setting.
 *
 * ONE source of truth for the default. The scheduler composition and the health read both resolve
 * the effective value through this module; a second copy of `60_000` anywhere else would be a
 * second answer to the same question, and the two would drift the first time one of them moved.
 */
export const DEFAULT_PROBE_INTERVAL_MS = 60_000;

/**
 * Bounds are deliberately TIGHTER than the scheduler's `validInterval` (integer, >0, <=2^31-1).
 * That guard exists to stop `setInterval` being handed nonsense; this one exists to stop an
 * operator hurting themselves. Below five seconds a probe is a self-inflicted load generator
 * against the very environment it is meant to be watching; above an hour the signal arrives long
 * after the outage is over, which is not monitoring. Both ends are INCLUSIVE.
 */
export const MIN_PROBE_INTERVAL_MS = 5_000;
export const MAX_PROBE_INTERVAL_MS = 3_600_000;

const EVENT = "moe.probe-interval.set";

/** This module's own faults. The scheduler's `ScheduleCode` is about scheduling and stays closed. */
export type ProbeIntervalCode =
  | "PROBE_INTERVAL_OUT_OF_RANGE"
  | "PROBE_INTERVAL_ENVIRONMENT_INVALID"
  | "PROBE_INTERVAL_STORE_FAILED";

export interface ProbeIntervalRefusal {
  readonly ok: false;
  readonly code: ProbeIntervalCode;
  readonly layer: "DAEMON_INGRESS";
}

export type ProbeIntervalResult<T> = Readonly<{ readonly ok: true; readonly value: T }> | ProbeIntervalRefusal;

export interface ProbeIntervalRecord {
  /** The EFFECTIVE interval: the stored one when set, `DEFAULT_PROBE_INTERVAL_MS` when unset. */
  read(environment: string): ProbeIntervalResult<number>;
  /** Replaces any prior value for the environment. Never accumulates. */
  write(environment: string, intervalMs: number): ProbeIntervalResult<number>;
  /** Only the environments that carry a STORED value. An unset environment is absent, not 60000. */
  stored(): ProbeIntervalResult<ReadonlyMap<string, number>>;
}

export interface ProbeIntervalConfig {
  readonly store: Pick<SqliteEventStore, "commit" | "readEvents">;
  readonly projectId: string;
  readonly now?: () => number;
}

const refuse = (code: ProbeIntervalCode): ProbeIntervalRefusal =>
  Object.freeze({ ok: false, code, layer: "DAEMON_INGRESS" } as const);
const accept = <T>(value: T): ProbeIntervalResult<T> => Object.freeze({ ok: true, value } as const);

/** Rejects NaN, Infinity, negatives, zero and non-integers before either bound is consulted. */
export function admitProbeInterval(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value)
    && value >= MIN_PROBE_INTERVAL_MS && value <= MAX_PROBE_INTERVAL_MS ? value : null;
}

export function createProbeIntervalRecord(config: ProbeIntervalConfig): ProbeIntervalRecord {
  const aggregateId = `probe-interval/${config.projectId}`;
  let version = 0;

  const replay = (): ReadonlyMap<string, number> => {
    const events = config.store.readEvents(aggregateId);
    version = events.at(-1)?.aggregateSequence ?? 0;
    const current = new Map<string, number>();
    for (const event of events) {
      let record: unknown;
      try { record = JSON.parse(new TextDecoder().decode(event.payload)); } catch { record = null; }
      const value = record !== null && typeof record === "object" && !Array.isArray(record)
        ? record as Record<string, unknown> : {};
      const environment = admitEnvironmentName(value["environment"]);
      if (environment === null) continue;
      const intervalMs = admitProbeInterval(value["intervalMs"]);
      // A record that no longer admits is dropped, so the environment falls back to the DEFAULT.
      // Failing closed here means the safe rate, never an unbounded or unparsed one.
      if (event.eventType !== EVENT || intervalMs === null) current.delete(environment);
      else current.set(environment, intervalMs);
    }
    return current;
  };

  const stored = (): ProbeIntervalResult<ReadonlyMap<string, number>> => {
    try { return accept(replay()); } catch { return refuse("PROBE_INTERVAL_STORE_FAILED"); }
  };

  return Object.freeze({
    read: (environment: string): ProbeIntervalResult<number> => {
      if (admitEnvironmentName(environment) === null) return refuse("PROBE_INTERVAL_ENVIRONMENT_INVALID");
      const all = stored();
      if (!all.ok) return all;
      return accept(all.value.get(environment) ?? DEFAULT_PROBE_INTERVAL_MS);
    },
    stored,
    write: (environment: string, intervalMs: number): ProbeIntervalResult<number> => {
      // Environment first, then the interval: a caller naming an environment that cannot exist is
      // told THAT, rather than being told its interval is out of range for a nonexistent target.
      if (admitEnvironmentName(environment) === null) return refuse("PROBE_INTERVAL_ENVIRONMENT_INVALID");
      if (admitProbeInterval(intervalMs) === null) return refuse("PROBE_INTERVAL_OUT_OF_RANGE");
      const payload = new TextEncoder().encode(JSON.stringify({ environment, intervalMs }));
      try {
        replay(); // Refresh `version` against the SAME snapshot this append is written on top of.
        config.store.commit({
          aggregateId, commandId: randomUUID(), commandBytes: payload,
          committedAt: new Date((config.now ?? Date.now)()).toISOString(),
          expectedVersion: version,
          events: [{ eventId: randomUUID(), eventType: EVENT, payload }],
        });
      } catch { return refuse("PROBE_INTERVAL_STORE_FAILED"); }
      return accept(intervalMs);
    },
  });
}
