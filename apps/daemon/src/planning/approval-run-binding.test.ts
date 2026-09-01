import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { driveTo, finalizeRequestIndex, legacyProposedStore } from "../bootstrap/bootstrap-journey-fixtures.js";
import {
  GOAL_ID,
  GRAPH_REVISION_REF,
  PROJECT_ID,
  RUN_ID,
  SUBMISSION_HASH,
  approvalPayload,
  approvalRecord,
  closeStores,
  driveThrough,
  envelope,
  finalizeChain,
  openStore,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { planningAuthorityAggregateId } from "./planning-authority-persistence.js";
import { verifyApprovedRunBinding } from "./approval-run-binding.js";

/**
 * The approved RUN IDENTITY, bound durably at activation (task-2cc6c59d).
 *
 * The gap this suite is the operand of: `GoalExecutionEnabled` is the daemon's ONLY durable
 * approval fact and its witness carried no runId, so nothing joined an approved goal back to the
 * sealed authority bodies at `planning-authority/<runId>`. `GoalState.planningRunRef` cannot
 * stand in — it is caller-supplied at `goal.create`, never re-verified at approval, and goes
 * stale after a re-plan.
 *
 * EVERY WORLD HERE IS SEEDED THROUGH REAL WRITERS. Nothing is hand-folded: the happy paths ride
 * `bootstrapSequence()` through the production `send()` pipeline, and the negatives ride the
 * preserved negative-world fixtures (`authorityLessProposedStore`, task-074e6d2e's AUTHORITY
 * axis). A hand-built durable record would let every arm agree with itself while the shipped
 * writer drifted away from it.
 *
 * TWO-SOURCE BINDING, and it is not an implementation detail. `planning-authority-finalize.ts`
 * freezes the run record's binding to `{authorityRef, envelopeDigest}` EXACTLY, so `bodiesDigest`
 * is not on the run record even on the happy path — its only durable home is the
 * `PlanningAuthorityBodiesSealed` payload on `planningAuthorityAggregateId(runId)`. The witness
 * must therefore read two durable sources, and a failure to read the second is the UNSEALED
 * refusal, never a partial bind.
 */

const APPROVAL_KIND = "approval.decide";
const ACTIVATION_EVENT = "GoalExecutionEnabled";

/**
 * The bodies event type, matched as a STRING because no site exports it.
 *
 * RENAME HAZARD, and it is why this constant carries a comment instead of standing bare: the
 * literal lives UNEXPORTED under five different private names — `AUTHORITY_EVENT_TYPE`
 * (planning-authority-persistence.ts:38, the writer), `BODIES_EVENT_TYPE`
 * (planning-authority-finalize.ts:50), `AUTHORITY_EVENT` (planning-authority-persistence.test.ts:52),
 * `BODIES_EVENT` (planning-authority-finalize.test.ts:47) and one in
 * bootstrap-finalize-journey.test.ts. A rename at the writer silently nulls every string-matched
 * read and presents as "the run carried no authority" — an UNSEALED refusal on a sealed run.
 * Consolidating the constant means editing the writer, which taskRail 3 forbids; it is reported
 * for the seam owner, not fixed here.
 */
const BODIES_EVENT_TYPE = "PlanningAuthorityBodiesSealed";

const decoder = new TextDecoder();

afterEach(() => {
  closeStores();
});

/** A plain own-property read: no getter runs and a hostile prototype contributes nothing. */
const own = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
};

/** The run's durable record, read through the committed production reader. */
function runRecord(store: SqliteEventStore): unknown {
  const run = readDurableLedger(store, PROJECT_ID).aggregates.get(RUN_ID);
  if (run === undefined) throw new Error(`no durable decision for ${RUN_ID}`);
  return run.result;
}

/**
 * The activation witness as it was DURABLY COMMITTED — read off the event, not off the return
 * value of the call that wrote it. A return value can carry fields the durable bytes do not.
 */
function committedActivation(store: SqliteEventStore): unknown {
  const events = store.readEvents(GOAL_ID)
    .filter((event) => event.eventType === ACTIVATION_EVENT);
  if (events.length !== 1) {
    throw new Error(`expected exactly one ${ACTIVATION_EVENT}, found ${String(events.length)}`);
  }
  const payload = JSON.parse(decoder.decode(events[0]?.payload)) as unknown;
  return own(payload, "activation");
}

const activationEventCount = (store: SqliteEventStore): number =>
  store.readEvents(GOAL_ID).filter((event) => event.eventType === ACTIVATION_EVENT).length;

