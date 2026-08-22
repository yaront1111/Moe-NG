import type { SqliteEventStore } from "@moe/store";

import { exactDataRecord } from "./recovery-inventory-contract.js";
import type { RecoveryInventoryRefusal } from "./recovery-inventory-contract.js";
import {
  DURABLE_INVENTORY_COMMAND_KIND,
  DURABLE_INVENTORY_REFUSALS,
  DURABLE_INVENTORY_ROW_EVENT_TYPE,
  DURABLE_INVENTORY_SEAL_EVENT_TYPE,
  DURABLE_RECOVERY_INVENTORY_SCHEMA_VERSION,
  MAX_DURABLE_INVENTORY_ROWS,
  durableInventoryDigest,
} from "./durable-recovery-inventory-contract.js";
import type {
  DurableInventoryClassCoverage,
  DurableInventoryClassSeal,
  DurableInventoryObservation,
  DurableInventoryProofFragment,
  DurableInventorySeal,
  DurableRecoveryInventoryClass,
} from "./durable-recovery-inventory-contract.js";
import {
  durableObservationIdentity,
  isInDurableWindow,
  readDurableInventoryCoverage,
  readDurableInventoryObservation,
} from "./durable-recovery-inventory-shape.js";
import {
  durableRowBody,
  durableSealBody,
  encodeDurableRow,
  encodeDurableSeal,
  isDurableRefusal,
  readDurableRecoveryInventory,
  resolveDurableWindow,
} from "./durable-recovery-inventory-reader.js";
import type { DurableInventoryRow } from "./durable-recovery-inventory-reader.js";

/**
 * Durable enumeration for the two recovery populations no node adapter can
 * reach, over the PUBLIC `SqliteEventStore` decision surface — no schema change
 * and no raw SQLite. One aggregate holds one window, addressed by a digest that
 * binds the project, the backup cursor/generation and the store-selected
 * recovery incarnation, so a window sealed under one identity is unreachable
 * from another instead of being re-answered with.
 *
 * The selected refs are READ from the ACTIVE slot and the anchor and never
 * accepted from a caller: a restored credential must not be able to nominate
 * which recovery identity is "current" by putting it in a request. Nothing here
 * decides adoption, quarantine, signing authority or `recovery.complete`.
 */
export interface DurableInventoryWriteRequest {
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly principalId: string;
  readonly projectId: string;
}

export interface DurableInventoryAppended {
  readonly authority: "NONE";
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly ok: true;
  readonly outcome: "APPENDED";
  readonly row: DurableInventoryRow;
}

export interface DurableInventorySealed {
  readonly authority: "NONE";
  readonly ok: true;
  readonly outcome: "SEALED";
  readonly seal: DurableInventorySeal;
  readonly sealDigest: string;
}

export interface DurableInventoryClassEnumerated {
  readonly authority: "NONE";
  readonly class: DurableRecoveryInventoryClass;
  readonly itemCount: number;
  readonly observations: readonly DurableInventoryObservation[];
  readonly ok: true;
  readonly outcome: "ENUMERATED";
  readonly proof: DurableInventoryProofFragment;
}

export interface DurableRecoveryInventoryRegistration {
  readonly class: DurableRecoveryInventoryClass;
  readonly enumerate: (
    basis: unknown,
    window: unknown,
  ) => DurableInventoryClassEnumerated | RecoveryInventoryRefusal;
}

const R = DURABLE_INVENTORY_REFUSALS;
const REQUEST_KEYS = Object.freeze(["correlationId", "decidedAt", "principalId", "projectId"]);

function readWriteRequest(value: unknown): DurableInventoryWriteRequest | null {
  const raw = exactDataRecord(value, REQUEST_KEYS);
  if (raw === null) return null;
  if (REQUEST_KEYS.some((key) => typeof raw[key] !== "string" || raw[key] === "")) return null;
  return raw as unknown as DurableInventoryWriteRequest;
}

/**
 * One expected-version commit. There is deliberately no catch-all: a genuine
 * store fault must keep throwing, since reporting a database failure as a
 * benign refusal is exactly how a recovery inventory gains false authority.
 */
