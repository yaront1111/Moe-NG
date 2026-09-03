import { describe, expect, it } from "vitest";

import { mapDocumentCoverageAnswer, readDocumentCoverage } from "./live-document-coverage.js";

/**
 * The PRD coverage read client. mapDocumentCoverageAnswer is exercised over the exact wire
 * frames POST /documents/coverage/read emits (verified against document-coverage-read.ts):
 * a full COVERAGE frame, a frame whose sections are null, the route's own three-key refusal,
 * the listener's two-key refusal, a non-200 non-refusal, and frames whose nested bodies
 * drift (an ERROR, never a half-coverage). readDocumentCoverage is exercised with an
 * injected post so the request body can be asserted EXACTLY.
 */

const SHA = "b".repeat(64);

const CRITERION = Object.freeze({
  criterionId: "crit-1", nodeKey: "node-a", statement: "Rows keep their fields.", status: "VERIFIED",
});
const REQUIREMENT = Object.freeze({
  criteria: [CRITERION, { criterionId: "crit-2", nodeKey: null, statement: "No edits.", status: "UNPLANNED" }],
  requirementId: "req-evidence",
  statement: "Evidence is immutable (PRD 11).",
});
const CONTRACT = Object.freeze({
  contractId: "contract-1", gate1: "APPROVED", requirements: [REQUIREMENT],
  revisionDigest: "d".repeat(64), revisionId: "rev-1",
});
const COVERAGE = Object.freeze({
  contracts: [CONTRACT],
  document: { byteLength: 120, contentSha256: SHA, displayPath: "PRD.md" },
  goals: [{ goalId: "goal-1", lastActivityAt: "2026-09-02T19:00:00.000Z", lifecycle: "EXECUTION_ENABLED", planningRunRef: "run-1", title: "Build it" }],
  outcome: "COVERAGE",
  sections: { advisoryOnly: true, entries: [
    { cited: 1, criteria: 1, heading: "11. Evidence", number: "11", verified: 1 },
    { cited: 0, criteria: 0, heading: "Appendix", number: null, verified: 0 },
  ] },
  totals: { contracts: 1, criteria: 2, goals: 1, planned: 0, requirements: 1, verified: 1 },
});

function response(status: number, body: unknown): Response {
  return { json: async () => body, status } as unknown as Response;
}

