import { randomUUID } from "node:crypto";
import type { SqliteEventStore } from "@moe/store";
import { admitEnvironmentName } from "../deployment/deploy-receipt-contracts.js";
import { readDeployLedger } from "../deployment/deploy-ledger.js";
import type { EnvironmentDeployState } from "../deployment/deploy-ledger.js";

export type EnvironmentRetirementCode =
  | "ENVIRONMENT_RETIREMENT_ENVIRONMENT_INVALID"
  | "ENVIRONMENT_RETIREMENT_ENVIRONMENT_UNKNOWN"
  | "ENVIRONMENT_RETIREMENT_RECORD_INVALID"
  | "ENVIRONMENT_RETIREMENT_STORE_FAILED";
export type EnvironmentRetirementResult<T> = Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: EnvironmentRetirementCode; layer: "DAEMON_INGRESS" }>;
export interface EnvironmentRetirementRecord {
  /** Effective retirement of the latest successful deployment generation, not a permanent tombstone. */
  read(environment: string): EnvironmentRetirementResult<boolean>;
  /** Fresh snapshot of effectively retired environments. Caller mutation cannot alter durable state. */
  stored(): EnvironmentRetirementResult<ReadonlyMap<string, true>>;
  /** Retires the observed successful receipt; idempotent until another successful deploy lands. */
  write(environment: string): EnvironmentRetirementResult<true>;
}
export interface EnvironmentRetirementConfig {
  readonly store: SqliteEventStore;
  readonly projectId: string;
  readonly now?: () => number;
}

const EVENT = "moe.environment.retired";
const accept = <T>(value: T) => Object.freeze({ ok: true, value } as const);
const refuse = (code: EnvironmentRetirementCode) => Object.freeze({ ok: false, code, layer: "DAEMON_INGRESS" } as const);
interface Retirement {
  readonly version: 1;
  readonly environment: string;
  readonly retiredThroughReceiptId: string | null;
}
interface Snapshot {
  readonly version: number;
  readonly ledger: ReadonlyMap<string, EnvironmentDeployState>;
  readonly retired: ReadonlyMap<string, true>;
}

function decode(payload: Uint8Array): Retirement | null {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)); }
  catch { return null; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length !== 3 || !keys.every((key) => ["version", "environment", "retiredThroughReceiptId"].includes(key))) return null;
  const environment = admitEnvironmentName(fields.environment), cutoff = fields.retiredThroughReceiptId;
  if (fields.version !== 1 || environment === null || (cutoff !== null && typeof cutoff !== "string")) return null;
  return { version: 1, environment, retiredThroughReceiptId: cutoff };
}

function latestSuccessful(state: EnvironmentDeployState): string | null {
  return state.receipts.findLast((receipt) => receipt.outcome === "DEPLOYED")?.receiptId ?? null;
}

function replay(config: EnvironmentRetirementConfig): EnvironmentRetirementResult<Snapshot> {
  try {
    const events = config.store.readEvents(`environment-retirement/${config.projectId}`);
    const ledger = readDeployLedger(config.store, config.projectId);
    const cutoffs = new Map<string, string | null>();
    for (const event of events) {
      const retirement = decode(event.payload);
      if (event.eventType !== EVENT || retirement === null) return refuse("ENVIRONMENT_RETIREMENT_RECORD_INVALID");
      const state = ledger.get(retirement.environment), cutoff = retirement.retiredThroughReceiptId;
      if (state === undefined || (cutoff !== null && !state.receipts.some((receipt) =>
        receipt.outcome === "DEPLOYED" && receipt.receiptId === cutoff))) return refuse("ENVIRONMENT_RETIREMENT_RECORD_INVALID");
      cutoffs.set(retirement.environment, cutoff);
    }
    const retired = new Map<string, true>();
    for (const [environment, cutoff] of cutoffs) {
      const state = ledger.get(environment);
      if (state !== undefined && latestSuccessful(state) === cutoff) retired.set(environment, true);
    }
    return accept({ version: events.at(-1)?.aggregateSequence ?? 0, ledger, retired });
  } catch { return refuse("ENVIRONMENT_RETIREMENT_STORE_FAILED"); }
}

function write(config: EnvironmentRetirementConfig, environment: string): EnvironmentRetirementResult<true> {
  if (admitEnvironmentName(environment) === null) return refuse("ENVIRONMENT_RETIREMENT_ENVIRONMENT_INVALID");
  const snapshot = replay(config);
  if (!snapshot.ok) return snapshot;
  const state = snapshot.value.ledger.get(environment);
  if (state === undefined) return refuse("ENVIRONMENT_RETIREMENT_ENVIRONMENT_UNKNOWN");
  if (snapshot.value.retired.has(environment)) return accept(true);
  try {
    const retirement: Retirement = { version: 1, environment, retiredThroughReceiptId: latestSuccessful(state) };
    const payload = new TextEncoder().encode(JSON.stringify(retirement));
    config.store.commit({ aggregateId: `environment-retirement/${config.projectId}`,
      commandId: randomUUID(), commandBytes: payload, expectedVersion: snapshot.value.version,
      committedAt: new Date((config.now ?? Date.now)()).toISOString(),
      events: [{ eventId: randomUUID(), eventType: EVENT, payload }] });
    return accept(true);
  } catch { return refuse("ENVIRONMENT_RETIREMENT_STORE_FAILED"); }
}

/** Retirement never edits the deploy ledger or probe ring. A new successful receipt (even same SHA)
 * ends effective retirement; refused attempts do not. Each call replays fresh state. This records the
 * generation observed by write, not an atomic transaction across retirement and deployment aggregates. */
export function createEnvironmentRetirementRecord(config: EnvironmentRetirementConfig): EnvironmentRetirementRecord {
  return Object.freeze({
    read: (environment: string): EnvironmentRetirementResult<boolean> => {
      if (admitEnvironmentName(environment) === null) return refuse("ENVIRONMENT_RETIREMENT_ENVIRONMENT_INVALID");
      const snapshot = replay(config);
      return snapshot.ok ? accept(snapshot.value.retired.has(environment)) : snapshot;
    },
    stored: (): EnvironmentRetirementResult<ReadonlyMap<string, true>> => {
      const snapshot = replay(config);
      return snapshot.ok ? accept(snapshot.value.retired) : snapshot;
    },
    write: (environment: string) => write(config, environment),
  });
}