function commit(
  store: SqliteEventStore,
  request: DurableInventoryWriteRequest,
  aggregateId: string,
  expectedVersion: number,
  event: { readonly commandId: string; readonly eventType: string; readonly bytes: Uint8Array },
): boolean {
  const response = store.commitExpectedVersionDecision({
    commandKind: DURABLE_INVENTORY_COMMAND_KIND,
    committedResultBytes: event.bytes,
    correlationId: request.correlationId,
    decidedAt: request.decidedAt,
    events: [
      {
        domainSchemaVersion: DURABLE_RECOVERY_INVENTORY_SCHEMA_VERSION,
        eventId: `${event.commandId}:${event.eventType}`,
        eventType: event.eventType,
        payload: event.bytes,
      },
    ],
    expectedVersion,
    key: {
      commandId: event.commandId,
      principalId: request.principalId,
      projectId: request.projectId,
    },
    requestBytes: event.bytes,
    targetAggregateId: aggregateId,
  });
  return response.decision.effectDisposition === "EFFECTS_COMMITTED";
}

/**
 * Appends ONE observation. An identical row already stored replays; a different
 * row under the same identity is refused rather than overwritten, because a
 * durable inventory whose last writer wins proves nothing about the population.
 *
 * `expectedVersion` is the version observed in the same pass, so an append that
 * races a seal loses the version conflict instead of landing behind it.
 *
 * The writer holds the reader's row bound from the other side. The reader
 * refuses any window holding MORE than `MAX_DURABLE_INVENTORY_ROWS`, so a row
 * past the bound that reached the store would leave the window unsealable and
 * unenumerable for good; it is refused here instead, before the commit. A
 * window holding exactly the bound is full, valid and sealable, and a replay of
 * a row it already holds still answers above the bound.
 */
export function appendDurableInventoryObservation(
  store: SqliteEventStore,
  request: unknown,
  rawBasis: unknown,
  rawWindow: unknown,
  rawObservation: unknown,
): DurableInventoryAppended | RecoveryInventoryRefusal {
  const scoped = readWriteRequest(request);
  const observation = readDurableInventoryObservation(rawObservation);
  if (scoped === null || observation === null) return R.INPUT_INVALID;
  const resolved = resolveDurableWindow(store, scoped.projectId, rawBasis, rawWindow);
  if (isDurableRefusal(resolved)) return resolved;
  if (!isInDurableWindow(observation, resolved.window)) return R.OUT_OF_WINDOW;
  if (resolved.state.sealed) return R.CONFLICT;

  const identity = durableObservationIdentity(observation);
  const body = {
    class: observation.class, identity, observation, scopeDigest: resolved.scopeDigest,
  };
  const row: DurableInventoryRow = Object.freeze({
    ...body, rowDigest: durableInventoryDigest(durableRowBody(body)),
  });
  const existing = resolved.state.rows.find((stored) => stored.identity === identity);
  if (existing !== undefined) {
    if (existing.rowDigest !== row.rowDigest) return R.DUPLICATE;
    return Object.freeze({
      authority: "NONE" as const, disposition: "REPLAYED" as const, ok: true as const,
      outcome: "APPENDED" as const, row,
    });
  }
  if (resolved.state.rows.length >= MAX_DURABLE_INVENTORY_ROWS) return R.WINDOW_FULL;
  const committed = commit(store, scoped, resolved.aggregateId, resolved.state.version, {
    bytes: encodeDurableRow(row),
    commandId: `durable-inventory-row:${row.rowDigest}`,
    eventType: DURABLE_INVENTORY_ROW_EVENT_TYPE,
  });
  if (!committed) return R.CONFLICT;
  return Object.freeze({
    authority: "NONE" as const, disposition: "DECIDED" as const, ok: true as const,
    outcome: "APPENDED" as const, row,
  });
}

/**
 * Per-class completeness, computed from the STORE and never from the caller.
 * A class with no rows is COMPLETE only against a bound negative proof, and a
 * negative proof offered for a class that DID store rows is a contradiction:
 * both directions must refuse, or "proven absent" degrades into "not looked at".
 */
function sealClasses(
  rows: readonly DurableInventoryRow[],
  coverage: readonly DurableInventoryClassCoverage[],
): readonly DurableInventoryClassSeal[] | RecoveryInventoryRefusal {
  const classes: DurableInventoryClassSeal[] = [];
  for (const entry of coverage) {
    const digests = rows
      .filter((row) => row.class === entry.class)
      .map((row) => row.rowDigest)
      .sort();
    if (digests.length === 0 && entry.negativeProofDigest === null) return R.PROOF_MISSING;
    if (digests.length > 0 && entry.negativeProofDigest !== null) return R.CONFLICT;
    classes.push(Object.freeze({
      class: entry.class,
      itemCount: digests.length,
      negativeProofDigest: entry.negativeProofDigest,
      rowDigests: Object.freeze(digests),
      sourceProofDigest: entry.sourceProofDigest,
      truth: "COMPLETE" as const,
    }));
  }
  return Object.freeze(classes);
}

