/**
 * The REVISION half of `planning.submit_decomposition` (task-4595697e).
 *
 * A REJECT mints a SUCCESSOR run (`commitIntentRejection`, approval-intent-rejection.ts) as a
 * SECONDARY leg of the rejection's decision. `readDurableLedger` keys its aggregates by
 * `decision.targetAggregateId` (bootstrap-ledger.ts:96-117), so no decision names the successor
 * and `versionOf` answers 0 for it FOREVER while the store observes 1. Before this row that made
 * the successor uncompilable: the dispatcher resolved the goal's ORIGINAL run, whose head is 3
 * after propose+finalize+reject, tripped the `>= 2` replay guard and handed the caller back the
 * REJECTED run's graphContentHash — a fail-open, measured on 2026-09-05.
 *
 * These arms live in their OWN file, not in `compile-dispatcher.test.ts`, so the INITIAL arms stay
 * byte-identical and "the INITIAL path is unchanged" is provable by a hash rather than by reading.
 *
 * Every arm runs over a REAL store through `rejectedWorld` and reads the successor id back through
 * the fixture's `currentPlanningRun`-derived answer, never by recomputing `successorRunIdFor`: an
 * arm that re-derived the id would assert the test's arithmetic instead of the product's.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { decisionsOf } from "../decision-ledger-memo.js";
import { planningStateFromDurableRecord } from "./approval-gate.js";
import { idsOf } from "./compile-run-resolution.js";
import { currentPlanningRun } from "./current-planning-run.js";
import {
  OPERATOR,
  PROJECT_ID,
  RUN_ID,
  closeStores,
  nodeOf,
  rejectPlan,
  rejectedWorld,
  structureOf,
  submit,
} from "./plan-reject-test-fixtures.js";

afterEach(closeStores);

/**
 * `StoredEvent` names its type `eventType`; a `.type` map yields `[null, ...]` and would satisfy a
 * length assertion while asserting nothing about the stream. Measured 2026-09-05.
 */
const eventTypesOf = (store: SqliteEventStore, runId: string): readonly string[] =>
  (store.readEvents(runId) ?? []).map((event) => event.eventType);

/** The run's own durable state, unwrapped from the decision record the ledger folded. */
function runState(store: SqliteEventStore, runId: string): Record<string, unknown> {
  const record = planningStateFromDurableRecord(stateOf(readDurableLedger(store, PROJECT_ID), runId));
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`no durable state for ${runId}`);
  }
  return record as Record<string, unknown>;
}

const refusalOf = (outcome: unknown): { readonly code: unknown; readonly layer: unknown } => ({
  code: (outcome as { readonly code?: unknown }).code,
  layer: (outcome as { readonly layer?: unknown }).layer,
});

/**
 * A DIFFERENT plan over the SAME approved revision: two nodes binding one criterion each, where
 * the default fixture structure is one node binding both. Both criteria stay bound, so the
 * compile itself still succeeds and the refusal under test is the RESUBMISSION fence, not
 * `COMPILED_PLAN_CRITERION_UNBOUND` one layer earlier.
 */
const SPLIT_STRUCTURE = structureOf(
  [nodeOf("node-api", ["crit-api"]), nodeOf("node-ui", ["crit-ui"], ["node-api"])],
  "node-ui",
);

/**
 * MEASURED on 2026-09-05 against a compiled REVISION successor, not taken from the plan text.
 *
 * The plan predicted `BOOTSTRAP_COMMAND_BYTES_CONFLICT @ DAEMON_PREREQUISITE` from the store's
 * replay check. Production does NOT answer that: the dispatcher's replay branch dispatches no leg,
 * so the store never sees the resubmission. It refuses one layer earlier, at the dispatcher, on
 * the sealed-submission comparison. Both halves are asserted because more than one layer can
 * refuse a resubmission and a `!ok` arm alone would stay green if the wrong one answered.
 */
const RESUBMIT_REFUSAL = Object.freeze({
  code: "SUBMIT_DECOMPOSITION_SUBMISSION_CONFLICT",
  layer: "COMPILE_DISPATCHER",
});

/**
 * MEASURED from the raced submission below, never assumed. The store answers the conflict on its
 * decision row and the dispatcher RE-LAYERS the propose refusal as `DAEMON_PLANNING`, so the
 * store's own layer does not survive to the caller - which is precisely why the layer is asserted
 * rather than taken on trust.
 */
