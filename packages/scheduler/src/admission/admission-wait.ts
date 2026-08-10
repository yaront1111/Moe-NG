/**
 * Intentional-wait and bounded blocker-challenge REPRESENTATION plus
 * admission-time validation. Nothing in this module schedules, enqueues, or
 * transitions anything.
 *
 * CONSUMED BY, and deliberately not the other way round: the supersession carry
 * of wait/blocker projections is LANDED in
 * `../supersession/supersession-dispositions.ts` (`carryWaitProjection`), which
 * calls `validateIntentionalWait` below and binds the validated wait's
 * `ownerNodeKey` to the supersession disposition set. The direction matters —
 * this module gained no scheduling authority from that edge and must not.
 *
 * EXPLICITLY OUT OF SCOPE, owned elsewhere:
 *  - challenge enqueueing and timer/transaction re-evaluation -> readiness
 *    explanation engine (task-fa96b81c), which consumes these types;
 *  - Blocker record lifecycle (design 234);
 *  - any readiness computation -> the landed `partitionFrontier` in frontier.ts.
 *
 * There is no clock here. "Now" is expressed as the caller's current
 * consumption gate, which keeps the module deterministic and testable.
 */
import {
  DEPENDENCY_GATES, type DependencyGate,
} from "../dependencies/dependency-contract.js";
import { isWithinHorizon } from "../dependencies/dependency-witness.js";
import {
  validateDependencyChallenge,
  type DependencyAnalysisIssue, type DependencyChallenge,
} from "../dependencies/dependency-analysis.js";
import { isGraphKey } from "../graph-key.js";
import type { GraphKey } from "../graph-model.js";
import {
  deepFreeze, dense, isDigest, isRef, isVersion, makeIssue, oneOf, record,
  type AdmissionIssue,
} from "./admission-model.js";

export const WAIT_ESCALATION_KINDS = ["ESCALATE_TO_HUMAN", "ESCALATE_TO_PLANNER", "NO_ESCALATION"] as const;
export type WaitEscalationKind = (typeof WAIT_ESCALATION_KINDS)[number];

/** Design-235 intentional wait: explicit owner, reason, predicate, scope, bounds. */
export interface IntentionalWait {
  readonly waitRef: string;
  readonly ownerNodeKey: GraphKey;
  readonly reason: string;
  readonly predicate: {
    readonly predicateRef: string; readonly schemaId: string;
    readonly schemaVersion: number; readonly parametersDigest: string;
  };
  readonly affectedScope: readonly GraphKey[];
  readonly recheckAtGate: DependencyGate;
  readonly deadlineGate: DependencyGate;
  readonly escalation: { readonly kind: WaitEscalationKind; readonly ref: string };
  readonly binding: {
    readonly graphIdentity: string;
    readonly sourceFactVersions: readonly { readonly sourceFactRef: string; readonly version: number }[];
  };
}

export type AdmissionWaitResult =
  | { readonly ok: true; readonly wait: IntentionalWait }
  | { readonly ok: false; readonly issues: readonly AdmissionIssue[] };

/** A validated challenge PROPOSAL. Approved supersession stays the only mutation path. */
export interface AdmissionChallengeRecord {
  readonly challenge: DependencyChallenge;
  readonly reviewOnly: true;
}

export type AdmissionChallengeResult =
  | { readonly ok: true; readonly record: AdmissionChallengeRecord }
  | { readonly ok: false; readonly issues: readonly DependencyAnalysisIssue[] };

const WAIT_KEYS = ["waitRef", "ownerNodeKey", "reason", "predicate", "affectedScope",
  "recheckAtGate", "deadlineGate", "escalation", "binding"] as const;

function failWait(code: "ADMISSION_WAIT_MALFORMED" | "ADMISSION_WAIT_HORIZON_INVALID", message: string): AdmissionWaitResult {
  return deepFreeze({ ok: false, issues: [makeIssue(code, message)] });
}

function parseScope(value: unknown): GraphKey[] | null {
  const entries = dense(value, 1);
  if (entries === null || !entries.every(isGraphKey)) return null;
  const scope = entries as GraphKey[];
  return new Set(scope).size === scope.length ? scope : null;
}

