/**
 * Drain disposition and release/handoff (design 348 and 12.4, line 765).
 *
 * Split out of `./lease-state.ts` to keep both production modules inside the
 * epic's focused-module bar; the fencing primitives are imported, never cloned.
 */
import {
  DRAIN_REASONS,
  DRAIN_REASON_RANKS,
  MAX_AUTHORITY_ITEMS,
  TRUTH_CLASSES,
  accept,
  compareStrings,
  deepFreeze,
  exactRecord,
  isDigest,
  isRef,
  malformed,
  oneOf,
  stringList,
  type AuthorityOutcome,
  type DrainReason,
  type LeaseRecord,
  type LeaseState,
  type TruthClass,
} from "./authority-kernel.js";
import { fenceAuthority } from "./lease-fencing.js";

export type DrainTerminalTarget = "RELEASED" | "REVOKED";

export interface DrainDisposition {
  /** The complete union of every reason ever requested; nothing is ever removed. */
  readonly reasons: readonly DrainReason[];
  readonly strongestReason: DrainReason;
  readonly terminalTarget: DrainTerminalTarget;
  /** Design 765: only an unchanged strongest `WORK_RELEASE_OR_PAUSE` stays resumable. */
  readonly resumable: boolean;
}

/** Five digest families, named explicitly per design line 765. */
export interface ReleaseHandoff {
  readonly completedSteps: readonly string[];
  readonly activeProcessResourceFacts: readonly string[];
  readonly inputDigest: string;
  readonly worktreeDigest: string;
  readonly contextDigest: string;
  readonly journalDigest: string;
  readonly artifactDigest: string;
  readonly nextSafeAction: string;
  readonly truthClass: TruthClass;
}

export interface ReleaseRequest {
  readonly reason: DrainReason;
  readonly safeBoundaryObserved: boolean;
  readonly effectsTerminal: boolean;
  readonly resourcesTerminal: boolean;
  readonly handoff: unknown;
  readonly intentRefs: readonly string[];
  readonly disposition: DrainDisposition | null;
}

export type ReleaseResult =
  | {
    readonly outcome: "RELEASED"; readonly lease: LeaseRecord; readonly handoff: ReleaseHandoff;
    readonly disposition: DrainDisposition; readonly releasePending: false;
    readonly resumable: boolean;
  }
  | {
    readonly outcome: "DRAINING"; readonly lease: LeaseRecord;
    readonly disposition: DrainDisposition; readonly releasePending: true;
    readonly intentRefs: readonly string[]; readonly resumable: false;
  }
  | {
    readonly outcome: "NO_OP"; readonly lease: LeaseRecord; readonly releasePending: false;
  };

const DISPOSITION_KEYS = ["reasons", "strongestReason", "terminalTarget", "resumable"] as const;
const HANDOFF_KEYS = [
  "completedSteps", "activeProcessResourceFacts", "inputDigest", "worktreeDigest",
  "contextDigest", "journalDigest", "artifactDigest", "nextSafeAction", "truthClass",
] as const;
const REQUEST_KEYS = [
  "reason", "safeBoundaryObserved", "effectsTerminal", "resourcesTerminal", "handoff",
  "intentRefs", "disposition",
] as const;
const REVOKING_REASONS: readonly DrainReason[] = ["URGENT_REVOKE", "GRAPH_REMOVE_OR_SUPERSESSION"];
/** Terminal states are legal here so a repeat release is an idempotent no-op. */
const RELEASE_STATES: readonly LeaseState[] = [
  "ACTIVE", "SUSPECT", "DRAINING", "RELEASED", "REVOKED",
];

function targetOf(reason: DrainReason): DrainTerminalTarget {
  return REVOKING_REASONS.includes(reason) ? "REVOKED" : "RELEASED";
}
function resumableOf(reason: DrainReason): boolean {
  return reason === "WORK_RELEASE_OR_PAUSE";
}
/** Higher rank wins; an equal rank falls back to the stable reason code. */
function strongerOf(left: DrainReason, right: DrainReason): DrainReason {
  const delta = DRAIN_REASON_RANKS[left] - DRAIN_REASON_RANKS[right];
  if (delta !== 0) return delta > 0 ? left : right;
  return compareStrings(left, right) <= 0 ? left : right;
}
/** Callers must supply at least one reason; an empty reduce would throw, and a
 * fail-closed kernel never throws. */
function composeDisposition(reasons: readonly DrainReason[]): DrainDisposition | null {
  const unique = [...new Set(reasons)].sort(compareStrings);
  const first = unique[0];
  if (first === undefined) return null;
  const strongest = unique.reduce(strongerOf, first);
  return deepFreeze({
    reasons: unique, strongestReason: strongest, terminalTarget: targetOf(strongest),
    resumable: resumableOf(strongest),
  });
}

