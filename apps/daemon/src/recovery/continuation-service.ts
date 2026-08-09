import { decodeBoundedJsonBytes } from "@moe/contracts";
import { RECOVERY_OUTCOME_KINDS, admitResume, admitSuccessorOverlap } from "@moe/runner";
import type { RecoveryOutcomeKind } from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";

import {
  BINDING_CONFLICT,
  CONTINUATION_BINDING_SCHEMA_VERSION,
  CONTINUATION_COMMAND_KINDS,
  SHAPE_INVALID,
  UNCLASSIFIED,
  UNRECONCILED,
  boundaryRefusal,
  decodeContinuationBinding,
  inputRejected,
  parseContinuationRequest,
} from "./continuation-contracts.js";
import type {
  ContinuationBinding,
  ContinuationRequest,
  ContinuationResult,
} from "./continuation-contracts.js";
import { readReconciliationRecords } from "./restart-reconciliation.js";
import type { RestartRecordClassification } from "./restart-reconciliation.js";

/**
 * Healthy continuation after a crash: ONE safe action, and a BINDING rather than
 * edited history (design 1099).
 *
 * ONE ACTION. A caller issues a single command and either the continuation is
 * durably bound or nothing happened. There is no second call to make, because a
 * partially-orchestrated continuation after a crash is the precise state J3
 * exists to prevent.
 *
 * APPEND-ONLY. "Continue the interrupted attempt" reads naturally as updating
 * that attempt's row. It is not. The continuation appends a successor binding on
 * an aggregate of its OWN, and the interrupted attempt's reconciliation record is
 * never rewritten, reclassified or deleted — `bindingTarget` is the one place
 * that decides where a continuation may write.
 *
 * COMPOSE, NEVER DECIDE. Both admissions are `@moe/runner`'s. Their codes and
 * layers are carried out verbatim, so a reader can still tell SAFE_BOUNDARY from
 * this module's own CONTINUATION gate.
 */
const BINDING_PREFIX = "recovery-continuation:";
const PAGE_SIZE = 200;
const encoder = new TextEncoder();

/**
 * WHERE a continuation may write, and at what version — the append-only seam,
 * decided in one place so it cannot drift between two call-site arguments.
 *
 * A fresh aggregate named for the SUCCESSOR, always at version 0. Any target
 * derived from the interrupted attempt would append onto that attempt's own
 * history, which is the in-place rewrite design 1099 forbids.
 */
function bindingTarget(binding: ContinuationBinding): {
  readonly aggregateId: string;
  readonly expectedVersion: number;
} {
  return Object.freeze({ aggregateId: `${BINDING_PREFIX}${binding.successorRef}`, expectedVersion: 0 });
}

