import { afterEach, describe, expect, it } from "vitest";

import type { JsonObject } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";
import {
  POLICY_REF, PROJECT_ID, driveThrough, envelope, evaluationInput, openStore, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { closeStores } from "./graph-activation-test-fixtures.js";
import {
  SUCCESSOR_REVISION_REF, supersedableStore,
} from "./graph-supersede-test-fixtures.js";
import { readSupersessionPolicyDecision } from "./supersession-policy-decision.js";

const FOREIGN_REVISION_REF = "graph-revision-foreign";

afterEach(() => { closeStores(); });

function plantEvent(
  store: SqliteEventStore, eventType: string, label: string, payload: JsonObject,
): void {
  const aggregateId = policyAggregateId(PROJECT_ID);
  const expectedVersion = store.getAggregateVersion(aggregateId);
  const commandId = `plant-${label}-${String(expectedVersion + 1)}`;
  store.commit({
    aggregateId,
    commandBytes: new TextEncoder().encode(commandId),
    commandId,
    committedAt: "2026-08-26T00:05:00.000Z",
    events: [{
      eventId: `${commandId}-${eventType}`,
      eventType,
      payload: new TextEncoder().encode(JSON.stringify(payload)),
    }],
    expectedVersion,
  });
}

function foreignSubjectStore(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "policy.validate");
  const input = {
    ...evaluationInput(POLICY_REF),
    action: "graph.supersede",
    graphNodeRevisionRefs: [FOREIGN_REVISION_REF],
    scope: ["node-foreign"],
  };
  const expectedVersion = store.getAggregateVersion(policyAggregateId(PROJECT_ID));
  const outcome = send(store, envelope(
    "policy.validate", expectedVersion, { input }, "cmd-foreign-supersession-policy",
  ));
  if (!outcome.ok) throw new Error(`foreign policy fixture refused: ${outcome.code}`);
  return store;
}

function absenceResult() {
  return readSupersessionPolicyDecision(openStore(), PROJECT_ID, SUCCESSOR_REVISION_REF);
}

function legacyResult() {
  const store = openStore();
  plantEvent(store, "PolicyEvaluated", "legacy", {
    decision: "ALLOW", policyRef: "legacy-policy",
  });
  return readSupersessionPolicyDecision(store, PROJECT_ID, SUCCESSOR_REVISION_REF);
}

function foreignResult() {
  return readSupersessionPolicyDecision(
    foreignSubjectStore(), PROJECT_ID, SUCCESSOR_REVISION_REF,
  );
}

function reusedResult() {
  const store = supersedableStore();
  plantEvent(store, "PolicyInstalled", "reused", { sliceRef: POLICY_REF });
  return readSupersessionPolicyDecision(store, PROJECT_ID, SUCCESSOR_REVISION_REF);
}

describe("durable graph.supersede policy decision", () => {
  it("reads the strict production-written supersession subject", () => {
    const result = readSupersessionPolicyDecision(
      supersedableStore(), PROJECT_ID, SUCCESSOR_REVISION_REF,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`${result.code}/${result.layer}`);
    expect(result.decisionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.policyRef).toBe(POLICY_REF);
    expect(result.principalId).toBe("principal-1");
    expect(result.scope).toEqual(["node-b"]);
  });

  it("refuses absence with its stable selector provenance", () => {
    expect(absenceResult()).toMatchObject({
      code: "SUPERSESSION_POLICY_DECISION_ABSENT",
      layer: "DAEMON_SUPERSESSION_POLICY_DECISION",
      ok: false,
    });
  });

  it("propagates the exact strict-reader refusal for a legacy row", () => {
    expect(legacyResult()).toMatchObject({
      code: "POLICY_AUTHORITY_PRINCIPAL_UNKNOWN",
      layer: "DAEMON_POLICY_AUTHORITY",
      ok: false,
    });
  });

  it("refuses a verified decision for a foreign successor", () => {
    expect(foreignResult()).toMatchObject({
      code: "SUPERSESSION_POLICY_DECISION_SUBJECT_MISMATCH",
      layer: "DAEMON_SUPERSESSION_POLICY_DECISION",
      ok: false,
    });
  });

  it("refuses reuse of the selected policy address after evaluation", () => {
    expect(reusedResult()).toMatchObject({
      code: "SUPERSESSION_POLICY_DECISION_POLICY_REUSED",
      layer: "DAEMON_SUPERSESSION_POLICY_DECISION",
      ok: false,
    });
  });

  it("never silently degrades a reader refusal to UNKNOWN_ERROR", () => {
    const refusals = [absenceResult(), legacyResult(), foreignResult(), reusedResult()];
    expect(refusals).toHaveLength(4);
    for (const refusal of refusals) {
      expect(refusal.ok).toBe(false);
      if (refusal.ok) throw new Error("refusal fixture unexpectedly authorized");
      expect(refusal.code).not.toBe("UNKNOWN_ERROR");
    }
  });
});