const FENCE_REFUSAL = Object.freeze({
  code: "EXPECTED_VERSION_CONFLICT",
  layer: "DAEMON_PLANNING",
});

/**
 * A store whose `readEvents` THROWS for one aggregate, so `foldCurrentRun`'s catch arm fires and
 * `currentPlanningRun` answers `unreadable: true` — the degraded read a corrupt or mid-write
 * aggregate produces, without having to corrupt one.
 *
 * MEASURED precedent, goal-create-with-source.test.ts:290-310: `SqliteEventStore` calls
 * `Object.freeze(this)`, so a method cannot be shadowed by assignment; a Proxy is legal because
 * the methods live on the PROTOTYPE rather than among the frozen own properties. Every
 * non-intercepted member is forwarded BOUND TO THE REAL TARGET, which is what keeps the private
 * `#core` field reachable.
 */
function unreadableRunStore(store: SqliteEventStore, runId: string): SqliteEventStore {
  return new Proxy(store, {
    get(target, property, receiver): unknown {
      if (property === "readEvents") {
        return (aggregateId: string): unknown => {
          if (aggregateId === runId) throw new Error("injected read failure");
          return target.readEvents(aggregateId);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("a REVISION successor run compiles", () => {
  it("compiles the SUCCESSOR to PLAN_REVIEW with runKind REVISION", () => {
    const { originalRunId, ref, store, successorRunId } = rejectedWorld("compile the successor");
    // Pins the baseVersion=1 coupling to `commitIntentRejection`'s successor leg: the rejection
    // commits EXACTLY one `PlanningRunCreated` draft, so a REVISION run's head is already 1
    // before this compile writes anything. A producer that changed that reds this line.
    expect(eventTypesOf(store, successorRunId)).toEqual(["PlanningRunCreated"]);
    const goalRef = runState(store, originalRunId)["goalRef"];

    const compiled = submit(store, ref);

    if (!compiled.ok) throw new Error(`submit refused: ${compiled.code} @ ${compiled.layer}`);
    expect(compiled.runId).toBe(successorRunId);
    expect(compiled.disposition).toBe("DECIDED");
    const state = runState(store, successorRunId);
    expect(state["lifecycle"]).toBe("PLAN_REVIEW");
    expect(state["runKind"]).toBe("REVISION");
    // The rejection minted the successor from `request.sources.goalRef` while this compile folds
    // the dispatcher's payload goalRef: asserted equal so a mismatch reds instead of folding over.
    expect(state["goalRef"]).toBe(goalRef);
  });

  it("leaves the REJECTED original run untouched", () => {
    const { originalRunId, ref, store, successorRunId } = rejectedWorld("leave the original alone");
    const versionBefore = store.getAggregateVersion(originalRunId);
    const eventsBefore = eventTypesOf(store, originalRunId);

    const compiled = submit(store, ref);

    if (!compiled.ok) throw new Error(`submit refused: ${compiled.code} @ ${compiled.layer}`);
    // Asserted FIRST so this arm cannot pass vacuously: before the fix the submission answered
    // REPLAYED on the ORIGINAL run and wrote nothing anywhere, which satisfies every
    // "untouched" assertion below while proving nothing about a compile that reached the successor.
    expect(compiled.runId).toBe(successorRunId);
    expect(store.getAggregateVersion(originalRunId)).toBe(versionBefore);
    expect(eventTypesOf(store, originalRunId)).toEqual(eventsBefore);
    const original = runState(store, originalRunId);
    expect(original["lifecycle"]).toBe("REJECTED");
    expect(original["runKind"]).toBe("INITIAL");
  });

  it("replays a byte-identical resubmission without writing to the successor", () => {
    const { ref, store, successorRunId } = rejectedWorld("replay the same submission");
    const first = submit(store, ref);
    if (!first.ok) throw new Error(`first submit refused: ${first.code} @ ${first.layer}`);
    const versionAfterCompile = store.getAggregateVersion(successorRunId);

    const replayed = submit(store, ref);

    if (!replayed.ok) throw new Error(`replay refused: ${replayed.code} @ ${replayed.layer}`);
    expect(replayed.disposition).toBe("REPLAYED");
    expect(replayed.runId).toBe(successorRunId);
    expect(store.getAggregateVersion(successorRunId)).toBe(versionAfterCompile);
  });

  it("refuses a resubmission whose structure changed under the same derived command ids", () => {
    const { ref, store } = rejectedWorld("refuse a different structure");
    const first = submit(store, ref);
    if (!first.ok) throw new Error(`first submit refused: ${first.code} @ ${first.layer}`);

    const conflicting = submit(store, ref, { structure: SPLIT_STRUCTURE });

    expect(conflicting.ok).toBe(false);
    // Code AND layer, as two assertions on the values production answers: more than one layer can
    // refuse a resubmission, and a bare `!ok` arm would stay green if the wrong one answered.
    expect(refusalOf(conflicting).code).toBe(RESUBMIT_REFUSAL.code);
    expect(refusalOf(conflicting).layer).toBe(RESUBMIT_REFUSAL.layer);
  });

  /**
   * The chain must survive MORE than one hop. `foldCurrentRun` follows an aggregate's LAST event,
   * and after this row a compiled successor's last event is PlanningSubmissionFinalized until it
   * is rejected again — so an implementation that only ever handled the first hop, or that left a
   * compiled successor unresolvable, would answer the FIRST successor here or flag the walk stale.
   */
  it("keeps resolving after the successor is itself rejected", () => {
    const { originalRunId, ref, store, successorRunId } = rejectedWorld("first reject");
    const first = submit(store, ref);
    if (!first.ok) throw new Error(`first submit refused: ${first.code} @ ${first.layer}`);
    expect(first.runId).toBe(successorRunId);

    const secondSuccessorId = rejectPlan(store, successorRunId, "second reject", "cmd-reject-2");
    const walk = currentPlanningRun(store, originalRunId);
    expect(walk.hops).toBe(2);
    expect(walk.unreadable).toBe(false);
    expect(walk.runId).toBe(secondSuccessorId);

    const second = submit(store, ref);

    if (!second.ok) throw new Error(`second submit refused: ${second.code} @ ${second.layer}`);
    expect(second.runId).toBe(secondSuccessorId);
    expect(second.disposition).toBe("DECIDED");
    expect(eventTypesOf(store, secondSuccessorId))
      .toEqual(["PlanningRunCreated", "PlanProposed", "PlanningSubmissionFinalized"]);
    const state = runState(store, secondSuccessorId);
    expect(state["lifecycle"]).toBe("PLAN_REVIEW");
    expect(state["runKind"]).toBe("REVISION");
  });

  it("refuses fail-closed when the run walk is unreadable, rather than compiling onto a stale id",
    () => {
      const { originalRunId, ref, store, successorRunId } = rejectedWorld("fail closed on a stale walk");
      const headBefore = store.getAggregateVersion(successorRunId);

      const refusedOutcome = submit(unreadableRunStore(store, originalRunId), ref);

      expect(refusedOutcome.ok).toBe(false);
      expect(refusalOf(refusedOutcome).code).toBe("SUBMIT_DECOMPOSITION_RUN_UNREADABLE");
      expect(refusalOf(refusedOutcome).layer).toBe("COMPILE_DISPATCHER");
      // Nothing was compiled onto the last-good id the degraded walk would have answered.
      expect(store.getAggregateVersion(successorRunId)).toBe(headBefore);
      // THE CONTROL: the identical submission through the UNWRAPPED store commits, so the refusal
      // above is attributable to the injected read failure and not to the Proxy breaking the store.
      const control = submit(store, ref);
      if (!control.ok) throw new Error(`control refused: ${control.code} @ ${control.layer}`);
      expect(control.runId).toBe(successorRunId);
    });

  /**
   * task-138fab30 DoD 2, "ids keyed on the successor runId".
   *
   * The INITIAL compile of the SAME approved revision already wrote its own family under the
   * ORIGINAL run's stem, so the successor's compile is only restartable if `idsOf` keys on the
   * run as well as the digest — otherwise the second compile arrives under ids the store has
   * already decided and is answered as a replay of the rejected run's plan.
   *
   * Asserted against the production `idsOf`, never a re-derivation here: a test that recomputed
   * `compile-<digest12>-<sha8(runId)>` would keep passing after production changed the scheme.
   */
  it("writes its compile decisions under the SUCCESSOR's derived id family", () => {
    const { originalRunId, ref, store, successorRunId } = rejectedWorld("ids follow the successor");
    const successorIds = idsOf(ref.revisionDigest, successorRunId);
    const originalIds = idsOf(ref.revisionDigest, originalRunId);
    // The discriminator has to EXIST before absence/presence below means anything: same digest,
    // different run, so a scheme keyed on the digest alone would make these two identical.
    expect(successorIds["stem"]).not.toBe(originalIds["stem"]);
    // The rejected run's INITIAL compile already banked its own family, and it stays banked.
    expect(commandIdsOf(store)).toContain(originalIds["propose"]);
    expect(commandIdsOf(store)).not.toContain(successorIds["propose"]);

    const compiled = submit(store, ref);
    if (!compiled.ok) throw new Error(`submit refused: ${compiled.code} @ ${compiled.layer}`);
    expect(compiled.runId).toBe(successorRunId);

    const after = commandIdsOf(store);
    expect(after).toContain(successorIds["propose"]);
    expect(after).toContain(successorIds["finalize"]);
    // EXACTLY the two decisions this compile dispatches — the fold's internal chain items ride
    // inside the propose decision's payload and mint no decisions of their own, so a third id
    // under this stem would mean the dispatcher grew a leg nobody accounted for.
    expect(after.filter((id) => id.startsWith(`${successorIds["stem"] as string}-`)))
      .toEqual([successorIds["finalize"], successorIds["propose"]].sort());
  });

  /**
   * The ONLY reachable path to `SUBMIT_DECOMPOSITION_ALREADY_FINALIZED` after task-4595697e
   * re-based the version gates on `baseVersion`, measured by enumeration at
   * compile-dispatcher.ts:280-348: `>= base + 2` replays, `== base` folds, `== base + 1`
   * finalizes, and everything else refuses here — which is `runVersion < base`, impossible for an
   * INITIAL run (base 0) and reachable for a REVISION successor (base 1) only at head 0.
   *
   * That is a TORN MINT: `commitIntentRejection` commits the rejection and the successor's
   * `PlanningRunCreated` as legs of one decision, so a successor the walk can reach while its own
   * stream is empty means the multi-leg commit did not land whole. Compiling onto it would seal a
   * plan onto a run that was never created. task-138fab30's DoD asked for this code on a SECOND
   * submission; production answers REPLAYED or SUBMISSION_CONFLICT there (the two arms above), so
   * the code is pinned where it actually fires rather than left with no arm at all.
   */
  it("refuses ALREADY_FINALIZED when the successor's own mint never landed", () => {
    const { ref, store, successorRunId } = rejectedWorld("a torn successor mint");
    const torn = tornMintStore(store, successorRunId);
    // The walk still REACHES the successor - the rejection event that names it is on the
    // original's stream - so this is the head arithmetic refusing, not the resolver.
    expect(currentPlanningRun(torn, RUN_ID).runId).toBe(successorRunId);
    expect(torn.getAggregateVersion(successorRunId)).toBe(0);

    const refusedOutcome = submit(torn, ref);

    expect(refusedOutcome.ok).toBe(false);
    expect(refusalOf(refusedOutcome).code).toBe("SUBMIT_DECOMPOSITION_ALREADY_FINALIZED");
    expect(refusalOf(refusedOutcome).layer).toBe("COMPILE_DISPATCHER");
    // THE CONTROL: the same submission through the UNWRAPPED store commits, so the refusal is
    // attributable to the torn head and not to the Proxy having broken the store.
    const control = submit(store, ref);
    if (!control.ok) throw new Error(`control refused: ${control.code} @ ${control.layer}`);
    expect(control.runId).toBe(successorRunId);
  });
});

/** Every committed decision's command id, as the durable ledger reads them. */
const commandIdsOf = (store: SqliteEventStore): string[] =>
  decisionsOf(store, 200).map((decision) => decision.key.commandId).sort();

/**
 * A store that reports `runId` as never minted - head 0 and an empty stream - while every other
 * aggregate answers truthfully, so the rejection event naming it still resolves the walk.
 *
 * Same Proxy technique and same reason as `unreadableRunStore` above: `SqliteEventStore` freezes
 * itself, so a method cannot be shadowed by assignment.
 */
function tornMintStore(store: SqliteEventStore, runId: string): SqliteEventStore {
  return new Proxy(store, {
    get(target, property, receiver): unknown {
      if (property === "readEvents") {
        return (aggregateId: string): unknown =>
          aggregateId === runId ? [] : target.readEvents(aggregateId);
      }
      if (property === "getAggregateVersion") {
        return (aggregateId: string): number =>
          aggregateId === runId ? 0 : target.getAggregateVersion(aggregateId);
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const encoder = new TextEncoder();

/**
 * Appends ONE competing event to `runId` under its own decision key, fenced honestly at whatever
 * the head currently is. This is a real second writer, not a shim: it goes through the store's own
 * multi-leg commit (input shape cribbed from packages/store/src/command-decision-multi-leg.test.ts).
 */
function competingWrite(store: SqliteEventStore, runId: string): void {
  store.commitExpectedVersionDecisionLegs({
    commandKind: "goal.create",
    committedResultBytes: encoder.encode(JSON.stringify({ competing: true })),
    correlationId: "corr-competing-writer",
    decidedAt: "2026-08-30T12:03:00.000Z",
    key: {
      commandId: "cmd-competing-writer", principalId: OPERATOR, projectId: PROJECT_ID,
    },
    legs: [{
      aggregateId: runId,
      events: [{
        eventId: "event-competing-writer",
        eventType: "CompetingWrite",
        payload: encoder.encode(JSON.stringify({ kind: "CompetingWrite" })),
      }],
      expectedVersion: store.getAggregateVersion(runId),
    }],
    requestBytes: encoder.encode("competing-writer/v1"),
  });
}

/**
 * Moves the successor's head in the WINDOW the optimistic fence exists to cover: strictly AFTER
 * `proposePlan`'s entry read of the run and strictly BEFORE `commitAcceptedLegs`.
 *
 * The seam is the AUTHORITY aggregate's version read at planning-authority-persistence.ts:268,
 * which `buildPlanningAuthorityLeg` performs between those two points. Intercepting there — rather
 * than inside the commit call itself — is what makes this arm a discriminator: with the fence read
 * at handler ENTRY the propose still fences on the pre-injection head and CONFLICTS, while moving
 * that read down to just before the commit would observe the injected head and commit cleanly.
 *
 * Proxy mechanics per the measured precedent at goal-create-with-source.test.ts:290-310.
 */
function racingStore(store: SqliteEventStore, runId: string): SqliteEventStore {
  let injected = false;
  return new Proxy(store, {
    get(target, property, receiver): unknown {
      if (property === "getAggregateVersion") {
        return (aggregateId: string): number => {
          if (!injected && aggregateId !== runId && aggregateId.includes(runId)) {
            injected = true;
            competingWrite(target, runId);
          }
          return target.getAggregateVersion(aggregateId);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("the plan.propose optimistic fence still catches a concurrent writer", () => {
  it("refuses when the head moves between the handler's entry read and its commit", () => {
    const raced = rejectedWorld("race the fence");
    const headBeforeRace = raced.store.getAggregateVersion(raced.successorRunId);

    const refusedOutcome = submit(racingStore(raced.store, raced.successorRunId), raced.ref);

    expect(refusedOutcome.ok).toBe(false);
    expect(refusalOf(refusedOutcome).code).toBe(FENCE_REFUSAL.code);
    expect(refusalOf(refusedOutcome).layer).toBe(FENCE_REFUSAL.layer);
    // The injection landed and the propose did NOT: exactly one competing event, no PlanProposed.
    expect(raced.store.getAggregateVersion(raced.successorRunId)).toBe(headBeforeRace + 1);
    expect(eventTypesOf(raced.store, raced.successorRunId))
      .toEqual(["PlanningRunCreated", "CompetingWrite"]);

    // THE CONTROL. Without it a refusal would only prove the Proxy broke something: the IDENTICAL
    // submission, with no writer racing it, commits to the successor.
    const control = rejectedWorld("race the fence");
    const committed = submit(control.store, control.ref);
    if (!committed.ok) throw new Error(`control refused: ${committed.code} @ ${committed.layer}`);
    expect(committed.runId).toBe(control.successorRunId);
    expect(committed.disposition).toBe("DECIDED");
  });
});
