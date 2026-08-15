import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { readCurrentRecoveryAuthenticationBinding } from "../identity/recovery-authentication-binding.js";
import { readAnchoredIncarnation } from "./recovery-incarnation-anchor.js";
import { exactDataRecord } from "./recovery-inventory-contract.js";
import type { RecoveryInventoryRefusal } from "./recovery-inventory-contract.js";
import {
  DURABLE_INVENTORY_COMMAND_KIND,
  DURABLE_INVENTORY_REFUSALS,
  DURABLE_INVENTORY_ROW_EVENT_TYPE,
  DURABLE_INVENTORY_SEAL_EVENT_TYPE,
  DURABLE_RECOVERY_INVENTORY_SCHEMA_VERSION,
  MAX_DURABLE_INVENTORY_BYTES,
  MAX_DURABLE_INVENTORY_ROWS,
  durableInventoryAggregateId,
  durableInventoryBytes,
  durableInventoryDigest,
  durableInventoryScopeDigest,
} from "./durable-recovery-inventory-contract.js";
import type {
  DurableInventoryBasis,
  DurableInventoryClassSeal,
  DurableInventoryObservation,
  DurableInventorySeal,
  DurableInventorySelectedScope,
  DurableInventoryWindow,
  DurableRecoveryInventoryClass,
} from "./durable-recovery-inventory-contract.js";
import {
  durableObservationIdentity,
  isInDurableWindow,
  readDurableInventoryBasis,
  readDurableInventoryObservation,
  readDurableInventoryWindow,
  readDurableSealClasses,
} from "./durable-recovery-inventory-shape.js";

/**
 * The read half of the durable inventory: scope resolution, canonical row/seal
 * bytes, bounded aggregate pagination and the sealed enumeration. Split from
 * `./durable-recovery-inventory.ts`, which owns appending and sealing. The
 * dependency runs one way, writer to reader, and never back.
 */
export interface DurableInventoryRow {
  readonly class: DurableRecoveryInventoryClass;
  readonly identity: string;
  readonly observation: DurableInventoryObservation;
  readonly rowDigest: string;
  readonly scopeDigest: string;
}

export interface DurableInventoryEnumerated {
  readonly authority: "NONE";
  readonly classes: readonly DurableInventoryClassSeal[];
  readonly observations: readonly DurableInventoryObservation[];
  readonly ok: true;
  readonly outcome: "ENUMERATED";
  readonly sealDigest: string;
  readonly truth: "COMPLETE";
}

export interface DurableWindowState {
  readonly rows: readonly DurableInventoryRow[];
  readonly sealed: boolean;
  readonly version: number;
}

export interface DurableResolvedWindow {
  readonly aggregateId: string;
  readonly basis: DurableInventoryBasis;
  readonly projectId: string;
  readonly scopeDigest: string;
  readonly state: DurableWindowState;
  readonly window: DurableInventoryWindow;
}

const R = DURABLE_INVENTORY_REFUSALS;
const SEAL_KEYS = Object.freeze([
  "classes", "kind", "schemaVersion", "scopeDigest", "sealDigest", "windowEndInclusive",
  "windowStartExclusive",
]);
const ROW_KEYS = Object.freeze([
  "class", "identity", "kind", "observation", "rowDigest", "schemaVersion", "scopeDigest",
]);

export const sameDurableBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

export const isDurableRefusal = (value: object): value is RecoveryInventoryRefusal =>
  "ok" in value && value.ok === false;

/** Bounded BEFORE decoding: an oversized payload is refused, never parsed. */
const parseJson = (bytes: Uint8Array): unknown => {
  if (bytes.length === 0 || bytes.length > MAX_DURABLE_INVENTORY_BYTES) return undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
};

export const durableRowBody = (row: Omit<DurableInventoryRow, "rowDigest">): object => ({
  class: row.class,
  identity: row.identity,
  kind: "ROW",
  observation: { ...row.observation },
  schemaVersion: DURABLE_RECOVERY_INVENTORY_SCHEMA_VERSION,
  scopeDigest: row.scopeDigest,
});

