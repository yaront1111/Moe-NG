/**
 * Shape, canonical order, refusal vocabulary and THE ONE DIGEST for the
 * scheduler half of the graph supersession engine (design 12.4).
 *
 * This module carries NO scheduling authority: it describes, orders, hashes and
 * refuses. Nothing here admits, rotates, drains, reserves or decides readiness.
 *
 * Two bindings are deliberate and must not be softened into local copies:
 *  - the disposition KIND vocabulary is `SUPERSESSION_DISPOSITION_KINDS`
 *    imported from the `@moe/core` package root, so a kind added upstream
 *    changes the canonical rank table here rather than drifting away from it;
 *  - every refusal code is an EXISTING `@moe/contracts` runtime error code. The
 *    frozen set below is declared `satisfies readonly RuntimeErrorCode[]`, so a
 *    scheduler-local invention is a compile error, not a review finding.
 *
 * The refusing LAYER is scheduler-owned on purpose: `@moe/core` refuses as
 * `SUPERSESSION_KERNEL`, and a test must be able to tell which of the two
 * answered. Every refusal carries both halves.
 */
import { createHash } from "node:crypto";

import { SUPERSESSION_DISPOSITION_KINDS, type SupersessionDispositionKind } from "@moe/core";
import type { RuntimeErrorCode } from "@moe/contracts";

import { compareStrings, deepFreeze } from "../authority/authority-kernel.js";

export const SUPERSESSION_DISPOSITION_FAMILIES = Object.freeze([
  "ATTEMPT", "EFFECT", "RESOURCE", "BUDGET",
] as const);
export type SupersessionDispositionFamily = (typeof SUPERSESSION_DISPOSITION_FAMILIES)[number];

export const SUPERSESSION_DISPOSITION_LAYERS = Object.freeze([
  "SCHEDULER_SUPERSESSION_SET", "SCHEDULER_SUPERSESSION_ATTEMPT", "SCHEDULER_SUPERSESSION_EFFECT",
  "SCHEDULER_SUPERSESSION_RESOURCE", "SCHEDULER_SUPERSESSION_BUDGET",
] as const);
export type SupersessionDispositionLayer = (typeof SUPERSESSION_DISPOSITION_LAYERS)[number];

/** Every member is an existing `@moe/contracts` code; none is minted here. */
export const SUPERSESSION_REFUSAL_CODES = Object.freeze([
  "INPUT_INVALID", "PLANNING_DISPOSITION_UNKNOWN", "STALE_LEASE",
  "SUPERSESSION_CONSEQUENCE_CHANGED",
] as const satisfies readonly RuntimeErrorCode[]);
export type SupersessionRefusalCode = (typeof SUPERSESSION_REFUSAL_CODES)[number];

export const SUPERSESSION_FAMILY_LAYERS: Readonly<
  Record<SupersessionDispositionFamily, SupersessionDispositionLayer>
> = Object.freeze({
  ATTEMPT: "SCHEDULER_SUPERSESSION_ATTEMPT", EFFECT: "SCHEDULER_SUPERSESSION_EFFECT",
  RESOURCE: "SCHEDULER_SUPERSESSION_RESOURCE", BUDGET: "SCHEDULER_SUPERSESSION_BUDGET",
});

/**
 * THE bound field list. The digest below covers exactly these names, and a
 * disposition carrying any other own key is refused rather than hashed, so a
 * field added later cannot silently escape the hash.
 */
export const SUPERSESSION_BOUND_DISPOSITION_FIELDS = Object.freeze([
  "carried", "family", "kind", "nodeKey", "outcome",
] as const);
export type SupersessionBoundDispositionField =
  (typeof SUPERSESSION_BOUND_DISPOSITION_FIELDS)[number];

export interface SupersessionFamilyDisposition {
  /** True only where the predecessor's authority survives into the successor. */
  readonly carried: boolean;
  readonly family: SupersessionDispositionFamily;
  readonly kind: SupersessionDispositionKind;
  readonly nodeKey: string;
  readonly outcome: string;
}

export interface SupersessionCarryRefusal {
  readonly code: SupersessionRefusalCode;
  readonly layer: SupersessionDispositionLayer;
  readonly ok: false;
}

export interface SupersessionDispositionSet {
  /** Structurally `true`: a partial set is a refusal and never reaches this shape. */
  readonly complete: true;
  readonly digest: string;
  readonly dispositions: readonly SupersessionFamilyDisposition[];
  readonly ok: true;
}

export type SupersessionDispositionResult = SupersessionCarryRefusal | SupersessionDispositionSet;
/** A producer answers with a disposition or a refusal. There is no third arm. */
export type FamilyOutcome = SupersessionCarryRefusal | SupersessionFamilyDisposition;

export interface SupersessionResourceFacts {
  readonly drainDisposition: unknown;
  readonly release: unknown;
  readonly slotState: unknown;
  readonly successorCapacity: unknown;
}
export interface SupersessionBudgetFacts {
  readonly expectedVersion: number;
  readonly neverStartedProofRef: string | null;
  readonly reservation: unknown;
  readonly settlementState: string | null;
  readonly successorAttemptRef: string;
  readonly view: unknown;
}
/**
 * Caller-supplied predecessor facts for ONE node. Every field a landed primitive
 * owns is typed `unknown` on purpose: that primitive does the hostile-input
 * parsing, and a second validator here would be the reimplementation DoD 3
 * forbids.
 */
