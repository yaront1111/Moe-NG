/**
 * The durable per-attempt resource authority: which resources one attempt holds,
 * and what the scheduler last decided about each of them.
 *
 * THE AUTHORITY RULE, and it is the whole module. A caller may identify WHICH
 * attempt and WHICH resources it is declaring; it may never supply what STATE
 * those resources are in, and no value it passed is ever what gets persisted.
 *   - Membership is admitted through the public `grantSuccessorCapacity` reducer,
 *     and the rows written are the reducer's own frozen rebuilt rows. The
 *     caller's array is used to ask the question and is then discarded.
 *   - `grantSuccessorCapacity(rows, null)` is called with NO PROOF on purpose.
 *     Given a proof ref that reducer CLEARS quarantines to RELEASED, so a
 *     proof-carrying bind could launder a quarantined resource into a released
 *     one inside durable bytes. With null it refuses the set instead.
 *   - attemptRef, effectIntentRef and the project fence all come from the
 *     COMMITTED activation, re-read from the store. The binding argument names an
 *     aggregate and a project; it cannot assert what that activation contains.
 *   - Transitions are persisted ONLY from an accepted reducer result. RELEASED
 *     versus QUARANTINED survives because those rows are what gets encoded —
 *     nothing here re-derives a state, re-implements a transition or repairs a
 *     row.
 *
 * FAIL CLOSED. Every refusal writes nothing and grants nothing, and a refusal
 * raised upstream keeps its own code and its own layer.
 */

import { adapterConfirm, adapterFail, grantSuccessorCapacity } from "@moe/scheduler";
import type { AcquisitionSet } from "@moe/scheduler";
import { DurableStoreError } from "@moe/store";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import {
  ATTEMPT_RESOURCE_APPLY_COMMAND_KIND, ATTEMPT_RESOURCE_BIND_COMMAND_KIND,
  ATTEMPT_RESOURCE_BOUND_EVENT_TYPE, ATTEMPT_RESOURCE_RECORD_VERSION,
  ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE, SCHEDULER_RESOURCE_AUTHORITY,
  deriveAttemptResourceAggregateId, refuseAttemptResource, refuseLocalResource,
} from "./attempt-resource-authority-contracts.js";
import type {
  AttemptResourceBinding, AttemptResourceMember, AttemptResourceOutcome, AttemptResourceRefused,
  AttemptResourceReport,
} from "./attempt-resource-authority-contracts.js";
import { readAttemptResources } from "./attempt-resource-reader.js";
import { encodeFoundationPayload } from "./foundation-attempt-codec.js";

export * from "./attempt-resource-authority-contracts.js";
export { readAttemptResources } from "./attempt-resource-reader.js";

type SchedulerResult = ReturnType<typeof grantSuccessorCapacity>;

/** The activation as the STORE holds it, never as the caller describes it. This
 *  is also the foreign-project fence on the WRITE side: the history reader's own
 *  `tracedProject` check refuses a project mismatch, and its code is preserved. */
function durableActivation(
  store: SqliteEventStore, binding: AttemptResourceBinding,
): ActivationLedgerRecord | AttemptResourceRefused {
  let events: readonly StoredEvent[];
  try { events = store.readEvents(binding.activationAggregateId); }
  catch { return refuseLocalResource("ATTEMPT_RESOURCE_ACTIVATION_UNREADABLE", null); }
  const history = readFoundationActivationHistory(
    binding.activationAggregateId, events, binding.projectId);
  if (history.ok) return history.history.record;
  const upstream = "code" in history.result ? history.result.code : null;
  return refuseLocalResource("ATTEMPT_RESOURCE_ACTIVATION_UNREADABLE", upstream);
}

/** A reducer refusal keeps ITS code as `upstreamCode` and the SCHEDULER's layer:
 *  flattening it would make a malformed row indistinguishable from a quarantined
 *  one, and those need different repairs. */
function schedulerRefusal(outcome: SchedulerResult | null): AttemptResourceRefused {
  const upstream = outcome === null || outcome.ok ? null : outcome.issues[0]?.code ?? null;
  return refuseAttemptResource(
    "ATTEMPT_RESOURCE_SET_REFUSED", SCHEDULER_RESOURCE_AUTHORITY, upstream);
}

