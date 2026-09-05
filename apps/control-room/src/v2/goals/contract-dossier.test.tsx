/**
 * The approved-contract dossier on the opened goal.
 *
 * BOTH DAEMON ANSWERS ARE REAL FRAMES, and "real" means something different for each:
 *  - the Gate 1 frame is BUILT BY PRODUCTION CORE (product-contract-gate-1-frame.fixture.ts
 *    calls createProductContractRevision, grantHumanAuthority and validateProductContractGate1,
 *    then wraps them exactly as the route does), so nothing about its shape is authored here;
 *  - the coverage frame is the daemon's WIRE JSON, and it reaches the screen ONLY through the
 *    production decoder `mapDocumentCoverageAnswer`. Nothing is typed straight into the
 *    component. If the daemon's coverage shape drifts, the exact-key decoder refuses and
 *    these arms go red instead of rendering a hand-shaped object the daemon never sent.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { mapDocumentCoverageAnswer } from "../../live/live-document-coverage.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import { mapProductContractGate1Answer } from "../../live/live-product-contract-gate-1.js";
import type { ProductContractGate1Outcome } from "../../live/live-product-contract-gate-1.js";
import {
  REAL_GATE_1_FRAME, REAL_GATE_1_REF, REAL_GATE_1_REVISION_DIGEST,
} from "../../live/product-contract-gate-1-frame.fixture.js";
import { ContractDossier, LiveContractDossier } from "./contract-dossier.js";
import { contractGateKey } from "./contract-gates.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

/** The daemon's wire frame for /documents/coverage/read, citing the fixture's revision. */
const COVERAGE_WIRE = Object.freeze({
  contracts: [{
    contractId: REAL_GATE_1_REF.contractId,
    gate1: "APPROVED",
    plane: "V1",
    requirements: [{
      criteria: [
        {
          criterionId: "crit-sso-1", nodeKey: "node-sign-in",
          statement: "A returning operator reaches the board without retyping a password.",
          status: "VERIFIED",
        },
        {
          criterionId: "crit-sso-2", nodeKey: null,
          statement: "A revoked credential is refused with its own code.",
          status: "UNPLANNED",
        },
      ],
      requirementId: "req-sign-in",
      statement: "Operators sign in once per device.",
    }],
    revisionDigest: REAL_GATE_1_REF.revisionDigest,
    revisionId: REAL_GATE_1_REF.revisionId,
  }],
  document: { byteLength: 4_096, contentSha256: "e".repeat(64), displayPath: "PRD.md" },
  goals: [{
    goalId: "goal-sign-in", lastActivityAt: "2026-09-05T09:00:00.000Z",
    lifecycle: "EXECUTION_ENABLED", planningRunRef: "run-1", title: "Sign in once",
  }],
  outcome: "COVERAGE",
  sections: null,
  totals: {
    contracts: 1, criteria: 2, goals: 1, planned: 0, requirements: 1, unattributable: 0,
    verified: 1,
  },
});

function decodedCoverage(): DocumentCoverageOutcome {
  const outcome = mapDocumentCoverageAnswer(200, COVERAGE_WIRE);
  // Non-vacuous: if the production decoder refuses this wire frame, no arm below is testing
  // a rendered dossier, so fail loudly here rather than asserting on an error card.
  if (outcome.status !== "COVERAGE") {
    throw new Error(`coverage wire frame refused by the production decoder: ${outcome.code}`);
  }
  return outcome;
}

function decodedGate(): ProductContractGate1Outcome {
  const outcome = mapProductContractGate1Answer(200, REAL_GATE_1_FRAME);
  if (outcome.status !== "GATE") {
    throw new Error(`real gate frame refused by the production decoder: ${outcome.code}`);
  }
  return outcome;
}

function gateMap(): ReadonlyMap<string, ProductContractGate1Outcome> {
  return new Map([[contractGateKey(REAL_GATE_1_REF), decodedGate()]]);
}

