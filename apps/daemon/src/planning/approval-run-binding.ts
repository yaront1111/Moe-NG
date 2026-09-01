import type { JsonObject, JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { payloadObject, payloadRef } from "../bootstrap/bootstrap-sequence.js";
import { planningAuthorityAggregateId } from "./planning-authority-persistence.js";

/**
 * WHICH RUN was approved, verified against durable state and bound at activation (task-2cc6c59d).
 *
 * The daemon's only durable approval fact is `GoalExecutionEnabled`, and its witness named no
 * run. `GoalState.planningRunRef` could not stand in: it is caller-supplied at `goal.create`,
 * never re-verified at approval, and after a re-plan it names the REJECTED predecessor. So an
 * approved goal had no durable path back to the sealed authority bodies at
 * `planning-authority/<runId>`, and N runs of one goal could sit sealed in PLAN_REVIEW at once
 * with nothing recording which of them the human approved.
 *
 * NOTHING HERE DECIDES AND NOTHING HERE IS COPIED FROM THE CALLER. Every bound value is read
 * back out of a durable record written by a production writer; the caller's own
 * `graphRevisionRef` is only ever COMPARED, never bound. That is what makes the witness a
 * verified copy rather than a restatement of what the request asserted.
 *
 * This module composes the authority seam; it does not edit it. `planning-authority-persistence.ts`
 * and `planning-authority-finalize.ts` are off-limits (taskRail 3), so a fact that lives only
 * inside their events is READ from those events rather than re-derived here.
 */

export const APPROVAL_RUN_BINDING_CODES = Object.freeze([
  "APPROVAL_RUN_NOT_REVIEWABLE",
  "APPROVAL_GRAPH_REVISION_DIVERGED",
  "APPROVAL_AUTHORITY_UNSEALED",
] as const);

export type ApprovalRunBindingCode = (typeof APPROVAL_RUN_BINDING_CODES)[number];

/**
 * MODULE-PRIVATE on purpose, and only the TYPE is exported.
 *
 * `tests/security/boundary-roster.security.ts` scans production sources for column-zero
 * `export const *_LAYER(S)` and makes every exported one owe a hostile BEFORE/AFTER/RACE trio.
 * This seam earns no such trio, so it follows the precedent the planning-authority persistence
 * and envelope modules already set: keep the const private, export the closed TYPE, and let
 * `decideApproval` passing that type straight into `refuse` be the compile-time agreement check
 * against `SERVICE_REFUSED_BY`'s spelled literal.
 */
const LAYER = "APPROVAL_RUN_BINDING" as const;

export type ApprovalRunBindingLayer = typeof LAYER;

/** The four durable facts the activation witness binds. Every one is read, never asserted. */
export interface ApprovedRunBinding {
  readonly authorityRef: string;
  readonly bodiesDigest: string;
  readonly envelopeDigest: string;
  readonly runId: string;
}

export type ApprovedRunBindingResult =
  | { readonly binding: ApprovedRunBinding; readonly ok: true }
  | {
    readonly code: ApprovalRunBindingCode;
    readonly layer: ApprovalRunBindingLayer;
    readonly ok: false;
  };

export interface ApprovedRunBindingInput {
  /** The caller's ref, COMPARED against the run's durable one and never bound from. */
  readonly graphRevisionRef: string;
  /** The run's durable record, as the committed ledger reader returns it. */
  readonly run: JsonValue;
  readonly runId: string;
  readonly store: SqliteEventStore;
}

const REVIEWABLE_LIFECYCLE = "PLAN_REVIEW";

/**
 * The bodies event type, matched as a STRING because no site exports it.
 *
 * RENAME HAZARD, reported not fixed: the literal lives UNEXPORTED under five private names —
 * `AUTHORITY_EVENT_TYPE` (planning-authority-persistence.ts:38, the WRITER), `BODIES_EVENT_TYPE`
 * (planning-authority-finalize.ts:50), and three more in test files. A rename at the writer
 * silently nulls this read and presents as APPROVAL_AUTHORITY_UNSEALED on a sealed run — a
 * refusal that looks like a missing seal rather than a broken selector. Consolidating the
 * constant means editing the writer, which taskRail 3 forbids.
 */
const BODIES_EVENT_TYPE = "PlanningAuthorityBodiesSealed";

const decoder = new TextDecoder();

const refused = (code: ApprovalRunBindingCode): ApprovedRunBindingResult =>
  Object.freeze({ code, layer: LAYER, ok: false as const });

const asObject = (value: JsonValue): JsonObject | null =>
  value === null || typeof value !== "object" || Array.isArray(value)
    ? null
    : (value as JsonObject);

/**
 * `bodiesDigest` from its ONLY durable home.
 *
 * `planning-authority-finalize.ts` freezes the run record's binding to
 * `{authorityRef, envelopeDigest}` EXACTLY, so the digest is absent from the run record even on
 * the happy path and widening that binding would mean editing a writer this row may not touch.
 * The read therefore goes to the event.
 *
 * SELECTED BY TYPE, NEVER BY INDEX: the bodies and envelope events land on this same aggregate
 * and their write order is unpinned, so a take-first read names whichever arrived first and
 * would bind the envelope payload's fields while looking correct.
 *
 * `readDurableLedger` cannot be used here — it folds only `decision.targetAggregateId`, and the
 * authority aggregate is a SECONDARY leg, so a ledger read would report it empty forever.
 */
function sealedBodiesDigest(store: SqliteEventStore, runId: string): string | null {
  let events;
  try {
    events = store.readEvents(planningAuthorityAggregateId(runId));
  } catch {
    return null;
  }
  const bodies = events.find((event) => event.eventType === BODIES_EVENT_TYPE);
  if (bodies === undefined) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(decoder.decode(bodies.payload));
  } catch {
    return null;
  }
  const record = payload === null || typeof payload !== "object" || Array.isArray(payload)
    ? null
    : (payload as JsonObject);
  return record === null ? null : payloadRef(record, "bodiesDigest");
}