/**
 * A CRASH IS NOT A REFUSAL. The reducers parse own data properties but do not
 * guard reflection themselves, and a revoked proxy throws from `Array.isArray`
 * and from a prototype read rather than returning falsy. So a thrown reducer is
 * contained and reported as a refusal with no upstream code — never allowed to
 * escape as an exception a caller would see instead of a decision.
 */
function runReducer(run: () => SchedulerResult): SchedulerResult | null {
  try { return run(); } catch { return null; }
}

/**
 * `allActive` is READ off the accepted result, not recomputed: a second
 * derivation of "is this set live" would be a second definition of the same
 * scheduler rule. The duplicate check IS this module's own, because `parseRows`
 * does not dedupe — and it refuses rather than collapsing two rows into one,
 * since a set that silently loses a member is exactly what this record prevents.
 */
function admitBind(rows: unknown): AcquisitionSet | AttemptResourceRefused {
  const outcome = runReducer(() => grantSuccessorCapacity(rows, null));
  if (outcome === null || !outcome.ok) return schedulerRefusal(outcome);
  const { value } = outcome;
  if (!value.allActive) return refuseLocalResource("ATTEMPT_RESOURCE_SET_NOT_ACTIVE");
  const ids = new Set(value.rows.map((row) => row.resourceId));
  return ids.size === value.rows.length
    ? value : refuseLocalResource("ATTEMPT_RESOURCE_MEMBER_DUPLICATE");
}

const isRefusal = <T extends object>(
  value: T | AttemptResourceRefused,
): value is AttemptResourceRefused => "ok" in value && (value as { ok: unknown }).ok === false;

/** The reducer's rows, field by field. Nothing is spread from a caller record.
 *  `ResourceRow` is assignable to the member type, so one projection serves both
 *  the reducer's output and the durable members handed back to a reducer. */
const memberOf = (row: AttemptResourceMember): Record<string, unknown> => ({
  capacityUnits: row.capacityUnits, effectIntentRef: row.effectIntentRef, epoch: row.epoch,
  external: row.external, fenceable: row.fenceable, resourceId: row.resourceId, state: row.state,
});

function bodyOf(
  durable: ActivationLedgerRecord, projectId: string, rows: readonly AttemptResourceMember[],
): Record<string, unknown> {
  return {
    attemptRef: durable.attempt.attemptId,
    effectIntentRef: durable.effectIntent.intentId,
    memberCount: rows.length,
    members: rows.map(memberOf),
    projectId,
    recordVersion: ATTEMPT_RESOURCE_RECORD_VERSION,
    truthClass: "DAEMON_VERIFIED",
  };
}

interface CommitInput {
  readonly binding: AttemptResourceBinding;
  readonly bytes: Uint8Array;
  readonly eventId: string;
  readonly eventType: string;
  readonly expectedVersion: number;
  readonly kind: string;
}

/**
 * One event, at an expected version the caller measured. A concurrent writer
 * observes a different head and is rejected rather than appending beside us, and
 * the command key is suffixed so it can never collide with the activation's own.
 *
 * THE STORE'S OWN CODE IS PRESERVED. `null` means committed; anything else is the
 * upstream reason verbatim, because an idempotency conflict, an expected-version
 * conflict, a reused event id and a closed store are four different repairs and
 * flattening them into one boolean tells a caller to retry a fault that will
 * never succeed.
 */
function commitResourceEvent(store: SqliteEventStore, input: CommitInput): string | null {
  const { binding, expectedVersion } = input;
  const { principalId, projectId } = binding;
  const commandId = `${binding.commandId}:RESOURCES:${expectedVersion}`;
  try {
    const written = store.commitExpectedVersionDecision({
      commandKind: input.kind, committedResultBytes: input.bytes,
      correlationId: `${binding.correlationId}:RESOURCES`, decidedAt: new Date().toISOString(),
      events: [{ eventId: input.eventId, eventType: input.eventType, payload: input.bytes }],
      expectedVersion, key: { commandId, principalId, projectId }, requestBytes: input.bytes,
      targetAggregateId: deriveAttemptResourceAggregateId(binding.activationAggregateId),
    });
    return written.decision.effectDisposition === "EFFECTS_COMMITTED"
      ? null : written.decision.resultCode ?? "EFFECTS_NOT_COMMITTED";
  } catch (error) {
    return error instanceof DurableStoreError ? error.code : "STORE_THREW";
  }
}