describe("mapDocumentCoverageAnswer shapes the coverage route's answer", () => {
  it("maps a full COVERAGE frame, carrying the advisory section map", () => {
    expect(mapDocumentCoverageAnswer(200, COVERAGE)).toStrictEqual({
      contracts: [{
        contractId: "contract-1", gate1: "APPROVED",
        requirements: [{
          criteria: [
            { criterionId: "crit-1", nodeKey: "node-a", statement: "Rows keep their fields.", status: "VERIFIED" },
            { criterionId: "crit-2", nodeKey: null, statement: "No edits.", status: "UNPLANNED" },
          ],
          requirementId: "req-evidence", statement: "Evidence is immutable (PRD 11).",
        }],
        revisionDigest: "d".repeat(64), revisionId: "rev-1",
      }],
      document: { byteLength: 120, contentSha256: SHA, displayPath: "PRD.md" },
      goals: [{ goalId: "goal-1", lastActivityAt: "2026-09-02T19:00:00.000Z", lifecycle: "EXECUTION_ENABLED", planningRunRef: "run-1", title: "Build it" }],
      sections: [
        { cited: 1, criteria: 1, heading: "11. Evidence", number: "11", verified: 1 },
        { cited: 0, criteria: 0, heading: "Appendix", number: null, verified: 0 },
      ],
      status: "COVERAGE",
      totals: { contracts: 1, criteria: 2, goals: 1, planned: 0, requirements: 1, verified: 1 },
    });
  });

  it("keeps null sections null and an unbound document honest", () => {
    const outcome = mapDocumentCoverageAnswer(200, {
      ...COVERAGE, contracts: [], goals: [],
      document: { byteLength: null, contentSha256: SHA, displayPath: null }, sections: null,
      totals: { contracts: 0, criteria: 0, goals: 0, planned: 0, requirements: 0, verified: 0 },
    });
    expect(outcome).toMatchObject({ contracts: [], sections: null, status: "COVERAGE" });
  });

  it("carries the route's own refusal and the listener's refusal at their layers", () => {
    expect(mapDocumentCoverageAnswer(200, {
      code: "DOCUMENT_COVERAGE_READ_GOAL_UNBOUND", layer: "DOCUMENT_COVERAGE_READ", outcome: "REFUSED",
    })).toStrictEqual({
      code: "DOCUMENT_COVERAGE_READ_GOAL_UNBOUND", layer: "DOCUMENT_COVERAGE_READ", status: "REFUSED",
    });
    expect(mapDocumentCoverageAnswer(503, {
      code: "LISTENER_DOCUMENT_COVERAGE_UNAVAILABLE", layer: "CONTROL_ROOM_LISTENER",
    })).toStrictEqual({
      code: "LISTENER_DOCUMENT_COVERAGE_UNAVAILABLE", layer: "CONTROL_ROOM_LISTENER", status: "REFUSED",
    });
  });

  it("reddens the whole answer when any nested body drifts", () => {
    const invalid = {
      code: "DOCUMENT_COVERAGE_RESPONSE_INVALID", layer: "CONTROL_ROOM_LIVE_COVERAGE", status: "ERROR",
    };
    expect(mapDocumentCoverageAnswer(500, { unexpected: true })).toStrictEqual(invalid);
    expect(mapDocumentCoverageAnswer(200, { ...COVERAGE, extra: 1 })).toStrictEqual(invalid);
    expect(mapDocumentCoverageAnswer(200, { ...COVERAGE, outcome: "RUN" })).toStrictEqual(invalid);
    expect(mapDocumentCoverageAnswer(200, {
      ...COVERAGE, contracts: [{ ...CONTRACT, gate1: "MAYBE" }],
    })).toStrictEqual(invalid);
    expect(mapDocumentCoverageAnswer(200, {
      ...COVERAGE,
      contracts: [{ ...CONTRACT, requirements: [{ ...REQUIREMENT, criteria: [{ ...CRITERION, status: "DONE" }] }] }],
    })).toStrictEqual(invalid);
    expect(mapDocumentCoverageAnswer(200, {
      ...COVERAGE, sections: { advisoryOnly: false, entries: [] },
    })).toStrictEqual(invalid);
    expect(mapDocumentCoverageAnswer(200, {
      ...COVERAGE, totals: { ...COVERAGE.totals, verified: -1 },
    })).toStrictEqual(invalid);
  });
});

describe("readDocumentCoverage", () => {
  it("posts exactly { goalRef } and maps the reply", async () => {
    const bodies: string[] = [];
    const outcome = await readDocumentCoverage({ "x-moe-csrf": "t" }, "goal-1", async (body) => {
      bodies.push(body);
      return response(200, COVERAGE);
    });
    expect(bodies).toEqual([JSON.stringify({ goalRef: "goal-1" })]);
    expect(outcome.status).toBe("COVERAGE");
  });

  it("maps a transport failure and an unparsable body to ERROR", async () => {
    expect(await readDocumentCoverage({}, "goal-1", async () => { throw new Error("down"); }))
      .toStrictEqual({
        code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_LIVE_COVERAGE", status: "ERROR",
      });
    expect(await readDocumentCoverage({}, "goal-1", async () =>
      ({ json: async () => { throw new Error("not json"); }, status: 200 } as unknown as Response)))
      .toStrictEqual({
        code: "DOCUMENT_COVERAGE_RESPONSE_INVALID", layer: "CONTROL_ROOM_LIVE_COVERAGE", status: "ERROR",
      });
  });
});