/**
 * `bodiesDigest` from its ONLY durable home. Selected BY TYPE, never by index: the bodies and
 * envelope events share this aggregate and their write order is unpinned, so a take-first read
 * names whichever landed first and stays green while reading the wrong payload.
 */
function sealedBodiesDigest(store: SqliteEventStore): unknown {
  const events = store.readEvents(planningAuthorityAggregateId(RUN_ID));
  const bodies = events.find((event) => event.eventType === BODIES_EVENT_TYPE);
  if (bodies === undefined) throw new Error("the authority aggregate holds no bodies event");
  return own(JSON.parse(decoder.decode(bodies.payload)) as unknown, "bodiesDigest");
}

interface Refusal {
  readonly code: string;
  readonly layer: string;
}

const refusalOf = (outcome: unknown): Refusal => ({
  code: String(own(outcome, "code")),
  layer: String(own(outcome, "refusedBy")),
});

/**
 * The submission hash the run ACTUALLY carries, read off its durable record instead of spelled.
 *
 * Since task-16a6a2b1 the unsealed worlds below are PLANTED from the shipped chain, so they carry
 * the shipped submission rather than the legacy `SUBMISSION_HASH` literal. An approval naming the
 * wrong hash is refused BOOTSTRAP_REVISION_HASH_MISMATCH @ DAEMON_PREREQUISITE — a real refusal,
 * at a layer ABOVE the one these arms exist to exercise, which would leave the run-binding checks
 * unexercised while the suite stayed green. Reading it keeps the operand and the assertion from
 * drifting apart the next time the chain moves.
 */
function submissionHashOf(store: SqliteEventStore): string {
  const hash = own(own(runRecord(store), "state"), "submissionHash");
  if (typeof hash !== "string") throw new Error("the run record carries no submission hash");
  return hash;
}

/** Sends the shipped approval, optionally overriding one payload field. */
function approve(
  store: SqliteEventStore, overrides: Record<string, unknown> = {},
): ReturnType<typeof send> {
  return send(store, envelope(APPROVAL_KIND, 0, approvalPayload(overrides)));
}

/**
 * A run FINALIZED but never sealed: the authority-less proposal, then a finalize naming the
 * LEGACY submission hash that proposal carried. It reaches lifecycle PLAN_REVIEW — so the
 * not-reviewable check cannot answer for it — with an empty authority aggregate. That
 * separation is the whole point: without it the UNSEALED arm would be satisfied by the
 * not-reviewable refusal and would never exercise its own check.
 */
function finalizedButUnsealedStore(): SqliteEventStore {
  // PLANTED since task-16a6a2b1: `authorityLessProposedStore()` drives production, and production
  // now refuses an authority-less terminal, so the unsealed world is only reachable as pre-flip
  // durable history. The finalize below still runs through PRODUCTION — only the proposal it
  // finalizes is planted, which is the minimum needed to keep this arm's subject intact.
  const store = legacyProposedStore();
  const finalize = finalizeChain()[0];
  if (finalize === undefined) throw new Error("finalizeChain() is empty");
  // The hash is no longer overwritten with the spelled SUBMISSION_HASH: the planted proposal
  // replays the shipped chain's own submission, so the shipped finalize already names it. A
  // spelled hash here would be refused BOOTSTRAP_REVISION_HASH_MISMATCH and this arm would then
  // be exercising the wrong layer while still looking red-free.
  const outcome = send(store, envelope("plan.propose", 0, {
    commands: [finalize], runId: RUN_ID,
  }, "cmd-finalize"));
  if (!outcome.ok) throw new Error(`unsealed finalize refused: ${String(own(outcome, "code"))}`);
  return store;
}

describe("the durable activation witness binds the approved run identity", () => {
  it("carries runId, authorityRef and envelopeDigest copied from the run's durable record", () => {
    const store = openStore();
    driveThrough(store, "goal.close");
    const record = runRecord(store);
    const activation = committedActivation(store);

    expect(own(activation, "runId")).toBe(RUN_ID);
    // Copied from the durable record, never restated here: two hand-authored operands agreeing
    // would prove only that this file agrees with itself.
    expect(own(activation, "authorityRef")).toBe(own(record, "authorityRef"));
    expect(own(activation, "envelopeDigest")).toBe(own(record, "envelopeDigest"));
    expect(own(record, "authorityRef")).toBe(planningAuthorityAggregateId(RUN_ID));
  });

  it("carries bodiesDigest from the sealed bodies event, which the run record does NOT hold", () => {
    const store = openStore();
    driveThrough(store, "goal.close");

    // The negative half of the two-source claim, asserted so a later widening of the run
    // record's binding cannot make this suite silently single-source.
    expect(own(runRecord(store), "bodiesDigest")).toBeUndefined();
    expect(own(committedActivation(store), "bodiesDigest")).toBe(sealedBodiesDigest(store));
    expect(typeof sealedBodiesDigest(store)).toBe("string");
  });

  it("leaves the three keys the CORE witness admits untouched", () => {
    const store = openStore();
    driveThrough(store, "goal.close");
    const activation = committedActivation(store);

    // `validActivation` in the core exact-keys the command witness to three fields, so the
    // binding rides the DAEMON-owned durable payload copy only. If these three ever stop
    // appearing beside the binding, the split has collapsed into one shape.
    expect(own(activation, "activeGraphRevisionRef")).toBe(GRAPH_REVISION_REF);
    expect(own(activation, "graphApprovalRef")).toBe("approval-1");
    expect(own(activation, "truthClass")).not.toBeUndefined();
  });
});

