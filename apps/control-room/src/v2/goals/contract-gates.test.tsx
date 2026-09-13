import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it } from "vitest";

import { mapDocumentCoverageAnswer } from "../../live/live-document-coverage.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import { mapProductContractGate1Answer } from "../../live/live-product-contract-gate-1.js";
import type { ProductContractGate1Outcome } from "../../live/live-product-contract-gate-1.js";
import { REAL_GATE_1_FRAME, REAL_GATE_1_REF } from "../../live/product-contract-gate-1-frame.fixture.js";
import { contractGateKey, useContractGates } from "./contract-gates.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

/** A coverage frame citing the fixture's one revision, decoded by the production decoder. */
function coverage(): DocumentCoverageOutcome {
  const outcome = mapDocumentCoverageAnswer(200, {
    contracts: [{
      contractId: REAL_GATE_1_REF.contractId, gate1: "APPROVED", plane: "V1", requirements: [],
      revisionDigest: REAL_GATE_1_REF.revisionDigest, revisionId: REAL_GATE_1_REF.revisionId,
    }],
    document: { byteLength: 1, contentSha256: "e".repeat(64), displayPath: null },
    goals: [],
    outcome: "COVERAGE",
    sections: null,
    totals: { contracts: 1, criteria: 0, goals: 0, planned: 0, requirements: 0, unattributable: 0, verified: 0 },
  });
  if (outcome.status !== "COVERAGE") throw new Error(`coverage frame refused: ${outcome.code}`);
  return outcome;
}

/** The daemon's answer, decoded afresh each call: a NEW object with the SAME content. */
function freshGate(): ProductContractGate1Outcome {
  const outcome = mapProductContractGate1Answer(200, REAL_GATE_1_FRAME);
  if (outcome.status !== "GATE") throw new Error(`gate frame refused: ${outcome.code}`);
  return outcome;
}

it("keeps the same gate map while every poll answers the same verdict, and swaps it on a change", async () => {
  let reads = 0;
  let answer: () => ProductContractGate1Outcome = freshGate;
  // One reader for the hook's lifetime, as cordum-app.tsx memoizes it.
  const readGate = async (): Promise<ProductContractGate1Outcome> => {
    reads += 1;
    return answer();
  };
  const view = renderHook(() => useContractGates(coverage(), readGate, 5));
  await waitFor(() => expect(view.result.current.size).toBe(1));
  const settled = view.result.current;
  expect(settled.get(contractGateKey(REAL_GATE_1_REF))?.status).toBe("GATE");

  const readsAtSettle = reads;
  await waitFor(() => expect(reads).toBeGreaterThan(readsAtSettle + 5));
  // Five later polls each decoded a fresh object with the same content: the SAME map stays.
  expect(view.result.current).toBe(settled);

  answer = () => ({ code: "PRODUCT_CONTRACT_GATE_1_APPROVAL_ABSENT", layer: "PRODUCT_CONTRACT_GATE_1_READER", status: "REFUSED" });
  await waitFor(() => {
    expect(view.result.current.get(contractGateKey(REAL_GATE_1_REF))?.status).toBe("REFUSED");
  });
  expect(view.result.current).not.toBe(settled);
});