/**
 * Seals ONE window terminally, committing per-class counts and ordered row
 * digests taken from the store. The stored global position of the seal is the
 * window's inclusive end, so the sealed set and the cursor range it claims are
 * one immutable fact.
 */
export function sealDurableInventoryWindow(
  store: SqliteEventStore,
  request: unknown,
  rawBasis: unknown,
  rawWindow: unknown,
  rawCoverage: unknown,
): DurableInventorySealed | RecoveryInventoryRefusal {
  const scoped = readWriteRequest(request);
  const coverage = readDurableInventoryCoverage(rawCoverage);
  if (scoped === null || coverage === null) return R.INPUT_INVALID;
  const resolved = resolveDurableWindow(store, scoped.projectId, rawBasis, rawWindow);
  if (isDurableRefusal(resolved)) return resolved;
  if (resolved.state.sealed) return R.CONFLICT;

  const classes = sealClasses(resolved.state.rows, coverage);
  if (!Array.isArray(classes)) return classes as RecoveryInventoryRefusal;
  const sealedClasses = classes as readonly DurableInventoryClassSeal[];
  // Every stored row must belong to exactly one sealed class: a row whose class
  // no coverage entry claims would leave the window silently under-reported.
  const covered = sealedClasses.reduce((total, entry) => total + entry.itemCount, 0);
  if (covered !== resolved.state.rows.length) return R.CONFLICT;

  const seal: DurableInventorySeal = Object.freeze({
    classes: sealedClasses,
    scopeDigest: resolved.scopeDigest,
    windowEndInclusive: resolved.window.endInclusive,
    windowStartExclusive: resolved.window.startExclusive,
  });
  const sealDigest = durableInventoryDigest(durableSealBody(seal));
  const committed = commit(store, scoped, resolved.aggregateId, resolved.state.version, {
    bytes: encodeDurableSeal(seal, sealDigest),
    commandId: `durable-inventory-seal:${sealDigest}`,
    eventType: DURABLE_INVENTORY_SEAL_EVENT_TYPE,
  });
  if (!committed) return R.CONFLICT;
  return Object.freeze({
    authority: "NONE" as const, ok: true as const, outcome: "SEALED" as const, seal, sealDigest,
  });
}

/**
 * The daemon-facing bridge: one frozen registration per class, each enumerator
 * taking ONLY a basis and a window. There is no mutable global registry and no
 * caller item list — an enumerator that accepted items would let a caller hand
 * the daemon its own answer and have it counted as durable evidence. Each call
 * returns a fresh frozen tuple, so two holders cannot observe each other.
 */
export function createDurableRecoveryInventoryRegistrations(
  store: SqliteEventStore,
  projectId: string,
): readonly [DurableRecoveryInventoryRegistration, DurableRecoveryInventoryRegistration] {
  const enumerateClass = (
    inventoryClass: DurableRecoveryInventoryClass,
    basis: unknown,
    window: unknown,
  ): DurableInventoryClassEnumerated | RecoveryInventoryRefusal => {
    const read = readDurableRecoveryInventory(store, projectId, basis, window);
    if (!read.ok) return read;
    const sealed = read.classes.find((entry) => entry.class === inventoryClass);
    if (sealed === undefined) return R.CONFLICT;
    const observations = Object.freeze(
      read.observations.filter((observation) => observation.class === inventoryClass),
    );
    if (observations.length !== sealed.itemCount) return R.CONFLICT;
    return Object.freeze({
      authority: "NONE" as const,
      class: inventoryClass,
      itemCount: sealed.itemCount,
      observations,
      ok: true as const,
      outcome: "ENUMERATED" as const,
      proof: Object.freeze({
        class: inventoryClass,
        sourceProofDigest: sealed.sourceProofDigest,
        truth: sealed.truth,
        upstream: null,
      }),
    });
  };
  return Object.freeze([
    Object.freeze({
      class: "RESOURCE" as const,
      enumerate: (basis: unknown, window: unknown) => enumerateClass("RESOURCE", basis, window),
    }),
    Object.freeze({
      class: "INTEGRATION_TARGET" as const,
      enumerate: (basis: unknown, window: unknown) =>
        enumerateClass("INTEGRATION_TARGET", basis, window),
    }),
  ] as const);
}
