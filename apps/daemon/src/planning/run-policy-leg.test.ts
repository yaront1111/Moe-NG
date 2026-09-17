import type { CommitExpectedVersionDecisionLegsInput, SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  finalizeRequestIndex, proposedNotFinalizedStore,
} from "../bootstrap/bootstrap-journey-fixtures.js";
import { readDurableLedger, versionOf } from "../bootstrap/bootstrap-ledger.js";
import {
  PROJECT_ID, RUN_ID, bootstrapSequence, closeStores, driveThrough, envelope, openStore, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { PLANNING_SUBMISSION_FINALIZED_EVENT_TYPE } from "./planning-authority-finalize.js";
import { captureStableRunPolicySelection } from "./run-policy-evaluation.js";
import { buildRunPolicySelectionFence } from "./run-policy-leg.js";
import { runPolicyAggregateId } from "./run-policy-record.js";

const encoder = new TextEncoder();
const POLICY_AGGREGATE = `${PROJECT_ID}-policy`;

function installArtifact(store: SqliteEventStore): void {
  const expectedVersion = versionOf(readDurableLedger(store, PROJECT_ID), POLICY_AGGREGATE);
  const outcome = send(store, envelope(
    "policy.install", expectedVersion,
    { slice: { calibration: "new", sliceRef: "reviewer-calibration" } },
    "cmd-fence-policy-artifact",
  ));
  if (!outcome.ok) throw new Error(`artifact install refused ${outcome.code}`);
}

describe("buildRunPolicySelectionFence", () => {
  afterEach(() => closeStores());

  it("projects the captured store version into an exact empty policy leg", () => {
    const store = openStore();
    driveThrough(store, "project.activate");
    const ledger = readDurableLedger(store, PROJECT_ID);
    const captured = captureStableRunPolicySelection(store, ledger, PROJECT_ID);
    if (!captured.ok) throw new Error(`selection refused ${captured.reason}`);

    const leg = buildRunPolicySelectionFence(captured.selection.fence);

    expect(leg).toStrictEqual({
      aggregateId: POLICY_AGGREGATE,
      events: [],
      expectedVersion: versionOf(ledger, POLICY_AGGREGATE),
    });
    expect(Object.isFrozen(leg)).toBe(true);
    expect(Object.isFrozen(leg.events)).toBe(true);
  });

  it("makes a post-capture policy write reject the primary leg atomically", () => {
    const store = openStore();
    driveThrough(store, "project.activate");
    const ledger = readDurableLedger(store, PROJECT_ID);
    const captured = captureStableRunPolicySelection(store, ledger, PROJECT_ID);
    if (!captured.ok) throw new Error(`selection refused ${captured.reason}`);
    const fence = buildRunPolicySelectionFence(captured.selection.fence);
    installArtifact(store);
    const primaryId = "policy-fence-primary";

    const response = store.commitExpectedVersionDecisionLegs({
      commandKind: "plan.finalize",
      committedResultBytes: encoder.encode("{}"),
      correlationId: "correlation-policy-fence",
      decidedAt: "2026-08-08T00:00:00.000Z",
      key: {
        commandId: "cmd-policy-fence-primary",
        principalId: "principal-policy-fence",
        projectId: PROJECT_ID,
      },
      legs: [{
        aggregateId: primaryId,
        events: [{
          eventId: "policy-fence-primary-event",
          eventType: "PolicyFencePrimary",
          payload: encoder.encode("{}"),
        }],
        expectedVersion: 0,
      }, fence],
      requestBytes: encoder.encode("policy-fence/v1"),
    });

    expect(response.decision.resultCode).toBe("EXPECTED_VERSION_CONFLICT");
    expect(response.decision.effectDisposition).toBe("NO_BUSINESS_EFFECT");
    expect(store.getAggregateVersion(primaryId)).toBe(0);
    expect(store.readEvents(primaryId)).toStrictEqual([]);
  });
});

/**
 * The REAL store, with ONE policy write landing inside the finalize's legs commit: after the
 * evaluation captured its policy head, before the store's transaction observes any fence.
 */
function policyWriteBeforeCommit(store: SqliteEventStore): SqliteEventStore {
  return new Proxy(store, {
    get(target, property): unknown {
      if (property === "commitExpectedVersionDecisionLegs") {
        return (input: CommitExpectedVersionDecisionLegsInput) => {
          installArtifact(target);
          return target.commitExpectedVersionDecisionLegs(input);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("commitFinalizedSubmission — the captured policy head fences the seal", () => {
  afterEach(() => closeStores());

  const finalizeRequest = () => {
    const request = bootstrapSequence()[finalizeRequestIndex()];
    if (request === undefined) throw new Error("the journey issues no finalize request");
    return request;
  };
  const finalizedEvents = (store: SqliteEventStore) => store.readEvents(RUN_ID)
    .filter((event) => event.eventType === PLANNING_SUBMISSION_FINALIZED_EVENT_TYPE);

  it("control: the same world seals when no policy write races the commit", () => {
    const store = proposedNotFinalizedStore();

    expect(send(store, finalizeRequest()).ok).toBe(true);
    expect(finalizedEvents(store)).toHaveLength(1);
    expect(store.readEvents(runPolicyAggregateId(RUN_ID))).toHaveLength(1);
  });

  it("refuses the whole seal when a policy write lands between capture and commit", () => {
    const store = proposedNotFinalizedStore();
    const runVersion = store.getAggregateVersion(RUN_ID);
    const policyVersion = store.getAggregateVersion(POLICY_AGGREGATE);

    const outcome = send(policyWriteBeforeCommit(store), finalizeRequest());

    if (outcome.ok) throw new Error("a seal evaluated under a superseded policy head committed");
    expect([outcome.code, outcome.refusedBy]).toStrictEqual([
      "EXPECTED_VERSION_CONFLICT", "DURABLE_STORE",
    ]);
    expect(store.getAggregateVersion(POLICY_AGGREGATE)).toBe(policyVersion + 1);
    expect(store.getAggregateVersion(RUN_ID)).toBe(runVersion);
    expect(finalizedEvents(store)).toStrictEqual([]);
    expect(store.readEvents(runPolicyAggregateId(RUN_ID))).toStrictEqual([]);
  });
});