export interface SupersessionNodeFacts {
  readonly attemptLifecycle: unknown;
  readonly budget: SupersessionBudgetFacts | null;
  readonly effectsTerminal: unknown;
  readonly kind: SupersessionDispositionKind;
  readonly nodeKey: string;
  readonly resource: SupersessionResourceFacts;
}

export type SupersessionKindClass = "ADD" | "CARRY" | "REMOVE" | "RERUN";
const CARRY_KINDS: readonly string[] = ["CARRY", "REQUALIFY"];
const RERUN_KINDS: readonly string[] = ["REEXECUTE", "CHANGE"];

/**
 * An UNCLASSIFIED kind returns null and every family refuses it. A kind added to
 * `@moe/core` therefore fails closed here instead of falling into whichever
 * producer branch happened to be last.
 */
export function classOfKind(kind: SupersessionDispositionKind): SupersessionKindClass | null {
  if (kind === "ADD") return "ADD";
  if (kind === "REMOVE") return "REMOVE";
  if (CARRY_KINDS.includes(kind)) return "CARRY";
  if (RERUN_KINDS.includes(kind)) return "RERUN";
  return null;
}

/** The ONE disposition constructor, kept beside the bound field list it must match. */
export function disposeFamily(
  node: SupersessionNodeFacts,
  family: SupersessionDispositionFamily,
  outcome: string,
  klass: SupersessionKindClass,
): SupersessionFamilyDisposition {
  return { carried: klass === "CARRY", family, kind: node.kind, nodeKey: node.nodeKey, outcome };
}

const DIGEST_DOMAIN = "@moe/scheduler.supersession.dispositions/v1";
const SORTED_BOUND_FIELDS: readonly string[] = [...SUPERSESSION_BOUND_DISPOSITION_FIELDS].sort();
/** Rank tables, not iteration order: ordering must never depend on Map traversal. */
const FAMILY_RANK: ReadonlyMap<string, number> =
  new Map(SUPERSESSION_DISPOSITION_FAMILIES.map((family, index) => [family, index]));
const KIND_RANK: ReadonlyMap<string, number> =
  new Map(SUPERSESSION_DISPOSITION_KINDS.map((kind, index) => [kind, index]));

export function isSupersessionKind(value: unknown): value is SupersessionDispositionKind {
  return SUPERSESSION_DISPOSITION_KINDS.some((kind) => kind === value);
}

/** The kind's DECLARED index, so producers can be run in canonical node order. */
export function supersessionKindRank(kind: SupersessionDispositionKind): number {
  return KIND_RANK.get(kind) ?? -1;
}

export function refuseSupersession(
  code: SupersessionRefusalCode,
  layer: SupersessionDispositionLayer,
): SupersessionCarryRefusal {
  return deepFreeze({ code, layer, ok: false as const });
}

export function refuseFamily(
  code: SupersessionRefusalCode,
  family: SupersessionDispositionFamily,
): SupersessionCarryRefusal {
  return refuseSupersession(code, SUPERSESSION_FAMILY_LAYERS[family]);
}

/**
 * Total order over an explicit key: family rank, then the kind's DECLARED index,
 * then the node key. Never discovery order and never input arrival order.
 */
export function compareDispositions(
  left: SupersessionFamilyDisposition,
  right: SupersessionFamilyDisposition,
): number {
  const family = (FAMILY_RANK.get(left.family) ?? -1) - (FAMILY_RANK.get(right.family) ?? -1);
  if (family !== 0) return family;
  const kind = (KIND_RANK.get(left.kind) ?? -1) - (KIND_RANK.get(right.kind) ?? -1);
  if (kind !== 0) return kind;
  return compareStrings(left.nodeKey, right.nodeKey);
}

function boundOnly(entry: SupersessionFamilyDisposition): boolean {
  const own = Object.keys(entry).sort();
  return own.length === SORTED_BOUND_FIELDS.length
    && own.every((key, index) => key === SORTED_BOUND_FIELDS[index]);
}

/**
 * The single digest path for this surface. Length-framed so no label or value
 * boundary can be forged by a value containing the separator, and `null` when a
 * disposition carries an own field outside the bound list.
 */
export function digestDispositions(
  dispositions: readonly SupersessionFamilyDisposition[],
): string | null {
  const digest = createHash("sha256");
  const frame = (label: string, raw: string | number | boolean): void => {
    const labelBytes = Buffer.from(label);
    const valueBytes = Buffer.from(String(raw));
    digest.update(String(labelBytes.length)).update(":").update(labelBytes)
      .update(String(valueBytes.length)).update(":").update(valueBytes);
  };
  frame("domain", DIGEST_DOMAIN);
  frame("dispositions.count", dispositions.length);
  for (const [index, entry] of dispositions.entries()) {
    if (!boundOnly(entry)) return null;
    for (const field of SUPERSESSION_BOUND_DISPOSITION_FIELDS) {
      frame(`dispositions.${index}.${field}`, entry[field]);
    }
  }
  return digest.digest("hex");
}

/** Sorts canonically, digests through the one function, and freezes the result. */
export function sealDispositionSet(
  dispositions: readonly SupersessionFamilyDisposition[],
): SupersessionDispositionResult {
  const ordered = [...dispositions].sort(compareDispositions);
  const digest = digestDispositions(ordered);
  if (digest === null) return refuseSupersession("INPUT_INVALID", "SCHEDULER_SUPERSESSION_SET");
  return deepFreeze({ complete: true as const, digest, dispositions: ordered, ok: true as const });
}
