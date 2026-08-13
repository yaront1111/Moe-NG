/**
 * Resource acquisition vocabularies, shapes, and hostile-input parsers
 * (design 12.2 lines 753-755, plus 222 and 427).
 *
 * Split from `./lease-resource.ts` so the operations module stays focused, and
 * named `-model` to match the existing `graph-model` / `graph-preview-model`
 * convention in this package.
 */
import {
  MAX_AUTHORITY_ITEMS,
  compareStrings,
  exactRecord,
  isCount,
  isRef,
  makeIssue,
  oneOf,
  readList,
  reject,
  type AuthorityOutcome,
} from "./authority-kernel.js";
import { isPlainRecord, readOwnDataProperty } from "../runtime-shape.js";

/** String-identical to `RUNTIME_LIFECYCLES.PROVIDER_SLOT` and design line 222. */
export const SLOT_STATES = ["RESERVED", "ACTIVE", "RELEASED"] as const;
export const ACQUISITION_STATES = [
  "PENDING_ACQUIRE", "ACTIVE", "RELEASED", "QUARANTINED",
] as const;
export const ACQUISITION_FAILURES = ["FAILED", "UNKNOWN"] as const;

export type SlotState = (typeof SLOT_STATES)[number];
export type AcquisitionState = (typeof ACQUISITION_STATES)[number];
export type AcquisitionFailure = (typeof ACQUISITION_FAILURES)[number];

export interface DeclaredResource {
  readonly resourceId: string;
  readonly capacityUnits: number;
  /** An external resource needs an adapter confirmation before it becomes ACTIVE. */
  readonly external: boolean;
  /** False when the adapter cannot reject stale use, so rollback is never provable. */
  readonly fenceable: boolean;
}

export interface ReserveAllRequest {
  readonly requestId: string;
  readonly declaredResources: readonly DeclaredResource[];
  readonly capacitySnapshot: Readonly<Record<string, number>>;
  readonly epoch: number;
  readonly eligibilityEventSequenceRef: string;
  readonly continuouslyEligibleSinceRef: string;
  readonly callerObservation: string;
}

export interface ResourceRow {
  readonly resourceId: string;
  readonly capacityUnits: number;
  readonly epoch: number;
  readonly state: AcquisitionState;
  /** Deterministic, so a retried acquisition reuses the same effect intent. */
  readonly effectIntentRef: string;
  readonly external: boolean;
  readonly fenceable: boolean;
}

/**
 * Shape frozen now for M2's fair scheduler. Priority, ticket, and aging state
 * are deliberately absent: M2 owns queue selection, and "a blocked head cannot
 * block unrelated resource ids" is a queue-selection property, not a shape one.
 */
export interface ResourceWaitRequest {
  readonly requestId: string;
  readonly resourceIds: readonly string[];
  readonly eligibilityEventSequenceRef: string;
  readonly continuouslyEligibleSinceRef: string;
  readonly callerObservation: string;
}

/**
 * `dimension` is carried, never defaulted: the daemon's slot ceiling counts per
 * dimension, so a reducer-side default would silently merge two ceilings.
 * `attemptRef` is null until `effect.activate` binds exactly one attempt.
 */
export interface ProviderSlotReservation {
  readonly dimension: string;
  readonly slotRef: string;
  readonly requestId: string;
  readonly state: SlotState;
  readonly attemptRef: string | null;
}

/** The exact activation fact set: the identity being activated plus its attempt. */
export interface ProviderSlotActivateCommand {
  readonly dimension: string;
  readonly slotRef: string;
  readonly requestId: string;
  readonly attemptRef: string;
}

export interface AcquisitionSet {
  readonly rows: readonly ResourceRow[];
  readonly allActive: boolean;
  /** True once a failed or unknown acquisition has held the whole set. */
  readonly held: boolean;
}

export type ReserveAllResult =
  | { readonly outcome: "RESERVED"; readonly rows: readonly ResourceRow[] }
  | { readonly outcome: "WAITING"; readonly waitRequest: ResourceWaitRequest };

const DECLARED_KEYS = ["resourceId", "capacityUnits", "external", "fenceable"] as const;
const ROW_KEYS = [
  "resourceId", "capacityUnits", "epoch", "state", "effectIntentRef", "external", "fenceable",
] as const;
const REQUEST_KEYS = [
  "requestId", "declaredResources", "capacitySnapshot", "epoch", "eligibilityEventSequenceRef",
  "continuouslyEligibleSinceRef", "callerObservation",
] as const;

