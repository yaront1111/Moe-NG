/**
 * A STORE FAULT IN THE PRE-CHECKS IS ONE CANDIDATE'S OUTCOME, NEVER A THROW OUT OF THE TICK.
 *
 * The module header's "NOTHING HERE THROWS" used to hold for the dispatch alone. The cheap checks
 * that run BEFORE it -- the decision lookup, the release walk, the version read -- called the store
 * bare, so a contended reader under a concurrent seat writer escaped `releaseAutoDecideOnce` as a
 * `DurableStoreError`. That ended the WHOLE tick: every later candidate went unanswered, and
 * `DurableSchedule` flattened the throw to SCHEDULE_CALLBACK_FAILED and discarded the reason --
 * the invisible refusal the module says it exists to prevent.
 *
 * WHY TWO CANDIDATES. With one, a resolved tick would prove only that the fault became an outcome.
 * The second goal is what proves the tick WENT ON: it is answered by its own named branch after
 * the first goal's walk threw. The journey's goal is first in ledger order, so it is the one that
 * faults.
 *
 * THE SCAN IS THE ONE READ BEFORE ANY CANDIDATE EXISTS. Paging the publish ledger is the tick's
 * first store call, so a fault there has no goal to name; it is still an answer, not a throw.
 */
import { DurableStoreError } from "@moe/store";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { BOOTSTRAP_SCHEMA_VERSION } from "../bootstrap/bootstrap-contracts.js";
import { commitAccepted } from "../bootstrap/bootstrap-ledger.js";
import { FIXTURE_PUBLICATION_APPROVAL } from "../bootstrap/bootstrap-test-fixtures.js";
import {
  BASE, DECIDED_AT, GOAL_ID, PROJECT_ID, REMOTE_URL, closeStores, nextId,
} from "../gates-journey-fixtures.js";
import type { JourneyWorld } from "../gates-journey-fixtures.js";
import { markPushed, releaseAutoDepsOver, unattendedWorld } from "../gates-unattended-fixtures.js";
import { readRunGoalPublication } from "../http/run-goal-publication.js";
import { OPERATOR } from "../planning/plan-reject-test-fixtures.js";
import { readPublishLedger, recordPublishReceipt } from "../repository/publish-ledger.js";
import { publishAggregateId } from "../repository/publish-receipt-contracts.js";
import { readReleaseAutoApproval } from "./release-auto-approval-record.js";
import { releaseAutoCommandId, releaseAutoDecideOnce } from "./release-auto-decide.js";
import { releaseDossierAggregateId } from "./release-dossier-contracts.js";

afterEach(() => { closeStores(); });

const SECOND_GOAL = "goal-store-fault-second";

/**
 * A second goal the publisher has PUSHED, so the tick holds TWO candidates. The request row goes
 * through the bootstrap family's OWN accepted-commit writer, carrying the result and the event the
 * production `repository.publish` handler builds, and the receipt through the production writer.
 * Only the handler's lifecycle fence is stepped around: a second goal would need the whole
 * planning journey to become publishable, and nothing in this arm is about the goal -- only about
 * the tick continuing past the first candidate. The PUSHED outcome is ASSERTED, or the arm below
 * is vacuous.
 */
function pushSecondGoal(world: JourneyWorld): void {
  const approval = { ...FIXTURE_PUBLICATION_APPROVAL };
  const identity = { gitDirectory: "D:/fixture/repo/.git", root: "D:/fixture/repo" };
  const committed = commitAccepted(world.store, {
    commandId: nextId("cmd-publish-second"), correlationId: "corr-publish-second",
    decidedAt: DECIDED_AT, expectedVersion: 0, kind: "repository.publish",
    payload: { approval, goalId: SECOND_GOAL, remoteUrl: REMOTE_URL },
    principalId: OPERATOR, projectId: PROJECT_ID, schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
  }, {
    aggregateId: publishAggregateId(SECOND_GOAL),
    eventPayload: { approval, goalId: SECOND_GOAL, remoteUrl: REMOTE_URL, requestedAt: DECIDED_AT },
    eventType: "RepositoryPublishRequested", expectedVersion: 0,
    result: {
      candidate: { approval, identity }, goalId: SECOND_GOAL, remoteUrl: REMOTE_URL,
      requestedAt: DECIDED_AT,
    },
  });
  if (!committed.ok) throw new Error(`second publish request refused: ${committed.code}`);
  const request = readPublishLedger(world.store, PROJECT_ID).get(SECOND_GOAL)?.requests.at(-1);
  if (request === undefined) throw new Error("the second goal recorded no publish request");
  const recorded = recordPublishReceipt(world.store, {
    branch: BASE, decidedAt: DECIDED_AT, decisionId: request.decisionId, goalId: SECOND_GOAL,
    projectId: PROJECT_ID, refusal: null, remoteUrl: request.remoteUrl, sha: world.sha,
    url: `${request.remoteUrl}/tree/${BASE}`,
  });
  if (!recorded.ok) throw new Error(`second publish receipt refused: ${recorded.code}`);
  expect(readRunGoalPublication(
    world.store, PROJECT_ID, readPublishLedger(world.store, PROJECT_ID).get(SECOND_GOAL),
  )?.outcome).toBe("PUSHED");
}

