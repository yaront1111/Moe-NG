/**
 * Production scheduler fairness contracts — shared vocabularies and result
 * plumbing. The five families live in ./fairness-work-item.ts, ./fairness-ring.ts
 * and ./fairness-evidence.ts and all import this module.
 *
 * These contracts DESCRIBE and VALIDATE. Nothing here or in the sibling modules
 * decides rotation order, charges a deficit, or ages a work item — those belong
 * to the consumer, task-10cab3e5 (Fair scheduler production).
 *
 * Designed from a measured gap, NOT derived from the DEVELOPMENT_ONLY reference
 * in packages/testkit/src/scheduler-fairness. Three differences carry the design:
 *  1. THREE dispositions, not two. The reference's FairnessResult is ok | error,
 *     so "structurally legal but unclassifiable" has nowhere to go and is
 *     admitted as truth. A refusal here is REFUSED or UNKNOWN, and an UNKNOWN
 *     must name the input it is missing.
 *  2. A REFUSING LAYER on every issue. The reference's FairnessIssue is
 *     {code, message, ticketIds} and cannot say which layer refused, so epic
 *     rail 6 is unsatisfiable against it.
 *  3. This package's OWN hardened input kernel (../runtime-shape.ts,
 *     ../authority/authority-kernel.ts) and ASCII-only identity rule
 *     (../graph-key.ts) instead of the reference's private re-implementation and
 *     its any-well-formed-Unicode identities. No bound constant is introduced
 *     and no fairness constant is touched.
 */
import { MAX_AUTHORITY_ITEMS, deepFreeze, readList } from "../authority/authority-kernel.js";
import { isGraphKey } from "../graph-key.js";
import { isPlainArray, readPlainArrayLength } from "../runtime-shape.js";

/** Which layer refused. Closed and frozen; every issue names one member. */
export const FAIRNESS_CONTRACT_LAYERS = Object.freeze([
  "CAP_REVISION", "OPPORTUNITY_EVIDENCE", "RESOURCE", "RING", "WORK_ITEM",
] as const);
export type FairnessContractLayer = (typeof FAIRNESS_CONTRACT_LAYERS)[number];

/**
 * Stable reason codes. Every member is reachable from a real refusal path, so
 * the vocabulary never claims a guard that does not exist. The reference's
 * reducer/selection codes (_STALE_EVENT, _UNKNOWN_TICKET,
 * _DISPATCH_ORDER_VIOLATION, _EVENT_LIMIT_EXCEEDED, _PROJECT_CEILING_EXCEEDED,
 * _TICKET_CAP_EXCEEDED, CAP_RAISE_REQUIRES_DRAIN_OR_TIGHTER_MIGRATION) are
 * deliberately absent: they describe decisions, and a contract makes none.
 */
export const FAIRNESS_CONTRACT_ISSUE_CODES = Object.freeze([
  "FAIRNESS_CONTRACT_BOUND_LOOSENED", "FAIRNESS_CONTRACT_BYPASS_COUNT_UNPROVEN",
  "FAIRNESS_CONTRACT_BYPASS_EVIDENCE_MISSING", "FAIRNESS_CONTRACT_BYPASS_SELF_ATTESTED",
  "FAIRNESS_CONTRACT_CARDINALITY_EXCEEDED", "FAIRNESS_CONTRACT_DIMENSION_MISMATCH",
  "FAIRNESS_CONTRACT_DISPATCHABILITY_UNOBSERVED", "FAIRNESS_CONTRACT_DUPLICATE_IDENTITY",
  "FAIRNESS_CONTRACT_EMPTY_RESOURCE_SET", "FAIRNESS_CONTRACT_INVALID_COUNTER",
  "FAIRNESS_CONTRACT_INVALID_IDENTITY", "FAIRNESS_CONTRACT_INVALID_PRIORITY",
  "FAIRNESS_CONTRACT_ITEM_IN_MULTIPLE_QUEUES", "FAIRNESS_CONTRACT_MALFORMED_INPUT",
  "FAIRNESS_CONTRACT_MIGRATION_TARGET_DRAINED", "FAIRNESS_CONTRACT_OPPORTUNITY_UNOBSERVED",
  "FAIRNESS_CONTRACT_PRIOR_BOUND_UNOBSERVED", "FAIRNESS_CONTRACT_UNDECLARED_RESOURCE",
] as const);
export type FairnessContractIssueCode = (typeof FAIRNESS_CONTRACT_ISSUE_CODES)[number];