export const durableSealBody = (seal: DurableInventorySeal): object => ({
  classes: seal.classes.map((entry) => ({
    class: entry.class,
    itemCount: entry.itemCount,
    negativeProofDigest: entry.negativeProofDigest,
    rowDigests: [...entry.rowDigests],
    sourceProofDigest: entry.sourceProofDigest,
    truth: entry.truth,
  })),
  kind: "SEAL",
  schemaVersion: DURABLE_RECOVERY_INVENTORY_SCHEMA_VERSION,
  scopeDigest: seal.scopeDigest,
  windowEndInclusive: seal.windowEndInclusive,
  windowStartExclusive: seal.windowStartExclusive,
});

export const encodeDurableRow = (row: DurableInventoryRow): Uint8Array =>
  durableInventoryBytes({ ...durableRowBody(row), rowDigest: row.rowDigest });

export const encodeDurableSeal = (seal: DurableInventorySeal, sealDigest: string): Uint8Array =>
  durableInventoryBytes({ ...durableSealBody(seal), sealDigest });

/**
 * Semantics are re-derived BEFORE the digest is trusted: a forgery re-hashed
 * through this same surface is canonical and correctly digested, so a
 * digest-first decoder would wave it through. The re-encode comparison then
 * refuses any second canonical spelling of one body.
 */
function decodeRow(bytes: Uint8Array, scopeDigest: string): DurableInventoryRow | null {
  const raw = exactDataRecord(parseJson(bytes), ROW_KEYS);
  if (raw === null || raw["kind"] !== "ROW") return null;
  if (raw["schemaVersion"] !== DURABLE_RECOVERY_INVENTORY_SCHEMA_VERSION) return null;
  if (raw["scopeDigest"] !== scopeDigest) return null;
  const observation = readDurableInventoryObservation(raw["observation"]);
  if (observation === null || raw["class"] !== observation.class) return null;
  if (raw["identity"] !== durableObservationIdentity(observation)) return null;
  const body = { class: observation.class, identity: raw["identity"], observation, scopeDigest };
  if (durableInventoryDigest(durableRowBody(body)) !== raw["rowDigest"]) return null;
  const row = Object.freeze({ ...body, rowDigest: raw["rowDigest"] as string });
  return sameDurableBytes(encodeDurableRow(row), bytes) ? row : null;
}

/**
 * The selected scope, derived only from store state. `getHealth` owns project
 * identity, the ACTIVE slot owns the current incarnation, and the anchor owns
 * the generation this window may cover — a caller-supplied generation the
 * anchored incarnation never restored is a mismatch, not a new window.
 */
function resolveScope(
  store: SqliteEventStore,
  projectId: string,
  basis: DurableInventoryBasis,
): DurableInventorySelectedScope | RecoveryInventoryRefusal {
  let storeProjectId: string | null;
  try {
    storeProjectId = store.getHealth().projectId;
  } catch {
    return R.UNREADABLE;
  }
  if (storeProjectId === null || storeProjectId !== projectId) return R.INPUT_INVALID;
  const selected = readCurrentRecoveryAuthenticationBinding(store);
  if (selected === null) return R.BINDING_UNAVAILABLE;
  const anchored = readAnchoredIncarnation(store, projectId, selected.recoveryIncarnationRef);
  if (anchored === null) return R.ANCHOR_UNAVAILABLE;
  if (anchored.incarnationRef !== selected.recoveryIncarnationRef) return R.BINDING_MISMATCH;
  if (anchored.keyEpochRef !== selected.keyEpochRef) return R.BINDING_MISMATCH;
  // Read as absent rather than invented: a genesis binding was never restored
  // and carries no generation, so this stays fail-closed for every shape.
  const generation = "backupGenerationDigest" in anchored ? anchored.backupGenerationDigest : null;
  if (generation !== basis.backupGenerationDigest) return R.BINDING_MISMATCH;
  return Object.freeze({
    anchorBindingDigest: anchored.bindingDigest,
    incarnationRef: anchored.incarnationRef,
    keyEpochRef: anchored.keyEpochRef,
    projectId,
  });
}