/**
 * The journey's store with ONE read faulting: a call to `property` whose first argument satisfies
 * `contended` throws the STORE_BUSY a contended SQLite reader raises. Every other call reaches the
 * real store, bound to it, so the rest of the tick sees the world unchanged.
 */
function faultingReadOf(
  store: SqliteEventStore, property: keyof SqliteEventStore,
  contended: (argument: unknown) => boolean, message: string,
): SqliteEventStore {
  return new Proxy(store, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (key !== property) return value.bind(target);
      return (...args: unknown[]) => {
        if (contended(args[0])) throw new DurableStoreError("STORE_BUSY", message);
        return Reflect.apply(value, target, args);
      };
    },
  });
}

/** The event walk of `aggregateId` faults; the candidate scan and every other read are real. */
function faultingWalkOf(store: SqliteEventStore, aggregateId: string): SqliteEventStore {
  return faultingReadOf(
    store, "readEvents", (id) => id === aggregateId, "the release walk is contended",
  );
}

/** The publish-ledger page read faults, so the tick has no candidate to name. */
function faultingScanOf(store: SqliteEventStore): SqliteEventStore {
  return faultingReadOf(
    store, "readCommandDecisionsAfter", () => true, "the publish ledger is contended",
  );
}

describe("a store fault in one candidate's pre-checks is an OUTCOME, and the tick goes on", () => {
  it("answers STORE_UNREADABLE naming the store's code, and still answers the next goal", async () => {
    const world = unattendedWorld();
    markPushed(world);
    pushSecondGoal(world);
    const faulting = faultingWalkOf(world.store, releaseDossierAggregateId(GOAL_ID));

    const answers = await releaseAutoDecideOnce(releaseAutoDepsOver(world, { store: faulting }));

    expect(answers.map((answer) => answer.goalId)).toEqual([GOAL_ID, SECOND_GOAL]);
    // No gate refused: nothing was answered at all, so `refusal` is null and the detail carries the
    // store's own code, which is the reason the schedule would otherwise have discarded.
    expect(answers[0]).toMatchObject({
      code: "STORE_UNREADABLE", goalId: GOAL_ID, refusal: null, sha: world.sha,
    });
    expect(answers[0]?.detail).toContain("STORE_BUSY");
    // The second candidate reached ITS OWN pre-checks: no journey landed anything for it, so the
    // evidence gap is the branch that answers -- MEASURED, and the proof the loop went on.
    expect(answers[1]).toMatchObject({
      code: "EVIDENCE_INCOMPLETE", goalId: SECOND_GOAL,
      refusal: { code: "RELEASE_EVIDENCE_INCOMPLETE", layer: "DAEMON_PREREQUISITE" },
    });
  });

  it("parks NOTHING on a fault: no attempt is recorded, and a healthy next tick releases", async () => {
    const world = unattendedWorld();
    markPushed(world);
    const faulting = faultingWalkOf(world.store, releaseDossierAggregateId(GOAL_ID));
    const [faulted] = await releaseAutoDecideOnce(releaseAutoDepsOver(world, { store: faulting }));
    expect(faulted?.code).toBe("STORE_UNREADABLE");
    // The fault fired BEFORE anything was written, and the fault itself wrote nothing either: the
    // deterministic commandId is still free, so the goal is not parked behind ALREADY_ATTEMPTED.
    expect(readReleaseAutoApproval(
      world.store, PROJECT_ID, releaseAutoCommandId(PROJECT_ID, GOAL_ID, world.sha),
    )).toBeNull();
    const [healthy] = await releaseAutoDecideOnce(releaseAutoDepsOver(world));
    expect(healthy?.code).toBe("RELEASED");
  });

  it("answers a fault in the candidate scan as the tick's ONE answer, naming no goal", async () => {
    const world = unattendedWorld();
    markPushed(world);
    const answers = await releaseAutoDecideOnce(
      releaseAutoDepsOver(world, { store: faultingScanOf(world.store) }),
    );
    // The scan faulted before any candidate existed, so there is no goal or sha to name: the empty
    // ids are the scan's own answer, and the detail keeps the store's code the schedule would drop.
    expect(answers).toEqual([expect.objectContaining({
      code: "STORE_UNREADABLE", goalId: "", refusal: null, sha: "",
    })]);
    expect(answers[0]?.detail).toContain("STORE_BUSY");
    // Nothing was written, so the PUSHED goal the scan could not see is released once it can be.
    const [healthy] = await releaseAutoDecideOnce(releaseAutoDepsOver(world));
    expect(healthy).toMatchObject({ code: "RELEASED", goalId: GOAL_ID, sha: world.sha });
  });
});
