import { afterEach, describe, expect, it } from "vitest";

import { readDurableLedger, versionOf } from "../bootstrap/bootstrap-ledger.js";
import {
  PROJECT_ID, closeStores, driveThrough, envelope, openStore, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { captureStableRunPolicySelection } from "./run-policy-evaluation.js";
import { buildRunPolicySelectionFence } from "./run-policy-leg.js";

const encoder = new TextEncoder();

function installArtifact(store: ReturnType<typeof openStore>): void {
  const expectedVersion = versionOf(readDurableLedger(store, PROJECT_ID), `${PROJECT_ID}-policy`);
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

    const leg = buildRunPolicySelectionFence(captured.selection);

    expect(leg).toStrictEqual({
      aggregateId: `${PROJECT_ID}-policy`,
      events: [],
      expectedVersion: versionOf(ledger, `${PROJECT_ID}-policy`),
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
    const fence = buildRunPolicySelectionFence(captured.selection);
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
