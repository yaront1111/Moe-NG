/**
 * The composer's request envelope, refusal vocabulary and preparation identity.
 *
 * SPLIT FROM `expansion-admission.ts` BY RESPONSIBILITY: that file owns the
 * ORDER the composed surfaces run in and the all-or-none unwind; this one owns
 * the words a refusal is spoken in and the exact bytes an identity is derived
 * from. The package already splits this way (`fairness-contract.ts` beside its
 * validators, `expansion-receipt.ts` beside `expansion-evidence.ts`).
 *
 * # ONLY THREE LOCAL CODES EXIST, AND EACH NAMES A FACT NO SURFACE CAN SPEAK
 *
 * Every other refusal is DELEGATED verbatim: the composed surface's own code,
 * its own layer where it has one, and its own missing-input path. Re-coding a
 * delegated refusal under an expansion synonym loses which layer actually
 * refused, and that loss is invisible to an "it refused" assertion.
 *
 * The three exceptions:
 *  - REQUEST_MALFORMED — the envelope is this module's own; no composed surface
 *    ever sees it.
 *  - NO_FAIRNESS_OPPORTUNITY — `rotateOnce` returns ok:true carrying an IDLE
 *    disposition. That is a NON-refusal which is nonetheless not an admission,
 *    and the closed fairness code tuple describes contract violations only.
 *  - RESOURCES_UNAVAILABLE — `reserveAll` returns ok:true carrying outcome
 *    WAITING. Same shape of fact, same absence in the authority code union.
 *
 * # `origin` EXISTS BECAUSE TWO LAYERS CAN COLLIDE ON ONE NAME
 *
 * The fairness vocabulary already has a `RESOURCE` layer, and so does the
 * acquisition surface this module composes. Carrying the delegated layer alone
 * would make "which layer refused" ambiguous exactly where more than one layer
 * can refuse, so the ORIGIN — which composed surface answered — is recorded
 * beside the verbatim layer rather than replacing it.
 */
import { createHash } from "node:crypto";

import { deepFreeze, exactRecord, isCount } from "../authority/authority-kernel.js";

/** Which composed surface answered. Closed and frozen. */
export const EXPANSION_ADMISSION_ORIGINS = Object.freeze([
  "BUDGET", "EVIDENCE", "FAIRNESS", "GRAPH", "LINEAGE", "REQUEST", "RESOURCE",
] as const);
export type ExpansionAdmissionOrigin = (typeof EXPANSION_ADMISSION_ORIGINS)[number];

/** The complete set of codes this module mints. Everything else is delegated. */
export const EXPANSION_ADMISSION_ISSUE_CODES = Object.freeze([
  "EXPANSION_ADMISSION_NO_FAIRNESS_OPPORTUNITY", "EXPANSION_ADMISSION_REQUEST_MALFORMED",
  "EXPANSION_ADMISSION_RESOURCES_UNAVAILABLE",
] as const);
export type ExpansionAdmissionIssueCode = (typeof EXPANSION_ADMISSION_ISSUE_CODES)[number];

export interface ExpansionAdmissionIssue {
  /** Verbatim from the composed surface, or one of the three local codes. */
  readonly code: string;
  /** The surface's own layer where it has one; otherwise the origin. */
  readonly layer: string;
  readonly origin: ExpansionAdmissionOrigin;
  readonly message: string;
  readonly missingInput: string | null;
}

export interface ExpansionRestoredMeter {
  readonly meter: string;
  readonly available: number;
  readonly reserved: number;
}

/**
 * Proof that a refusal holds nothing. `restoredMeters` is non-null exactly when
 * a reservation was taken and then given back, and it carries the buckets so a
 * caller — and a test — can compare them against the untouched view instead of
 * trusting the boolean.
 */
export interface ExpansionAdmissionUnwind {
  readonly budgetReservationCancelled: boolean;
  readonly restoredMeters: readonly ExpansionRestoredMeter[] | null;
}

export const NO_UNWIND: ExpansionAdmissionUnwind =
  Object.freeze({ budgetReservationCancelled: false, restoredMeters: null });

export interface ExpansionAdmissionRefusal {
  readonly ok: false;
  readonly disposition: "REFUSED" | "UNKNOWN";
  readonly issues: readonly ExpansionAdmissionIssue[];
  readonly unwind: ExpansionAdmissionUnwind;
}

export interface ExpansionLineageFacts {
  readonly expansionDepth: number;
  /** DERIVED from the receipt. A caller may never supply it. */
  readonly childWidth: number;
  readonly nodesAddedInExpansion: number;
}

