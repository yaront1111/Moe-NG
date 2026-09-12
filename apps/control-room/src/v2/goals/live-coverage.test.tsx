import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it } from "vitest";

import { mapDocumentCoverageAnswer } from "../../live/live-document-coverage.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import { sameDossier, useLiveCoverage } from "./live-coverage.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

/** The daemon's wire frame, decoded afresh each call: a NEW object with the SAME content. */
function decoded(status: "UNPLANNED" | "VERIFIED" = "UNPLANNED", lastActivityAt: string | null = null): DocumentCoverageOutcome {
  const outcome = mapDocumentCoverageAnswer(200, {
    contracts: [{
      contractId: "contract-1",
      gate1: "PENDING",
      plane: "V1",
      requirements: [{
        criteria: [{
          criterionId: "crit-1", nodeKey: null, nodeTestStatus: null,
          statement: "A returning operator reaches the board.", status,
        }],
        requirementId: "req-1",
        statement: "Operators sign in once per device.",
      }],
      revisionDigest: "a".repeat(64),
      revisionId: "rev-1",
    }],
    document: { byteLength: 1, contentSha256: "e".repeat(64), displayPath: null },
    goals: [{
      goalId: "goal-1", lastActivityAt, lifecycle: null, planningRunRef: null, title: null,
    }],
    outcome: "COVERAGE",
    sections: null,
    totals: {
      contracts: 1, criteria: 1, goals: 1, planned: 0, requirements: 1, unattributable: 0,
      verified: status === "VERIFIED" ? 1 : 0,
    },
  });
  if (outcome.status !== "COVERAGE") throw new Error(`wire frame refused: ${outcome.code}`);
  return outcome;
}

it("sameDossier is the contracts, not the object: a status change differs, activity does not", () => {
  expect(sameDossier(decoded(), decoded())).toBe(true);
  expect(sameDossier(decoded("UNPLANNED"), decoded("VERIFIED"))).toBe(false);
  // The goals' last activity is not rendered by the dossier and does not swap its state.
  expect(sameDossier(decoded("UNPLANNED", null), decoded("UNPLANNED", "2026-09-13T00:00:00.000Z"))).toBe(true);
  const refused: DocumentCoverageOutcome = { code: "X", layer: "Y", status: "REFUSED" };
  expect(sameDossier(refused, { ...refused })).toBe(true);
  expect(sameDossier(refused, decoded())).toBe(false);
});

it("keeps the same state while every poll answers the same dossier, and swaps it on a change", async () => {
  let reads = 0;
  let status: "UNPLANNED" | "VERIFIED" = "UNPLANNED";
  // One reader for the hook's lifetime, as cordum-app.tsx memoizes it: a new function per
  // render would re-run the effect and reset the state itself.
  const read = async (): Promise<DocumentCoverageOutcome> => {
    reads += 1;
    return decoded(status);
  };
  const view = renderHook(() => useLiveCoverage("goal-1", read, 5));
  await waitFor(() => expect(view.result.current?.status).toBe("COVERAGE"));
  const settled = view.result.current;

  const readsAtSettle = reads;
  await waitFor(() => expect(reads).toBeGreaterThan(readsAtSettle + 5));
  // Five later polls each decoded a fresh object with the same content: the SAME state stays.
  expect(view.result.current).toBe(settled);

  status = "VERIFIED";
  await waitFor(() => {
    const current = view.result.current;
    expect(current?.status === "COVERAGE" && current.contracts[0]?.requirements[0]?.criteria[0]?.status)
      .toBe("VERIFIED");
  });
  expect(view.result.current).not.toBe(settled);
});

it("turns a thrown read into ERROR once and keeps that state while the read keeps throwing", async () => {
  let reads = 0;
  const read = async (): Promise<DocumentCoverageOutcome> => {
    reads += 1;
    throw new Error("offline");
  };
  const view = renderHook(() => useLiveCoverage("goal-1", read, 5));
  await waitFor(() => expect(view.result.current?.status).toBe("ERROR"));
  const settled = view.result.current;
  expect(settled).toEqual({
    code: "CONTRACT_DOSSIER_COVERAGE_READ_FAILED", layer: "CONTROL_ROOM_GOALS", status: "ERROR",
  });
  const readsAtSettle = reads;
  await waitFor(() => expect(reads).toBeGreaterThan(readsAtSettle + 5));
  expect(view.result.current).toBe(settled);
});