/**
 * Verifies the approved run and returns the durable facts to bind, or the refusal that says
 * WHICH check answered.
 *
 * The order is load-bearing and is asserted by the suite: a run that never reached PLAN_REVIEW
 * is not reviewable REGARDLESS of what its revision refs or authority look like, so answering
 * "unsealed" for it would name the wrong defect to the operator. Each check owns its own code,
 * and none of them restates a refusal another layer already owns — an unknown run and a hash
 * mismatch keep answering BOOTSTRAP_PREREQUISITE_MISSING and BOOTSTRAP_REVISION_HASH_MISMATCH
 * at DAEMON_PREREQUISITE, upstream of here.
 */
export function verifyApprovedRunBinding(
  input: ApprovedRunBindingInput,
): ApprovedRunBindingResult {
  const record = asObject(input.run);
  const state = record === null ? null : payloadObject(record, "state");
  if (state === null || payloadRef(state, "lifecycle") !== REVIEWABLE_LIFECYCLE) {
    return refused("APPROVAL_RUN_NOT_REVIEWABLE");
  }
  // THE RUN RECORD's ref, written by the finalize fold — never the sealed body's copy at
  // planning-authority-persistence.ts:210. On a sealed run the two are equal by construction
  // (planning-authority-envelope.ts:99-101 refuses PLANNING_AUTHORITY_GRAPH_REVISION_MISMATCH
  // when they disagree), so the distinction is unobservable TODAY and only stays that way while
  // that join holds; the suite pins the join so a relaxation surfaces here.
  if (payloadRef(state, "graphRevisionRef") !== input.graphRevisionRef) {
    return refused("APPROVAL_GRAPH_REVISION_DIVERGED");
  }
  const authorityRef = record === null ? null : payloadRef(record, "authorityRef");
  const envelopeDigest = record === null ? null : payloadRef(record, "envelopeDigest");
  const bodiesDigest = sealedBodiesDigest(input.store, input.runId);
  // ALL THREE OR NOTHING. A run whose record looks sealed while the bodies event cannot be read
  // is UNSEALED, not partially bound: binding an undefined digest would publish a witness whose
  // join silently resolves to nothing.
  if (authorityRef === null || envelopeDigest === null || bodiesDigest === null) {
    return refused("APPROVAL_AUTHORITY_UNSEALED");
  }
  return Object.freeze({
    binding: Object.freeze({
      authorityRef, bodiesDigest, envelopeDigest, runId: input.runId,
    }),
    ok: true as const,
  });
}