/**
 * The BIND arm. Re-read the committed activation -> admit membership through the
 * reducer -> persist the reducer's rows -> answer from the READER, never from the
 * value just written.
 */
export function bindAttemptResources(
  store: SqliteEventStore, binding: AttemptResourceBinding, rows: unknown,
): AttemptResourceOutcome {
  const durable = durableActivation(store, binding);
  if (isRefusal(durable)) return durable;
  const set = admitBind(rows);
  if (isRefusal(set)) return set;
  const encoded = encodeFoundationPayload(bodyOf(durable, binding.projectId, set.rows));
  if (!encoded.ok) return refuseLocalResource("ATTEMPT_RESOURCE_RECORD_MALFORMED");
  // The event id is COPIED from the grant, never minted. MEASURED ORDER, not
  // assumed: expectedVersion 0 answers FIRST, so a second bind observes head
  // version 1 and refuses with EXPECTED_VERSION_CONFLICT; the copied grant id is
  // the store-wide backstop behind that, which is what stops a second set landing
  // beside the first even if the head were ever reset.
  const refusedBy = commitResourceEvent(store, {
    binding, bytes: encoded.bytes, eventId: `${durable.grant.grantId}:RESOURCES`,
    eventType: ATTEMPT_RESOURCE_BOUND_EVENT_TYPE, expectedVersion: 0,
    kind: ATTEMPT_RESOURCE_BIND_COMMAND_KIND,
  });
  if (refusedBy !== null) {
    return refuseLocalResource("ATTEMPT_RESOURCE_COMMIT_UNAVAILABLE", refusedBy);
  }
  return readAttemptResources(store, binding.activationAggregateId, binding.projectId);
}

/**
 * Exactly ONE public reducer per report, over the DURABLE members. The report
 * says which resource and what the adapter said; the resulting states are the
 * reducer's, and its returned rows are what gets encoded.
 */
function reduceReport(
  members: readonly unknown[], report: AttemptResourceReport,
): SchedulerResult | null {
  return runReducer(() => {
    if (report.kind === "CONFIRM") return adapterConfirm(members, report.resourceId, report.epoch);
    if (report.kind === "FAIL") {
      return adapterFail(members, report.resourceId, report.epoch, report.disposition);
    }
    return grantSuccessorCapacity(members, report.proofRef);
  });
}

/**
 * The TRANSITION arm. The predecessor members are read through the durable
 * reader, never taken from a caller list, so a report cannot smuggle in a set.
 */
export function applyAttemptResourceReport(
  store: SqliteEventStore, binding: AttemptResourceBinding, report: AttemptResourceReport,
): AttemptResourceOutcome {
  const durable = durableActivation(store, binding);
  if (isRefusal(durable)) return durable;
  const current = readAttemptResources(
    store, binding.activationAggregateId, binding.projectId);
  if (!current.ok) return current;
  const outcome = reduceReport(current.members.map(memberOf), report);
  if (outcome === null || !outcome.ok) return schedulerRefusal(outcome);
  const encoded = encodeFoundationPayload(bodyOf(durable, binding.projectId, outcome.value.rows));
  if (!encoded.ok) return refuseLocalResource("ATTEMPT_RESOURCE_RECORD_MALFORMED");
  // A crash is not a refusal: the head this append expects is measured inside a
  // guard, so a store that throws stays UNREADABLE rather than escaping.
  let expectedVersion: number;
  try {
    expectedVersion = store.readEvents(
      deriveAttemptResourceAggregateId(binding.activationAggregateId)).length;
  } catch { return refuseLocalResource("ATTEMPT_RESOURCE_RECORD_UNREADABLE"); }
  const refusedBy = commitResourceEvent(store, {
    binding, bytes: encoded.bytes,
    eventId: `${durable.grant.grantId}:RESOURCES:${expectedVersion}`,
    eventType: ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE, expectedVersion,
    kind: ATTEMPT_RESOURCE_APPLY_COMMAND_KIND,
  });
  if (refusedBy !== null) {
    return refuseLocalResource("ATTEMPT_RESOURCE_COMMIT_UNAVAILABLE", refusedBy);
  }
  return readAttemptResources(store, binding.activationAggregateId, binding.projectId);
}
