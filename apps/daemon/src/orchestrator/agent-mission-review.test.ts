import { rmSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import type { JsonObject } from "@moe/contracts";
import { REVIEW_FINDING_SEVERITIES, REVIEW_FINDING_SUBJECT_KINDS } from "@moe/review";
import { closeStores, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { reviewSubmissionMissionLines } from "./agent-mission-review.js";
import { reviewWorld } from "./wrapper-review-test-fixtures.js";

const worlds: ReturnType<typeof reviewWorld>[] = [];
afterEach(async () => {
  for (const world of worlds) await world.finishSeat();
  closeStores();
  for (const world of worlds.splice(0)) rmSync(world.workspace, { recursive: true, force: true });
});

it("gives a coding worker an executable incomplete finding that records rejection", async () => {
  const world = reviewWorld();
  worlds.push(world);
  const lines = reviewSubmissionMissionLines(world.nodeRef);
  const prefix = "Finding example: ";
  const example = lines.find((line) => line.startsWith(prefix));
  expect(example, "worker must not need daemon source access to construct a finding").toBeDefined();
  const finding = JSON.parse(example!.slice(prefix.length)) as JsonObject;
  expect(finding).toMatchObject({ severity: "MAJOR", subject: { kind: "NODE", locator: world.nodeRef } });
  expect((await world.wrapper.runOnce()).spawned).toMatchObject([{ outcome: "SPAWNED" }]);
  expect(await world.dispatch(world.requests[0]!, "review.submit", {
    subjectRef: world.nodeRef, round: 1, findings: [finding], packageItems: [],
  }, 0)).toMatchObject({ ok: true });
  const ledger = readReviewLedger(world.store, PROJECT_ID, world.nodeRef);
  expect(ledger.rounds[0]?.routing.route).toBe("REJECT_IMPLEMENTATION");
  expect(ledger.lineage.records[0]?.finding).toEqual(finding);
  expect(ledger.accepted).toBeUndefined();
  expect(world.runs()).toBe(0);
});

/**
 * The live cause (UnAI 2026-09-18): the example rendered round as the placeholder STRING
 * "<expectedVersion + 1>", three seats copied the quoting, and each was refused
 * REVIEW_PAYLOAD_INVALID. The example must be sendable JSON with a NUMERIC round, and the
 * sentence that names the round must name its JSON type.
 */
it("shows round as a JSON number in the example and says it is never a quoted string", () => {
  const lines = reviewSubmissionMissionLines("node:v1:example");
  const roundLine = lines.find((line) => line.startsWith("The review_submit payload must have exactly"));
  expect(roundLine).toBeDefined();
  const example = JSON.parse(roundLine!.slice(roundLine!.indexOf("{"), roundLine!.indexOf("}") + 1)) as JsonObject;
  expect(example).toEqual({ subjectRef: "node:v1:example", round: 1, findings: [], packageItems: [] });
  expect(typeof example["round"]).toBe("number");
  expect(roundLine).toContain("round is a JSON integer equal to expectedVersion + 1");
  expect(roundLine).toContain('never the quoted string "2"');
  expect(roundLine).toContain("refused REVIEW_PAYLOAD_INVALID");
  expect(roundLine).not.toContain("<expectedVersion + 1>");
});

it("teaches the decoder vocabularies and preserves finding identity across rounds", () => {
  const text = reviewSubmissionMissionLines("node:v1:example").join(" ");
  expect(text).toContain(`severity: ${REVIEW_FINDING_SEVERITIES.join(", ")}`);
  expect(text).toContain(`subject.kind: ${REVIEW_FINDING_SUBJECT_KINDS.join(", ")}`);
  expect(text).toContain("Keep the same ruleId and subject for the same unresolved issue across rounds");
});