describe("an approval that cannot be bound to a reviewable sealed run refuses", () => {
  it("refuses a run that never finalized, naming the run-binding layer", () => {
    // PLANTED since task-16a6a2b1 — the subject here is NOT-FINALIZED, unchanged; only the way
    // its operand is built moved, because production refuses an authority-less propose now.
    const store = legacyProposedStore();
    const outcome = approve(store, { record: approvalRecord(submissionHashOf(store)) });

    expect(outcome.ok).toBe(false);
    expect(refusalOf(outcome))
      .toEqual({ code: "APPROVAL_RUN_NOT_REVIEWABLE", layer: "APPROVAL_RUN_BINDING" });
    // Fail-closed: no partial activation, so the goal aggregate carries nothing at all.
    expect(activationEventCount(store)).toBe(0);
  });

  it("refuses a finalized run whose authority was never sealed", () => {
    const store = finalizedButUnsealedStore();
    // The world is genuinely reviewable, or the previous arm's refusal would answer for this one.
    expect(own(own(runRecord(store), "state"), "lifecycle")).toBe("PLAN_REVIEW");
    expect(store.readEvents(planningAuthorityAggregateId(RUN_ID))).toEqual([]);

    const outcome = approve(store, { record: approvalRecord(submissionHashOf(store)) });

    expect(outcome.ok).toBe(false);
    expect(refusalOf(outcome))
      .toEqual({ code: "APPROVAL_AUTHORITY_UNSEALED", layer: "APPROVAL_RUN_BINDING" });
    expect(activationEventCount(store)).toBe(0);
  });

  it("refuses a caller graphRevisionRef that diverges from the run's durable one", () => {
    const store = openStore();
    driveTo(store, finalizeRequestIndex() + 1);
    const outcome = approve(store, { graphRevisionRef: "graph-revision-not-the-run-s" });

    expect(outcome.ok).toBe(false);
    expect(refusalOf(outcome))
      .toEqual({ code: "APPROVAL_GRAPH_REVISION_DIVERGED", layer: "APPROVAL_RUN_BINDING" });
    expect(activationEventCount(store)).toBe(0);
  });

  it("keeps an unknown run and a hash mismatch answering in their OWN vocabulary", () => {
    // Neither is restamped into the new codes. A single "it refused" assertion would let the
    // new layer start answering for these and stay green while the operator chased the wrong
    // field -- which is the defect the two codes below were split apart to prevent.
    const unknown = openStore();
    driveTo(unknown, finalizeRequestIndex() + 1);
    expect(refusalOf(approve(unknown, { runId: "run-that-was-never-committed" })))
      .toEqual({ code: "BOOTSTRAP_PREREQUISITE_MISSING", layer: "DAEMON_PREREQUISITE" });

    const mismatched = openStore();
    driveTo(mismatched, finalizeRequestIndex() + 1);
    expect(refusalOf(approve(mismatched, { record: approvalRecord(SUBMISSION_HASH) })))
      .toEqual({ code: "BOOTSTRAP_REVISION_HASH_MISMATCH", layer: "DAEMON_PREREQUISITE" });
  });
});