export function parseDisposition(value: unknown): DrainDisposition | null {
  const parsed = exactRecord(value, DISPOSITION_KEYS);
  if (parsed === null) return null;
  const reasons = stringList(parsed["reasons"], DRAIN_REASONS.length);
  if (reasons === null || reasons.length === 0) return null;
  if (!reasons.every((reason) => oneOf(reason, DRAIN_REASONS))) return null;
  if (!oneOf(parsed["strongestReason"], DRAIN_REASONS)) return null;
  const composed = composeDisposition(reasons as readonly DrainReason[]);
  if (composed === null) return null;
  if (composed.strongestReason !== parsed["strongestReason"]) return null;
  if (composed.terminalTarget !== parsed["terminalTarget"]) return null;
  if (composed.resumable !== parsed["resumable"]) return null;
  return composed;
}

/**
 * Union semantics: no request removes a reason, only a higher rank changes the
 * target, and an equal rank ties by stable reason code.
 *
 * This is a reducer, so the guarantee is per-application: given a disposition,
 * applying a reason never drops one and never lowers the strongest. Durability
 * of the accumulated reason set across applications belongs to the persisting
 * transaction, which is why a self-inconsistent disposition is refused outright.
 */
export function applyDrainReason(
  current: unknown,
  reason: unknown,
): AuthorityOutcome<DrainDisposition> {
  if (!oneOf(reason, DRAIN_REASONS)) return malformed("drain reason is outside the vocabulary");
  const existing = current === null || current === undefined ? null : parseDisposition(current);
  if (current !== null && current !== undefined && existing === null) {
    return malformed("drain disposition is malformed or self-inconsistent");
  }
  const composed = composeDisposition(
    existing === null ? [reason] : [...existing.reasons, reason],
  );
  if (composed === null) return malformed("drain disposition requires at least one reason");
  return accept(composed);
}

function parseHandoff(value: unknown): ReleaseHandoff | null {
  const parsed = exactRecord(value, HANDOFF_KEYS);
  if (parsed === null) return null;
  const completedSteps = stringList(parsed["completedSteps"], MAX_AUTHORITY_ITEMS);
  const facts = stringList(parsed["activeProcessResourceFacts"], MAX_AUTHORITY_ITEMS);
  if (completedSteps === null || facts === null) return null;
  for (const key of ["inputDigest", "worktreeDigest", "contextDigest", "journalDigest",
    "artifactDigest"]) {
    if (!isDigest(parsed[key])) return null;
  }
  if (!isRef(parsed["nextSafeAction"]) || !oneOf(parsed["truthClass"], TRUTH_CLASSES)) return null;
  const merged = { ...parsed, completedSteps, activeProcessResourceFacts: facts };
  return deepFreeze(merged) as unknown as ReleaseHandoff;
}

function parseRequest(value: unknown): ReleaseRequest | null {
  const parsed = exactRecord(value, REQUEST_KEYS);
  if (parsed === null) return null;
  if (!oneOf(parsed["reason"], DRAIN_REASONS)) return null;
  for (const key of ["safeBoundaryObserved", "effectsTerminal", "resourcesTerminal"]) {
    if (typeof parsed[key] !== "boolean") return null;
  }
  const intentRefs = stringList(parsed["intentRefs"], MAX_AUTHORITY_ITEMS);
  if (intentRefs === null) return null;
  const disposition = parsed["disposition"] === null ? null
    : parseDisposition(parsed["disposition"]);
  if (parsed["disposition"] !== null && disposition === null) return null;
  return { ...parsed, intentRefs, disposition } as unknown as ReleaseRequest;
}

/**
 * Design 765, three branches. Branch 3 (an uncommittable handoff) is checked
 * before any transition is composed, so authority is left exactly as found and
 * no partial handoff is ever stored; recovery to `SUSPECT` runs through the
 * ordinary due-observation path in `markSuspect`.
 */
export function releaseWork(
  record: unknown,
  authority: unknown,
  request: unknown,
): AuthorityOutcome<ReleaseResult> {
  const fenced = fenceAuthority(record, authority, "releaseWork", RELEASE_STATES);
  if (!fenced.ok) return fenced.rejection;
  const lease = fenced.lease;
  if (lease.state === "RELEASED" || lease.state === "REVOKED") {
    return accept({ outcome: "NO_OP" as const, lease: deepFreeze({ ...lease }), releasePending: false as const });
  }
  const parsed = parseRequest(request);
  if (parsed === null) return malformed("release request is malformed");
  const handoff = parseHandoff(parsed.handoff);
  if (handoff === null) return malformed("release handoff is not bounded and truth-classed");
  const composed = applyDrainReason(parsed.disposition, parsed.reason);
  if (!composed.ok) return composed;
  const disposition = composed.value;
  const settled = parsed.safeBoundaryObserved && parsed.effectsTerminal && parsed.resourcesTerminal;
  if (!settled) {
    return accept({
      outcome: "DRAINING" as const,
      lease: deepFreeze({ ...lease, state: "DRAINING" as const, version: lease.version + 1 }),
      disposition, releasePending: true as const, intentRefs: parsed.intentRefs,
      resumable: false as const,
    });
  }
  return accept({
    outcome: "RELEASED" as const,
    lease: deepFreeze({ ...lease, state: "RELEASED" as const, version: lease.version + 1 }),
    handoff, disposition, releasePending: false as const, resumable: disposition.resumable,
  });
}