/**
 * Every event in this aggregate must carry THIS command's own decision trace,
 * scoped to this project, at the next contiguous sequence. A row filed into the
 * window by some other command, or a gap where an event was skipped, is not
 * evidence about the population and must not be read as part of it.
 */
function isOwnEvent(event: StoredEvent, projectId: string, expectedSequence: number): boolean {
  return (
    event.aggregateSequence === expectedSequence &&
    event.decisionTrace !== undefined &&
    event.decisionTrace.commandKind === DURABLE_INVENTORY_COMMAND_KIND &&
    event.decisionTrace.projectId === projectId
  );
}

/**
 * Bounded pagination over the ONE aggregate this window owns. The seal must be
 * terminal: an event after it means the window is not a single consistent set,
 * which is a conflict rather than a longer list.
 */
function readWindowState(
  store: SqliteEventStore,
  aggregateId: string,
  scopeDigest: string,
  projectId: string,
): DurableWindowState | RecoveryInventoryRefusal {
  const rows: DurableInventoryRow[] = [];
  const identities = new Set<string>();
  let sealed = false;
  let after = 0;
  let sequence = 0;
  for (;;) {
    let page: { readonly items: readonly StoredEvent[]; readonly hasMore: boolean };
    let next: number | null;
    try {
      const read = store.readAggregateEvents(aggregateId, after, 100);
      page = read;
      next = read.nextCursor;
    } catch {
      return R.UNREADABLE;
    }
    for (const event of page.items) {
      if (sealed) return R.CONFLICT;
      sequence += 1;
      if (!isOwnEvent(event, projectId, sequence)) return R.CONFLICT;
      if (event.eventType === DURABLE_INVENTORY_SEAL_EVENT_TYPE) { sealed = true; continue; }
      if (event.eventType !== DURABLE_INVENTORY_ROW_EVENT_TYPE) return R.CONFLICT;
      const row = decodeRow(event.payload, scopeDigest);
      if (row === null) return R.UNREADABLE;
      if (identities.has(row.identity)) return R.DUPLICATE;
      identities.add(row.identity);
      rows.push(row);
      if (rows.length > MAX_DURABLE_INVENTORY_ROWS) return R.CONFLICT;
    }
    if (!page.hasMore || next === null) break;
    after = next;
  }
  return { rows: Object.freeze(rows), sealed, version: rows.length + (sealed ? 1 : 0) };
}

/** One validation order for every entry point, so refusal precedence is fixed. */
export function resolveDurableWindow(
  store: SqliteEventStore,
  projectId: string,
  rawBasis: unknown,
  rawWindow: unknown,
): DurableResolvedWindow | RecoveryInventoryRefusal {
  const basis = readDurableInventoryBasis(rawBasis);
  const window = readDurableInventoryWindow(rawWindow);
  if (basis === null || window === null) return R.INPUT_INVALID;
  // The window's start IS the backup cursor; a drifted start would silently
  // widen or narrow the population the seal later claims to have covered.
  if (window.startExclusive !== basis.backupCursor) return R.INPUT_INVALID;
  const scope = resolveScope(store, projectId, basis);
  if (isDurableRefusal(scope)) return scope;
  const scopeDigest = durableInventoryScopeDigest(scope, basis, window);
  const aggregateId = durableInventoryAggregateId(scopeDigest);
  const state = readWindowState(store, aggregateId, scopeDigest, projectId);
  if (isDurableRefusal(state)) return state;
  return { aggregateId, basis, projectId, scopeDigest, state, window };
}

interface StoredSeal {
  readonly seal: DurableInventorySeal;
  readonly sealDigest: string;
}

