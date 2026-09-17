import { afterEach, expect, it } from "vitest";
import { readReviewLedger } from "./review-read-model.js";
import {
  PROJECT_ID, SUBJECT_REF, closeStores, deltaNode, driveRounds, envelope, escalationPayload, finding, openStore,
  replanPayload, send, submitPayload,
} from "./review-test-fixtures.js";

afterEach(closeStores);

const codeOf = (o: ReturnType<typeof send>) => o.ok ? "OK" : `${o.refusedBy}:${o.code}`;

it("drill: qualification.replan between ALLOW and the next round", () => {
  const store = openStore();
  driveRounds(store, 3);
  expect(codeOf(send(store, envelope("escalation.decide", 3, escalationPayload(), "allow")))).toBe("OK");
  expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).continuation).toBeDefined();
  const replan = send(store, envelope("qualification.replan", 4, replanPayload([deltaNode("node-x")]), "delta"));
  expect(codeOf(replan)).toBe("OK");
  const before = readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
  console.log("BEFORE", JSON.stringify({ version: before.version, unreadable: before.unreadable, continuation: before.continuation !== undefined }));
  const round4 = send(store, envelope("review.submit", before.version, submitPayload(4, [finding({ ruleId: "r4" })]), "round-4"));
  console.log("ROUND4", codeOf(round4));
  const after = readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
  console.log("AFTER", JSON.stringify({ version: after.version, unreadable: after.unreadable, rounds: after.rounds.length }));
  console.log("NEXT_ROUND", codeOf(send(store, envelope("review.submit", after.version, submitPayload(5, [finding({ ruleId: "r5" })]), "round-5"))));
  console.log("NEXT_ESCALATION", codeOf(send(store, envelope("escalation.decide", after.version, escalationPayload(), "allow-2"))));
  console.log("REPLAN_DECISION", codeOf(send(store, envelope("escalation.decide", after.version, escalationPayload({ decision: "REPLAN" }), "replan-2"))));
});

it("drill: qualification.replan while the node is already REPLANNED, and after acceptance-less accept", () => {
  const store = openStore();
  driveRounds(store, 3);
  expect(codeOf(send(store, envelope("escalation.decide", 3, escalationPayload({ decision: "REPLAN" }), "replan")))).toBe("OK");
  console.log("REPLAN_AFTER_REPLANNED", codeOf(send(store, envelope("qualification.replan", 4, replanPayload([deltaNode("node-x")]), "delta"))));
});