export interface ExpansionFairnessFacts {
  readonly disposition: string;
  readonly workItemId: string;
  readonly resourceId: string;
  readonly roundsAdvanced: number;
  readonly capRevisionRef: string | null;
}

export interface ExpansionCapacityFact {
  readonly resourceId: string;
  readonly capacityUnits: number;
  readonly inFlightUnits: number;
}

export interface ExpansionBudgetFacts {
  readonly reservationId: string;
  readonly accountId: string;
  readonly admissionRef: string;
  readonly lines: readonly { readonly purpose: string; readonly meter: string; readonly quantity: number }[];
}

export interface ExpansionResourceFacts {
  readonly resourceIds: readonly string[];
  readonly epoch: number;
  /** Carries the acquisition request id, so a re-issued request rebinds. */
  readonly effectIntentRefs: readonly string[];
}

/** Every fact the identity binds. Adding one here changes every identity. */
export interface ExpansionBoundFacts {
  readonly proposalId: string;
  readonly revision: number;
  readonly goalVersion: number;
  readonly graphEpoch: number;
  readonly observedAtSequence: number;
  readonly childKeys: readonly string[];
  readonly sourceDigests: readonly string[];
  /** Scope, oracle and input facts, digested from the derived evidence. */
  readonly evidenceDigest: string;
  /** Quality and dependency facts, digested from the admission records. */
  readonly qualityDigest: string;
  readonly lineage: ExpansionLineageFacts;
  readonly fairness: ExpansionFairnessFacts;
  readonly capacitySnapshot: readonly ExpansionCapacityFact[];
  readonly provenBypasses: number;
  readonly budgetReservation: ExpansionBudgetFacts;
  readonly resourceReservation: ExpansionResourceFacts;
}

export interface ExpansionPreparation {
  readonly identity: string;
  readonly bound: ExpansionBoundFacts;
}

export type ExpansionAdmissionResult =
  | { readonly ok: true; readonly preparation: ExpansionPreparation }
  | ExpansionAdmissionRefusal;

export interface ExpansionAdmissionRequest {
  readonly receipt: unknown;
  readonly lineage: { readonly expansionDepth: number; readonly nodesAddedInExpansion: number };
  readonly graph: unknown;
  readonly rotation: unknown;
  readonly bypassClaim: unknown;
  readonly budget: { readonly view: unknown; readonly admission: unknown; readonly gate: unknown };
  readonly resources: unknown;
}

const REQUEST_KEYS = Object.freeze([
  "budget", "bypassClaim", "graph", "lineage", "receipt", "resources", "rotation",
] as const);
/**
 * `childWidth` is deliberately absent. Depth and node count are structural facts
 * about the surrounding graph that a proposal receipt cannot see, so a caller is
 * the only possible source for them; the width is PROVEN by the receipt, so a
 * caller-supplied one would be a verdict and is refused as an unknown key.
 */
const LINEAGE_KEYS = Object.freeze(["expansionDepth", "nodesAddedInExpansion"] as const);
const BUDGET_KEYS = Object.freeze(["admission", "gate", "view"] as const);

export function parseExpansionRequest(value: unknown): ExpansionAdmissionRequest | null {
  const parsed = exactRecord(value, REQUEST_KEYS);
  if (parsed === null) return null;
  const lineage = exactRecord(parsed["lineage"], LINEAGE_KEYS);
  const budget = exactRecord(parsed["budget"], BUDGET_KEYS);
  if (lineage === null || budget === null) return null;
  const expansionDepth = lineage["expansionDepth"];
  const nodesAddedInExpansion = lineage["nodesAddedInExpansion"];
  if (!isCount(expansionDepth) || !isCount(nodesAddedInExpansion)) return null;
  return {
    receipt: parsed["receipt"],
    lineage: { expansionDepth, nodesAddedInExpansion },
    graph: parsed["graph"],
    rotation: parsed["rotation"],
    bypassClaim: parsed["bypassClaim"],
    budget: { view: budget["view"], admission: budget["admission"], gate: budget["gate"] },
    resources: parsed["resources"],
  };
}

/**
 * A digest over the exact bytes of a fact set.
 *
 * The inputs are objects this module builds field by field, so their key order
 * is fixed by construction rather than by whatever a caller happened to send.
 */
export function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null", "utf8").digest("hex");
}

/** One immutable preparation. Any byte change in `bound` changes `identity`. */
export function prepare(bound: ExpansionBoundFacts): ExpansionAdmissionResult {
  return deepFreeze({ ok: true as const, preparation: { identity: digestOf(bound), bound } });
}