function parseFactVersions(value: unknown): IntentionalWait["binding"]["sourceFactVersions"] | null {
  const entries = dense(value, 1);
  if (entries === null) return null;
  const output: { sourceFactRef: string; version: number }[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const item = record(entry, ["sourceFactRef", "version"]);
    if (item === null || !isRef(item.sourceFactRef) || seen.has(item.sourceFactRef) || !isVersion(item.version)) {
      return null;
    }
    seen.add(item.sourceFactRef);
    output.push({ sourceFactRef: item.sourceFactRef, version: item.version });
  }
  return output;
}

/**
 * Validate one intentional-wait record. Shape and bounds only: it grants no
 * readiness, opens no blocker, and starts no timer.
 */
export function validateIntentionalWait(input: unknown): AdmissionWaitResult {
  const item = record(input, WAIT_KEYS);
  const predicate = item === null ? null : record(item.predicate, ["predicateRef", "schemaId", "schemaVersion", "parametersDigest"]);
  const escalation = item === null ? null : record(item.escalation, ["kind", "ref"]);
  const binding = item === null ? null : record(item.binding, ["graphIdentity", "sourceFactVersions"]);
  const scope = item === null ? null : parseScope(item.affectedScope);
  const facts = binding === null ? null : parseFactVersions(binding.sourceFactVersions);
  if (item === null || predicate === null || escalation === null || binding === null || scope === null || facts === null ||
    !isRef(item.waitRef) || !isGraphKey(item.ownerNodeKey) || !isRef(item.reason) ||
    !isRef(predicate.predicateRef) || !isRef(predicate.schemaId) || !isVersion(predicate.schemaVersion) ||
    !isDigest(predicate.parametersDigest) ||
    !oneOf(item.recheckAtGate, DEPENDENCY_GATES) || !oneOf(item.deadlineGate, DEPENDENCY_GATES) ||
    !oneOf(escalation.kind, WAIT_ESCALATION_KINDS) || !isRef(escalation.ref) || !isRef(binding.graphIdentity)) {
    return failWait("ADMISSION_WAIT_MALFORMED", "intentional wait record is malformed");
  }
  // A recheck scheduled past its own deadline is unbounded by construction.
  if (!isWithinHorizon(item.recheckAtGate, item.deadlineGate)) {
    return failWait("ADMISSION_WAIT_HORIZON_INVALID", "wait recheck gate is beyond the wait deadline");
  }
  return deepFreeze({
    ok: true,
    wait: {
      waitRef: item.waitRef, ownerNodeKey: item.ownerNodeKey, reason: item.reason,
      predicate: predicate as unknown as IntentionalWait["predicate"],
      affectedScope: scope, recheckAtGate: item.recheckAtGate, deadlineGate: item.deadlineGate,
      escalation: { kind: escalation.kind, ref: escalation.ref },
      binding: { graphIdentity: binding.graphIdentity, sourceFactVersions: facts },
    },
  });
}

/**
 * Admit a bounded blocker challenge. Delegates entirely to the landed
 * `validateDependencyChallenge` — dedup identity, the SEMANTIC_PREREQUISITE
 * current-contract reference, foreign holds and mutual holds are its rules, and
 * its `DEPENDENCY_CHALLENGE_*` codes pass through unchanged rather than being
 * re-coded with an admission-local synonym.
 */
export function admitDependencyChallenge(challenge: unknown, context: unknown): AdmissionChallengeResult {
  const validated = validateDependencyChallenge(challenge, context);
  return validated.ok
    ? deepFreeze({ ok: true, record: { challenge: validated.challenge, reviewOnly: true } })
    : deepFreeze({ ok: false, issues: validated.issues });
}

/**
 * Pure predicate over caller-supplied facts: a TIME-ONLY challenge is suppressed
 * only while the wait is still inside its declared deadline AND no new evidence
 * has arrived. New evidence always wins (design 415), and any non-boolean
 * evidence flag or unvalidated wait fails open — never silently suppressing.
 */
export function isTimeChallengeSuppressed(wait: unknown, currentGate: unknown, hasNewEvidence: unknown): boolean {
  if (hasNewEvidence !== false) return false;
  const validated = validateIntentionalWait(wait);
  if (!validated.ok || !oneOf(currentGate, DEPENDENCY_GATES)) return false;
  return isWithinHorizon(currentGate, validated.wait.deadlineGate);
}