function appendBinding(
  store: SqliteEventStore,
  request: ContinuationRequest,
  binding: ContinuationBinding,
): ContinuationResult {
  const bytes = encoder.encode(JSON.stringify(binding));
  const target = bindingTarget(binding);
  const response = store.commitExpectedVersionDecision({
    commandKind: CONTINUATION_COMMAND_KINDS[0],
    committedResultBytes: bytes,
    correlationId: request.correlationId,
    decidedAt: request.decidedAt,
    events: [
      { eventId: `${binding.bindingRef}:bound`, eventType: "RecoveryContinuationBound", payload: bytes },
    ],
    expectedVersion: target.expectedVersion,
    key: { commandId: binding.bindingRef, principalId: request.principalId, projectId: request.projectId },
    requestBytes: encoder.encode(
      JSON.stringify({ attemptRef: binding.attemptRef, successorRef: binding.successorRef }),
    ),
    targetAggregateId: target.aggregateId,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") return BINDING_CONFLICT;
  // A REPLAYED commit returns the binding that is already durable, untouched. An
  // identical retry is the one action issued twice and stays BOUND; a DIFFERENT
  // continuation claiming the same successor is refused rather than reported as
  // bound, since the bytes on disk would not be the bytes just described.
  if (!sameBytes(response.decision.resultBytes, bytes)) return BINDING_CONFLICT;
  return Object.freeze({ appendsOnly: true as const, binding, ok: true as const, outcome: "BOUND" as const });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * The stored vocabulary is one wider than the runner's: it also holds REFUSED,
 * the arm where classification itself failed. Narrowing here is what lets the
 * admissions receive a `RecoveryOutcomeKind` without a cast, so a REFUSED record
 * cannot reach them as a plain string.
 *
 * Local because `@moe/runner`'s equivalent predicate is not on its public root,
 * and a deep import would reach past the package boundary. It is checked against
 * the root-exported vocabulary rather than a copied list, so the two cannot drift.
 */
function isRunnerClassification(value: RestartRecordClassification): value is RecoveryOutcomeKind {
  return (RECOVERY_OUTCOME_KINDS as readonly string[]).includes(value);
}

/** The traceable successor bindings, in the order they were appended. */
export function readContinuationBindings(
  store: SqliteEventStore,
  projectId: string,
): readonly ContinuationBinding[] {
  const bindings: ContinuationBinding[] = [];
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, PAGE_SIZE);
    for (const decision of page.items) {
      if (decision.key.projectId !== projectId) continue;
      if (decision.commandKind !== CONTINUATION_COMMAND_KINDS[0]) continue;
      if (decision.effectDisposition !== "EFFECTS_COMMITTED") continue;
      const binding = decodeContinuationBinding(decision.resultBytes);
      if (binding !== null) bindings.push(binding);
    }
    if (!page.hasMore || page.nextCursor === null) return Object.freeze(bindings);
    cursor = page.nextCursor;
  }
}

/**
 * The ONE continuation action.
 *
 * Bounded decode, exact-shape gate, then the gates that stand between a crashed
 * attempt and a running one: it must carry a classification restart
 * reconciliation actually produced, and BOTH of `@moe/runner`'s admissions must
 * admit it. Nothing is committed until every gate has passed, so a refusal
 * leaves the durable state byte-identical.
 */
export function evaluateContinuationCommandBytes(
  store: SqliteEventStore,
  input: unknown,
): ContinuationResult {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok) return inputRejected(decoded);

  const request = parseContinuationRequest(decoded.value);
  if (request === null) return SHAPE_INVALID;

  // Nothing silently resumes: an attempt with no durable classification, or one
  // whose classification the runner itself refused, has no truth to continue from.
  const record = readReconciliationRecords(store, request.projectId).get(request.attemptRef);
  if (record === undefined) return UNRECONCILED;
  if (!isRunnerClassification(record.classification)) return UNCLASSIFIED;

  // EVERY boundary fact below comes off `record`, never off `request`. The request
  // shape can no longer even express them, so this is the only source there is.
  const overlap = admitSuccessorOverlap({
    classification: record.classification,
    predecessorRef: request.attemptRef,
    predecessorRelease: record.predecessorRelease,
    successorRef: request.successorRef,
  });
  if (overlap.kind === "BLOCKED") return boundaryRefusal(overlap.failure);

  const resume = admitResume({
    classification: record.classification,
    predecessorRelease: record.predecessorRelease,
    resumeRef: request.successorRef,
    safeHandoff: record.safeHandoff,
  });
  if (resume.kind === "REFUSED") return boundaryRefusal(resume.failure);

  return appendBinding(
    store,
    request,
    Object.freeze({
      attemptRef: request.attemptRef,
      bindingRef: `${BINDING_PREFIX}${request.attemptRef}:${resume.resumeRef}`,
      classification: record.classification,
      // The admitted handoff, which `admitResume` narrowed from the STORED value.
      safeHandoff: resume.safeHandoff,
      schemaVersion: CONTINUATION_BINDING_SCHEMA_VERSION,
      successorRef: resume.resumeRef,
    }),
  );
}