/**
 * WHY THE SOURCE-SWAP DRILL THIS PLAN CALLS FOR CANNOT DISCRIMINATE — measured, not argued.
 *
 * The plan (step 4 drill 6, from comment-4dd3039f item 2) requires a fixture in which the RUN
 * RECORD's `graphRevisionRef` and the SEALED AUTHORITY PAYLOAD's copy differ, so that pointing
 * the verification at the wrong one reds. That fixture is UNCONSTRUCTIBLE for a sealed run:
 * production already joins the two and refuses the divergence before anything is sealed.
 *
 * `planning-authority-envelope.ts:99-101 severedBinding` compares the sealed plan body's
 * `revision.graphBinding.graphRevisionRef` — the very value that becomes the authority payload's
 * copy at planning-authority-persistence.ts:210 — against the submission's, and answers
 * PLANNING_AUTHORITY_GRAPH_REVISION_MISMATCH. So on EVERY sealed run the two sources are equal
 * by construction, which makes reading either one observationally identical, and drill 6 an
 * honest equivalent mutant. On an UNSEALED run the question does not arise: the binding refuses
 * APPROVAL_AUTHORITY_UNSEALED before it reads any revision ref at all.
 *
 * This arm is the pin that keeps that reasoning falsifiable. If the join guard is ever relaxed,
 * the divergent finalize starts committing, this arm reds, and drill 6 becomes constructible
 * again — at which point the verification's source genuinely matters and must be re-drilled.
 */
describe("production already joins the run's graphRevisionRef to the sealed body's", () => {
  it("refuses a finalize naming a different revision than the plan body it seals", () => {
    const store = openStore();
    driveTo(store, finalizeRequestIndex());
    const finalize = finalizeChain()[0];
    if (finalize === undefined) throw new Error("finalizeChain() is empty");
    const revision = { ...(finalize["revision"] as Record<string, unknown>) };
    revision["graphRevisionRef"] = "graph-revision-not-the-sealed-body-s";

    const outcome = send(store, envelope("plan.propose", 0, {
      commands: [{ ...finalize, revision }], runId: RUN_ID,
    }, "cmd-finalize"));

    expect(outcome.ok).toBe(false);
    expect(refusalOf(outcome).code).toBe("PLANNING_AUTHORITY_GRAPH_REVISION_MISMATCH");
    // The POSITIVE CONTROL for this arm: the same finalize, unmodified, commits. Without it a
    // refusal here could be any defect in the hand-assembled request rather than the join.
    const control = openStore();
    driveTo(control, finalizeRequestIndex());
    expect(send(control, envelope("plan.propose", 0, {
      commands: [finalize], runId: RUN_ID,
    }, "cmd-finalize")).ok).toBe(true);
  });
});

/**
 * THE THIRD CHECK, EXERCISED AT THE SEAM — because no end-to-end world can reach it.
 *
 * The journey-level UNSEALED arm above is answered by the MISSING `authorityRef`, not by the
 * missing digest: an unsealed run's record carries neither, since `commitFinalizedSubmission`
 * spreads an empty `carried`. Dropping the `bodiesDigest === null` clause therefore leaves that
 * arm green — measured, drill 3 — which makes the clause untested by the journey alone.
 *
 * This arm closes it against the PRODUCTION function, not a reimplementation: a run record that
 * REALLY IS sealed (driven through the shipped journey) is verified against a store whose
 * authority aggregate is empty. That is not a contrived shape — it is exactly what a rename of
 * the writer's private event-type constant produces, the hazard this module's selector comment
 * names: a sealed run whose bodies read comes back empty. It must be UNSEALED, never a binding
 * carrying an undefined digest.
 */
describe("a sealed-looking record whose bodies event will not read is UNSEALED", () => {
  it("refuses rather than binding an undefined bodiesDigest", () => {
    const sealedStore = openStore();
    driveThrough(sealedStore, "goal.close");
    const record = runRecord(sealedStore);
    // The precondition, asserted rather than assumed: this record really does look sealed.
    expect(typeof own(record, "authorityRef")).toBe("string");
    expect(typeof own(record, "envelopeDigest")).toBe("string");

    const emptyStore = openStore();
    const result = verifyApprovedRunBinding({
      graphRevisionRef: GRAPH_REVISION_REF,
      run: record as never,
      runId: RUN_ID,
      store: emptyStore,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the unreadable bodies to refuse");
    expect({ code: result.code, layer: result.layer })
      .toEqual({ code: "APPROVAL_AUTHORITY_UNSEALED", layer: "APPROVAL_RUN_BINDING" });

    // POSITIVE CONTROL: the same record against the store that DOES hold the event binds, so the
    // refusal above is attributable to the missing event and not to the record or the call shape.
    const bound = verifyApprovedRunBinding({
      graphRevisionRef: GRAPH_REVISION_REF,
      run: record as never,
      runId: RUN_ID,
      store: sealedStore,
    });
    expect(bound.ok).toBe(true);
    if (!bound.ok) throw new Error("expected the sealed store to bind");
    expect(bound.binding.bodiesDigest).toBe(sealedBodiesDigest(sealedStore));
  });
});