function parseDeclared(value: unknown): DeclaredResource | null {
  const parsed = exactRecord(value, DECLARED_KEYS);
  if (parsed === null) return null;
  if (!isRef(parsed["resourceId"]) || !isCount(parsed["capacityUnits"])) return null;
  if (typeof parsed["external"] !== "boolean" || typeof parsed["fenceable"] !== "boolean") {
    return null;
  }
  return parsed as unknown as DeclaredResource;
}

function parseRow(value: unknown): ResourceRow | null {
  const parsed = exactRecord(value, ROW_KEYS);
  if (parsed === null) return null;
  if (!isRef(parsed["resourceId"]) || !isCount(parsed["capacityUnits"])) return null;
  if (!isCount(parsed["epoch"]) || !oneOf(parsed["state"], ACQUISITION_STATES)) return null;
  if (!isRef(parsed["effectIntentRef"])) return null;
  if (typeof parsed["external"] !== "boolean" || typeof parsed["fenceable"] !== "boolean") {
    return null;
  }
  return parsed as unknown as ResourceRow;
}

export function parseRows(value: unknown): readonly ResourceRow[] | null {
  const items = readList(value, MAX_AUTHORITY_ITEMS);
  if (items === null || items.length === 0) return null;
  const rows: ResourceRow[] = [];
  for (const item of items) {
    const row = parseRow(item);
    if (row === null) return null;
    rows.push(row);
  }
  return rows;
}

export function availableUnits(snapshot: unknown, resourceId: string): number | null {
  if (!isPlainRecord(snapshot)) return null;
  const read = readOwnDataProperty(snapshot, resourceId);
  if (!read.ok || !read.present || !isCount(read.value)) return null;
  return read.value;
}

export function parseReserveRequest(value: unknown): ReserveAllRequest | null {
  const parsed = exactRecord(value, REQUEST_KEYS);
  if (parsed === null) return null;
  if (!isRef(parsed["requestId"]) || !isCount(parsed["epoch"])) return null;
  if (!isRef(parsed["eligibilityEventSequenceRef"])) return null;
  if (!isRef(parsed["continuouslyEligibleSinceRef"])) return null;
  if (!isRef(parsed["callerObservation"]) || !isPlainRecord(parsed["capacitySnapshot"])) return null;
  const items = readList(parsed["declaredResources"], MAX_AUTHORITY_ITEMS);
  if (items === null || items.length === 0) return null;
  const declared: DeclaredResource[] = [];
  for (const item of items) {
    const resource = parseDeclared(item);
    if (resource === null) return null;
    declared.push(resource);
  }
  declared.sort((left, right) => compareStrings(left.resourceId, right.resourceId));
  if (new Set(declared.map((resource) => resource.resourceId)).size !== declared.length) {
    return null;
  }
  return { ...parsed, declaredResources: declared } as unknown as ReserveAllRequest;
}

const SLOT_KEYS = ["dimension", "slotRef", "requestId", "state", "attemptRef"] as const;
const SLOT_ACTIVATE_KEYS = ["dimension", "slotRef", "requestId", "attemptRef"] as const;

/**
 * Rebuilds from own data properties only. A caller record is never returned or
 * spread through, so an accessor, proxy, or extra key cannot survive the parse
 * and reappear in a successor.
 */
export function parseProviderSlot(value: unknown): ProviderSlotReservation | null {
  const parsed = exactRecord(value, SLOT_KEYS);
  if (parsed === null) return null;
  const { attemptRef, dimension, requestId, slotRef, state } = parsed;
  if (!isRef(dimension) || !isRef(slotRef) || !isRef(requestId)) return null;
  if (!oneOf(state, SLOT_STATES)) return null;
  // Absent-and-unbound is `null`; every other non-ref is malformed, never "unbound".
  if (attemptRef !== null && !isRef(attemptRef)) return null;
  return { attemptRef, dimension, requestId, slotRef, state };
}

export function parseProviderSlotActivation(
  value: unknown,
): ProviderSlotActivateCommand | null {
  const parsed = exactRecord(value, SLOT_ACTIVATE_KEYS);
  if (parsed === null) return null;
  const { attemptRef, dimension, requestId, slotRef } = parsed;
  if (!isRef(dimension) || !isRef(slotRef) || !isRef(requestId)) return null;
  if (!isRef(attemptRef)) return null;
  return { attemptRef, dimension, requestId, slotRef };
}

/** Wrong-state and unmet-precondition refusals map to the registry stale-lease family. */
export function refuse(message: string): AuthorityOutcome<never> {
  return reject([makeIssue("AUTHORITY_STALE_LEASE", message)]);
}
