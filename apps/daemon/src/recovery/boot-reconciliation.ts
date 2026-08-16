/**
 * The BOOT-PATH caller of restart reconciliation — the daemon's first and only
 * production caller of `reconcileOnRestart`.
 *
 * It composes two finished producers and adds no authority of its own:
 * `readInFlightFoundationAttempts` answers WHICH attempts were in flight when the
 * process died, and `reconcileOnRestart` durably records what became of each.
 * Neither is modified here; this module is the consumer edge that was missing.
 *
 * TWO INDEPENDENT REFUSAL SOURCES, KEPT DISTINCT. "I could not read what was in
 * flight" and "I could not durably record the classification" are different facts
 * with different remedies, so each travels out under ITS OWN code and layer with a
 * `source` naming which producer spoke. The two carry that layer under different
 * field names — `FoundationAttemptRefused.refusedBy` and
 * `RestartReconciliationResult.layer` — and mapping them onto one shape is the
 * only translation done here. Flattening either into a single entry code would
 * leave an operator unable to tell an unreadable store from a lost race.
 *
 * THE REQUEST IS BUILT FROM BOOT FACTS. `projectId` and `principalId` come from
 * the durable configuration this port is constructed with; `correlationId` and
 * `decidedAt` are minted per sweep as server facts. Nothing a caller of
 * `startDaemon` can supply reaches this request — a start option able to set the
 * principal would let a caller attribute a reconciliation to someone else.
 */

import type { SqliteEventStore } from "@moe/store";

import { readInFlightFoundationAttempts } from "../work/in-flight-attempts.js";
import { reconcileOnRestart } from "./restart-reconciliation.js";

/** Which producer refused. Closed, so a consumer can switch exhaustively. */
export const BOOT_RECONCILIATION_SOURCES = Object.freeze([
  "IN_FLIGHT_SWEEP",
  "RESTART_RECONCILIATION",
] as const);

export type BootReconciliationSource = (typeof BOOT_RECONCILIATION_SOURCES)[number];

export interface BootReconciliationRefused {
  readonly code: string;
  readonly layer: string;
  readonly ok: false;
  readonly source: BootReconciliationSource;
}

export type BootReconciliationResult =
  | { readonly classified: number; readonly ok: true }
  | BootReconciliationRefused;

/** The seam the boot path sees. It cannot reach the store, only this verdict. */
export interface BootReconciliationPort {
  sweep(): BootReconciliationResult;
}

export interface BootReconciliationConfig {
  readonly clock: () => string;
  readonly correlationId: () => string;
  readonly principalId: string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

function refuse(source: BootReconciliationSource, code: string, layer: string): BootReconciliationRefused {
  return Object.freeze({ code, layer, ok: false as const, source });
}

export function createBootReconciliationPort(
  config: BootReconciliationConfig,
): BootReconciliationPort {
  const sweep = (): BootReconciliationResult => {
    const inFlight = readInFlightFoundationAttempts(config.store, config.projectId);
    // `refusedBy` IS this producer's layer; it is copied, never renamed to the
    // daemon's own, so the layer that made the decision stays visible.
    if (!inFlight.ok) return refuse("IN_FLIGHT_SWEEP", inFlight.code, inFlight.refusedBy);

    const reconciled = reconcileOnRestart(config.store, {
      attempts: inFlight.attempts,
      correlationId: config.correlationId(),
      decidedAt: config.clock(),
      principalId: config.principalId,
      projectId: config.projectId,
    });
    if (!reconciled.ok) return refuse("RESTART_RECONCILIATION", reconciled.code, reconciled.layer);

    return Object.freeze({ classified: reconciled.records.length, ok: true as const });
  };
  return Object.freeze({ sweep });
}