describe("ContractDossier", () => {
  it("carries a NAMED criterion's coverage state into its own row", () => {
    render(<ContractDossier coverage={decodedCoverage()} gates={gateMap()} />);
    const verified = screen.getByTestId("cr.contract.criterion.crit-sso-1");
    expect(verified.getAttribute("data-status")).toBe("VERIFIED");
    expect(verified.textContent).toContain("VERIFIED");
    expect(verified.textContent).toContain("crit-sso-1");
    expect(verified.textContent).toContain("node-sign-in");
    // The SECOND criterion of the SAME requirement carries a DIFFERENT state, so a card that
    // painted one status over every row would fail here.
    const unplanned = screen.getByTestId("cr.contract.criterion.crit-sso-2");
    expect(unplanned.getAttribute("data-status")).toBe("UNPLANNED");
    expect(unplanned.textContent).toContain("UNPLANNED");
  });

  it("shows the approved revision id, the durable Gate 1 verdict and the requirements count", () => {
    render(<ContractDossier coverage={decodedCoverage()} gates={gateMap()} />);
    const verdict = screen.getByTestId(`cr.contract.gate1.${REAL_GATE_1_REF.contractId}`);
    expect(verdict.textContent).toContain(REAL_GATE_1_REF.revisionId);
    expect(verdict.textContent).toContain(REAL_GATE_1_REVISION_DIGEST);
    expect(verdict.textContent).toContain("Gate 1 approved");
    const counts = screen.getByTestId(`cr.contract.counts.${REAL_GATE_1_REF.contractId}`);
    expect(counts.textContent).toContain("1 requirements");
    expect(counts.textContent).toContain("2 acceptance criteria");
    expect(screen.getByTestId(`cr.contract.requirement.req-sign-in`).textContent)
      .toContain("Operators sign in once per device.");
  });

  it("says it is still reading a Gate 1 verdict rather than claiming one", () => {
    render(<ContractDossier coverage={decodedCoverage()} gates={new Map()} />);
    expect(screen.getByTestId(`cr.contract.gate1.${REAL_GATE_1_REF.contractId}.reading`))
      .toBeTruthy();
    expect(screen.queryByTestId(`cr.contract.gate1.${REAL_GATE_1_REF.contractId}`)).toBeNull();
    // The criteria still render: an unanswered Gate 1 read does not blank the coverage.
    expect(screen.getByTestId("cr.contract.criterion.crit-sso-1")).toBeTruthy();
  });
});

describe("LiveContractDossier", () => {
  it("reads coverage on the goal and one Gate 1 verdict per cited revision", async () => {
    const asked: unknown[] = [];
    render(
      <LiveContractDossier
        goalId="goal-sign-in"
        pollMs={60_000}
        readCoverage={async () => decodedCoverage()}
        readGate={async (ref) => {
          asked.push(ref);
          return mapProductContractGate1Answer(200, REAL_GATE_1_FRAME);
        }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId(`cr.contract.gate1.${REAL_GATE_1_REF.contractId}`)).toBeTruthy();
    });
    expect(asked).toEqual([{
      contractId: REAL_GATE_1_REF.contractId,
      revisionDigest: REAL_GATE_1_REF.revisionDigest,
      revisionId: REAL_GATE_1_REF.revisionId,
    }]);
    expect(screen.getByTestId("cr.contract.criterion.crit-sso-1").getAttribute("data-status"))
      .toBe("VERIFIED");
  });
});

/**
 * REFUSALS RENDER, ABSENCE IS WORDS, AND THE TWO READS ARE INDEPENDENT.
 *
 * The distinction this block exists for: an empty requirements list reads to an operator as
 * "this contract asks for nothing". That is a DIFFERENT and FALSE claim from "the read
 * refused", so a refused read must never be rendered as an empty dossier.
 */