export interface FairnessContractIssue {
  readonly code: FairnessContractIssueCode;
  readonly layer: FairnessContractLayer;
  readonly message: string;
  /** Non-null exactly on an UNKNOWN: the input whose absence blocks a verdict. */
  readonly missingInput: string | null;
  readonly subjects: readonly string[];
}

/**
 * REFUSED is a verdict: the value is wrong. UNKNOWN is the absence of one — the
 * value is representable but an input needed to classify it was never supplied.
 * Neither ever becomes an admission.
 */
export interface FairnessContractRefusal {
  readonly ok: false;
  readonly disposition: "REFUSED" | "UNKNOWN";
  readonly issues: readonly FairnessContractIssue[];
}
export type FairnessContractResult<T> =
  | { readonly ok: true; readonly value: T }
  | FairnessContractRefusal;

/**
 * Priority class names, string-identical to the reference's ladder so a reviewer
 * can diff them. The contract attaches NO ordering meaning to this listing:
 * ranking P0 above P3 is a scheduling decision and belongs to task-10cab3e5.
 */
export const FAIRNESS_PRIORITY_CLASSES = Object.freeze(["P0", "P1", "P2", "P3"] as const);
export type FairnessPriorityClass = (typeof FAIRNESS_PRIORITY_CLASSES)[number];

export const FAIRNESS_DISPATCHABILITY_STATES =
  Object.freeze(["DISPATCHABLE", "NOT_DISPATCHABLE"] as const);
export type FairnessDispatchabilityState = (typeof FAIRNESS_DISPATCHABILITY_STATES)[number];

export function makeFairnessIssue(
  code: FairnessContractIssueCode,
  layer: FairnessContractLayer,
  message: string,
  missingInput: string | null = null,
  subjects: readonly string[] = [],
): FairnessContractIssue {
  return deepFreeze({ code, layer, message, missingInput, subjects: [...subjects] });
}

export function refuseFairness(issue: FairnessContractIssue): FairnessContractRefusal {
  return deepFreeze({ ok: false, disposition: "REFUSED", issues: [issue] });
}

/** An UNKNOWN must name the missing input; an unnamed one is a silent pass. */
export function unknownFairness(
  code: FairnessContractIssueCode,
  layer: FairnessContractLayer,
  missingInput: string,
  subjects: readonly string[] = [],
): FairnessContractRefusal {
  const issue = makeFairnessIssue(
    code, layer, `cannot classify without ${missingInput}`, missingInput, subjects,
  );
  return deepFreeze({ ok: false, disposition: "UNKNOWN", issues: [issue] });
}

export function acceptFairness<T>(value: T): FairnessContractResult<T> {
  return deepFreeze({ ok: true, value });
}

/** This package's ASCII-only identity rule, reused rather than re-invented. */
export function isFairnessIdentity(value: unknown): value is string {
  return isGraphKey(value);
}

export function isFairnessRefusal(value: unknown): value is FairnessContractRefusal {
  return typeof value === "object" && value !== null && "ok" in value
    && (value as { readonly ok: unknown }).ok === false;
}

/** Dense array longer than the bound; `readList` collapses that with "not a list". */
function isFairnessListOverCap(value: unknown): boolean {
  if (!isPlainArray(value)) return false;
  const length = readPlainArrayLength(value);
  return length !== null && length > MAX_AUTHORITY_ITEMS;
}

/**
 * Bounded list read reusing this package's cardinality bound. Over-cap and
 * malformed refuse with DIFFERENT codes, so a caller can tell a hostile shape
 * from a list that is merely too long.
 */
export function readFairnessItems(
  value: unknown,
  layer: FairnessContractLayer,
  field: string,
): readonly unknown[] | FairnessContractRefusal {
  if (isFairnessListOverCap(value)) {
    return refuseFairness(makeFairnessIssue(
      "FAIRNESS_CONTRACT_CARDINALITY_EXCEEDED", layer, `${field} exceeds the bounded cardinality`,
    ));
  }
  const items = readList(value, MAX_AUTHORITY_ITEMS);
  if (items === null) {
    return refuseFairness(makeFairnessIssue(
      "FAIRNESS_CONTRACT_MALFORMED_INPUT", layer, `${field} is not a bounded data array`,
    ));
  }
  return items;
}