/** Re-derives the seal from its own bytes; a stored count is never trusted raw. */
function readStoredSeal(
  store: SqliteEventStore,
  resolved: DurableResolvedWindow,
): StoredSeal | RecoveryInventoryRefusal {
  let events: readonly StoredEvent[];
  try {
    events = store.readAggregateEvents(resolved.aggregateId, resolved.state.rows.length, 2).items;
  } catch {
    return R.UNREADABLE;
  }
  const event = events[0];
  if (events.length !== 1 || event === undefined) return R.CONFLICT;
  if (event.eventType !== DURABLE_INVENTORY_SEAL_EVENT_TYPE) return R.CONFLICT;
  if (!isOwnEvent(event, resolved.projectId, resolved.state.rows.length + 1)) return R.CONFLICT;
  const raw = exactDataRecord(parseJson(event.payload), SEAL_KEYS);
  if (raw === null || raw["kind"] !== "SEAL") return R.UNREADABLE;
  if (raw["schemaVersion"] !== DURABLE_RECOVERY_INVENTORY_SCHEMA_VERSION) return R.UNREADABLE;
  if (raw["scopeDigest"] !== resolved.scopeDigest) return R.CONFLICT;
  if (raw["windowEndInclusive"] !== resolved.window.endInclusive) return R.CONFLICT;
  if (raw["windowStartExclusive"] !== resolved.window.startExclusive) return R.CONFLICT;
  const classes = readDurableSealClasses(raw["classes"]);
  if (classes === null) return R.UNREADABLE;
  const seal: DurableInventorySeal = Object.freeze({
    classes,
    scopeDigest: resolved.scopeDigest,
    windowEndInclusive: resolved.window.endInclusive,
    windowStartExclusive: resolved.window.startExclusive,
  });
  const sealDigest = durableInventoryDigest(durableSealBody(seal));
  if (sealDigest !== raw["sealDigest"]) return R.UNREADABLE;
  if (!sameDurableBytes(encodeDurableSeal(seal, sealDigest), event.payload)) return R.UNREADABLE;
  return { seal, sealDigest };
}

/**
 * Reads ONE sealed window. Missing, partial or unverifiable evidence returns
 * the precise UNKNOWN tuple and never a partial list: an inventory that answers
 * with whatever it happened to find is the invented absence this area prevents.
 */
export function readDurableRecoveryInventory(
  store: SqliteEventStore,
  projectId: string,
  rawBasis: unknown,
  rawWindow: unknown,
): DurableInventoryEnumerated | RecoveryInventoryRefusal {
  if (typeof projectId !== "string" || projectId === "") return R.INPUT_INVALID;
  const resolved = resolveDurableWindow(store, projectId, rawBasis, rawWindow);
  if (isDurableRefusal(resolved)) return resolved;
  if (!resolved.state.sealed) return R.NOT_FOUND;
  const stored = readStoredSeal(store, resolved);
  if (isDurableRefusal(stored)) return stored;

  let covered = 0;
  for (const entry of stored.seal.classes) {
    const digests = resolved.state.rows
      .filter((row) => row.class === entry.class)
      .map((row) => row.rowDigest)
      .sort();
    if (digests.length !== entry.itemCount) return R.CONFLICT;
    if (digests.some((digest, index) => digest !== entry.rowDigests[index])) return R.CONFLICT;
    covered += digests.length;
  }
  // Every stored row belongs to exactly one sealed class, and every row still
  // lies inside the window its seal names.
  if (covered !== resolved.state.rows.length) return R.CONFLICT;
  const observations = resolved.state.rows.map((row) => row.observation);
  if (observations.some((observation) => !isInDurableWindow(observation, resolved.window))) {
    return R.CONFLICT;
  }
  return Object.freeze({
    authority: "NONE" as const,
    classes: stored.seal.classes,
    observations: Object.freeze(observations),
    ok: true as const,
    outcome: "ENUMERATED" as const,
    sealDigest: stored.sealDigest,
    truth: "COMPLETE" as const,
  });
}