describe("ContractDossier refusals and absence", () => {
  it("renders a coverage refusal VERBATIM and renders NO dossier body", () => {
    render(
      <ContractDossier
        coverage={{
          code: "DOCUMENT_COVERAGE_READ_GOAL_UNBOUND",
          layer: "DOCUMENT_COVERAGE_READ",
          status: "REFUSED",
        }}
        gates={new Map()}
      />,
    );
    expect(screen.getByTestId("cr.contract.refusal").textContent)
      .toContain("DOCUMENT_COVERAGE_READ_GOAL_UNBOUND @ DOCUMENT_COVERAGE_READ");
    // The load-bearing negative: no body, no contract block, no criteria row.
    expect(screen.queryByTestId("cr.contract.body")).toBeNull();
    expect(screen.queryByTestId("cr.contract.none")).toBeNull();
    expect(screen.queryByTestId("cr.contract.criterion.crit-sso-1")).toBeNull();
  });

  it("renders a GATE 1 refusal VERBATIM without blanking the coverage beside it", () => {
    render(
      <ContractDossier
        coverage={decodedCoverage()}
        gates={new Map([[contractGateKey(REAL_GATE_1_REF), {
          code: "APPROVAL_HUMAN_AUTHORITY_REQUIRED",
          layer: "HUMAN_AUTHORITY_GATE",
          status: "REFUSED",
        }]])}
      />,
    );
    expect(screen.getByTestId(`cr.contract.gate1.${REAL_GATE_1_REF.contractId}.refusal`).textContent)
      .toContain("APPROVAL_HUMAN_AUTHORITY_REQUIRED @ HUMAN_AUTHORITY_GATE");
    expect(screen.queryByTestId(`cr.contract.gate1.${REAL_GATE_1_REF.contractId}`)).toBeNull();
    // INDEPENDENCE: one read refusing does not blank the other's answer.
    expect(screen.getByTestId("cr.contract.criterion.crit-sso-1").getAttribute("data-status"))
      .toBe("VERIFIED");
    expect(screen.getByTestId(`cr.contract.counts.${REAL_GATE_1_REF.contractId}`).textContent)
      .toContain("1 requirements");
  });

  it("says in words when the daemon genuinely reports no contract and no criterion", () => {
    const empty = mapDocumentCoverageAnswer(200, {
      ...COVERAGE_WIRE,
      contracts: [],
      totals: { ...COVERAGE_WIRE.totals, contracts: 0, criteria: 0, requirements: 0, verified: 0 },
    });
    if (empty.status !== "COVERAGE") throw new Error(`empty wire frame refused: ${empty.code}`);
    render(<ContractDossier coverage={empty} gates={new Map()} />);
    expect(screen.getByTestId("cr.contract.none").textContent)
      .toBe("No Product Contract cites this PRD yet.");
    expect(screen.queryByTestId("cr.contract.refusal")).toBeNull();

    cleanup();
    const bare = mapDocumentCoverageAnswer(200, {
      ...COVERAGE_WIRE,
      contracts: [{
        ...COVERAGE_WIRE.contracts[0],
        requirements: [{
          criteria: [], requirementId: "req-sign-in",
          statement: "Operators sign in once per device.",
        }],
      }],
      totals: { ...COVERAGE_WIRE.totals, criteria: 0, verified: 0 },
    });
    if (bare.status !== "COVERAGE") throw new Error(`bare wire frame refused: ${bare.code}`);
    render(<ContractDossier coverage={bare} gates={new Map()} />);
    expect(screen.getByTestId("cr.contract.requirement.req-sign-in.nocriteria").textContent)
      .toBe("This requirement carries no acceptance criterion yet.");
  });

  it("says it is reading rather than rendering an empty dossier before the first answer", () => {
    render(<ContractDossier coverage={null} gates={new Map()} />);
    expect(screen.getByTestId("cr.contract.loading")).toBeTruthy();
    expect(screen.queryByTestId("cr.contract.body")).toBeNull();
    expect(screen.queryByTestId("cr.contract.none")).toBeNull();
  });

  it("turns a thrown coverage read into a visible ERROR, never a silent empty dossier", async () => {
    render(
      <LiveContractDossier
        goalId="goal-sign-in"
        pollMs={60_000}
        readCoverage={async () => { throw new Error("offline"); }}
        readGate={undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("cr.contract.refusal").textContent)
        .toContain("CONTRACT_DOSSIER_COVERAGE_READ_FAILED @ CONTROL_ROOM_GOALS");
    });
    expect(screen.queryByTestId("cr.contract.body")).toBeNull();
  });
});
