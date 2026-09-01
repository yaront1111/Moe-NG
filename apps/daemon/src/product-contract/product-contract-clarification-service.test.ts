/**
 * The clarification lifecycle: core's materiality is the ONLY judge of an ask,
 * the identity is content-addressed (a re-ask replays, never a second open
 * question), and the first human answer is the durable product decision — a
 * different second answer refuses, the identical one replays.
 */
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import {
  clarificationAggregateId, clarificationsForContract,
  runAnswerClarification, runAskClarification,
} from "./product-contract-clarification-service.js";

const CONTRACT_ID = "contract-clarify-1";

function projection(statement: string): Record<string, unknown> {
  return {
    criteria: [{
      criterionId: "crit-1", requirementId: "req-1", statement,
      supersedesCriterionId: null,
    }],
    requirements: [{
      requirementId: "req-1", statement: "Users can sign in.",
      supersedesRequirementId: null,
    }],
  };
}

function askPayload(): Record<string, unknown> {
  return {
    contractId: CONTRACT_ID,
    options: [
      { label: "Email login", optionId: "opt-email",
        projection: projection("A registered user signs in with email.") },
      { label: "SSO login", optionId: "opt-sso",
        projection: projection("A registered user signs in through SSO.") },
    ],
    question: "Which login method does v1 commit to?",
  };
}

function input(payload: unknown, principalId = "sess-agent-1") {
  return {
    correlationId: "corr-clarify", decidedAt: "2026-08-31T12:00:00.000Z",
    payload, principalId, projectId: PROJECT_ID,
  };
}

function askedWorld(): { clarificationId: string; store: SqliteEventStore } {
  const store = openStore();
  const asked = runAskClarification(store, input(askPayload()));
  if (!asked.ok) throw new Error(`ask fixture refused: ${asked.code}`);
  return { clarificationId: asked.clarificationId, store };
}

afterEach(closeStores);

describe("runAskClarification", () => {
  it("records a MATERIAL question with its option digests, content-addressed", () => {
    const { clarificationId, store } = askedWorld();
    const rows = clarificationsForContract(store, PROJECT_ID, CONTRACT_ID);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.clarificationId).toBe(clarificationId);
    expect(row?.answer).toBeNull();
    expect(row?.options.map((option) => option.optionId)).toEqual(["opt-email", "opt-sso"]);
    expect(row?.optionDigests).toHaveLength(2);
    expect(row?.optionDigests[0]?.projectionDigest).toMatch(/^[0-9a-f]{64}$/u);
    // The id is derived from (contract, question, options) — never caller-chosen.
    expect(clarificationId).toMatch(/^clar-[0-9a-f]{24}$/u);
  });

  it("replays the identical re-ask instead of opening a second question", () => {
    const { clarificationId, store } = askedWorld();
    const again = runAskClarification(store, input(askPayload(), "sess-agent-2"));
    if (!again.ok) throw new Error(`re-ask refused: ${again.code}`);
    expect(again.clarificationId).toBe(clarificationId);
    expect(clarificationsForContract(store, PROJECT_ID, CONTRACT_ID)).toHaveLength(1);
  });

  it("forwards core's immaterial verdict verbatim — the agent decides alone", () => {
    const store = openStore();
    const same = askPayload();
    (same["options"] as Record<string, unknown>[])[1] = {
      label: "Same thing", optionId: "opt-same",
      projection: projection("A registered user signs in with email."),
    };
    expect(runAskClarification(store, input(same))).toMatchObject({
      code: "PRODUCT_CONTRACT_CLARIFICATION_IMMATERIAL", ok: false,
    });
    expect(clarificationsForContract(store, PROJECT_ID, CONTRACT_ID)).toEqual([]);
  });

  it("refuses a malformed ask at its own fence", () => {
    const store = openStore();
    for (const bad of [{}, { contractId: CONTRACT_ID }, null, { extra: 1, ...askPayload() }]) {
      expect(runAskClarification(store, input(bad))).toMatchObject({
        code: "PRODUCT_CONTRACT_CLARIFICATION_MALFORMED",
        layer: "PRODUCT_CONTRACT_CLARIFICATION", ok: false,
      });
    }
  });
});

describe("runAnswerClarification", () => {
  it("records the first answer, replays the identical one, refuses a different one", () => {
    const { clarificationId, store } = askedWorld();
    const digests = clarificationsForContract(store, PROJECT_ID, CONTRACT_ID)[0]?.optionDigests;
    const chosen = digests?.[0]?.projectionDigest as string;
    const other = digests?.[1]?.projectionDigest as string;

    const answered = runAnswerClarification(store, input({
      answerProjectionDigest: chosen, clarificationId, contractId: CONTRACT_ID,
    }, "sess-human-1"));
    expect(answered).toMatchObject({ disposition: "DECIDED", ok: true });
    const row = clarificationsForContract(store, PROJECT_ID, CONTRACT_ID)[0];
    expect(row?.answer).toEqual({
      answerProjectionDigest: chosen, answeredBy: "sess-human-1",
    });

    expect(runAnswerClarification(store, input({
      answerProjectionDigest: chosen, clarificationId, contractId: CONTRACT_ID,
    }, "sess-human-2"))).toMatchObject({ disposition: "REPLAYED", ok: true });
    expect(runAnswerClarification(store, input({
      answerProjectionDigest: other, clarificationId, contractId: CONTRACT_ID,
    }))).toMatchObject({
      code: "PRODUCT_CONTRACT_CLARIFICATION_ALREADY_ANSWERED", ok: false,
    });
    // The durable answer did not move.
    expect(clarificationsForContract(store, PROJECT_ID, CONTRACT_ID)[0]?.answer?.answeredBy)
      .toBe("sess-human-1");
  });

  it("refuses an unknown clarification and a digest outside the recorded options", () => {
    const { clarificationId, store } = askedWorld();
    expect(runAnswerClarification(store, input({
      answerProjectionDigest: "a".repeat(64),
      clarificationId: "clar-000000000000000000000000",
      contractId: CONTRACT_ID,
    }))).toMatchObject({ code: "PRODUCT_CONTRACT_CLARIFICATION_UNKNOWN", ok: false });
    expect(runAnswerClarification(store, input({
      answerProjectionDigest: "a".repeat(64), clarificationId, contractId: CONTRACT_ID,
    }))).toMatchObject({
      code: "PRODUCT_CONTRACT_CLARIFICATION_ANSWER_UNKNOWN_OPTION", ok: false,
    });
  });

  it("addresses one aggregate per (project, contract, clarification)", () => {
    const { clarificationId } = askedWorld();
    const one = clarificationAggregateId(PROJECT_ID, CONTRACT_ID, clarificationId);
    const two = clarificationAggregateId(PROJECT_ID, "other-contract", clarificationId);
    expect(one).toMatch(/^product-contract-clarification:[0-9a-f]{64}$/u);
    expect(one).not.toBe(two);
  });
});
