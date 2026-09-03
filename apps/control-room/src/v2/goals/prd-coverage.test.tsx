import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import { PrdCoverage, coverageBanner, coverageComplete } from "./prd-coverage.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Coverage = Extract<DocumentCoverageOutcome, { status: "COVERAGE" }>;

function coverage(overrides: Partial<Coverage> = {}): Coverage {
  return {
    contracts: [{
      contractId: "contract-1", gate1: "APPROVED", plane: "V1",
      requirements: [{
        criteria: [
          { criterionId: "crit-1", nodeKey: "node-a", statement: "Rows keep fields.", status: "VERIFIED" },
          { criterionId: "crit-2", nodeKey: "node-b", statement: "No edits.", status: "PLANNED" },
          { criterionId: "crit-3", nodeKey: null, statement: "Anchors resolve.", status: "UNPLANNED" },
        ],
        requirementId: "req-evidence", statement: "Evidence is immutable.",
      }],
      revisionDigest: "d".repeat(64), revisionId: "rev-1",
    }],
    document: { byteLength: 120, contentSha256: "b".repeat(64), displayPath: "PRD.md" },
    goals: [{ goalId: "goal-1", lastActivityAt: "2026-09-02T19:00:00.000Z", lifecycle: "EXECUTION_ENABLED", planningRunRef: "run-1", title: "Build it" }],
    sections: [
      { cited: 1, criteria: 1, heading: "11. Evidence", number: "11", verified: 1 },
      { cited: 0, criteria: 0, heading: "Appendix", number: null, verified: 0 },
    ],
    status: "COVERAGE",
    totals: { contracts: 1, criteria: 3, goals: 1, planned: 1, requirements: 1, unattributable: 0, verified: 1 },
    ...overrides,
  };
}

const complete = (): Coverage => coverage({
  contracts: [{
    contractId: "contract-1", gate1: "APPROVED", plane: "V1",
    requirements: [{
      criteria: [
        { criterionId: "crit-1", nodeKey: "node-a", statement: "Rows keep fields.", status: "VERIFIED" },
        { criterionId: "crit-2", nodeKey: "node-b", statement: "No edits.", status: "VERIFIED" },
      ],
      requirementId: "req-evidence", statement: "Evidence is immutable.",
    }],
    revisionDigest: "d".repeat(64), revisionId: "rev-1",
  }],
  totals: { contracts: 1, criteria: 2, goals: 1, planned: 0, requirements: 1, unattributable: 0, verified: 2 },
});

describe("coverageComplete", () => {
  it("is true only when every criterion is VERIFIED and every contract is past Gate 1", () => {
    expect(coverageComplete(complete())).toBe(true);
    expect(coverageComplete(coverage())).toBe(false);
    const done = complete();
    expect(coverageComplete({
      ...done, contracts: [{ ...done.contracts[0]!, gate1: "PENDING" }],
    })).toBe(false);
    // Zero criteria is never "complete": an empty contract proves nothing.
    expect(coverageComplete(coverage({
      contracts: [], totals: { contracts: 0, criteria: 0, goals: 1, planned: 0, requirements: 0, unattributable: 0, verified: 0 },
    }))).toBe(false);
  });

  it("spells the banner from the totals, never from a local verdict", () => {
    expect(coverageBanner(coverage())).toContain("1 of 3 acceptance criteria VERIFIED");
    expect(coverageBanner(coverage())).toContain("1 planned");
    expect(coverageBanner(coverage())).toContain("1 unplanned");
    expect(coverageBanner(complete())).toContain("All 2 acceptance criteria VERIFIED");
    expect(coverageBanner(complete())).toContain("Closing the goal is your call");
    expect(coverageBanner(coverage({
      contracts: [], totals: { contracts: 0, criteria: 0, goals: 1, planned: 0, requirements: 0, unattributable: 0, verified: 0 },
    }))).toContain("No Product Contract cites this PRD yet");
  });
});

describe("the PRD coverage card", () => {
  it("renders the daemon's coverage: banner, bar, each criterion with its status and node", async () => {
    const read = vi.fn(async () => coverage());
    render(<PrdCoverage goalId="goal-1" pollMs={60_000} read={read} />);
    await screen.findByTestId("cr.coverage.body");
    expect(read).toHaveBeenCalledWith("goal-1");
    expect(screen.getByTestId("cr.coverage.banner").getAttribute("data-complete")).toBe("false");
    expect(screen.getByTestId("cr.coverage.bar").getAttribute("aria-valuenow")).toBe("1");
    expect(screen.getByTestId("cr.coverage.bar").getAttribute("aria-valuemax")).toBe("3");
    expect(screen.getByTestId("cr.coverage.document").textContent).toContain("PRD.md");
    expect(screen.getByTestId("cr.coverage.document").textContent).toContain("1 of 2 PRD sections cited");
    expect(screen.getByTestId("cr.coverage.contract.contract-1").textContent).toContain("GATE 1 APPROVED");
    expect(screen.getByTestId("cr.coverage.criterion.crit-1").getAttribute("data-status")).toBe("VERIFIED");
    expect(screen.getByTestId("cr.coverage.criterion.crit-1").textContent).toContain("node-a");
    expect(screen.getByTestId("cr.coverage.criterion.crit-2").getAttribute("data-status")).toBe("PLANNED");
    expect(screen.getByTestId("cr.coverage.criterion.crit-3").getAttribute("data-status")).toBe("UNPLANNED");
    expect(screen.getByTestId("cr.coverage.section.11").textContent).toContain("cited 1");
    expect(screen.getByTestId("cr.coverage.section.h1").getAttribute("data-cited")).toBe("false");
  });

  it("marks the card complete when the daemon reports every criterion verified", async () => {
    render(<PrdCoverage goalId="goal-1" pollMs={60_000} read={async () => complete()} />);
    const banner = await screen.findByTestId("cr.coverage.banner");
    expect(banner.getAttribute("data-complete")).toBe("true");
    expect(banner.textContent).toContain("Closing the goal is your call");
  });

  it("shows a daemon refusal at its own layer and a rejected read as an ERROR", async () => {
    render(<PrdCoverage goalId="goal-1" pollMs={60_000} read={async () => ({
      code: "DOCUMENT_COVERAGE_READ_GOAL_UNBOUND", layer: "DOCUMENT_COVERAGE_READ", status: "REFUSED",
    })} />);
    expect((await screen.findByTestId("cr.coverage.refusal")).textContent)
      .toBe("REFUSED · DOCUMENT_COVERAGE_READ_GOAL_UNBOUND · DOCUMENT_COVERAGE_READ");
    cleanup();
    render(<PrdCoverage goalId="goal-1" pollMs={60_000} read={() => Promise.reject(new Error("x"))} />);
    expect((await screen.findByTestId("cr.coverage.refusal")).textContent).toContain("COVERAGE_READ_FAILED");
  });

  it("re-reads on its poll cadence and drops a stale answer after unmount", async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn(async () => coverage());
      const view = render(<PrdCoverage goalId="goal-1" pollMs={1_000} read={read} />);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(read).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(read).toHaveBeenCalledTimes(3);
      view.unmount();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(read).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps showing the loading line until the first answer lands", async () => {
    let resolve!: (value: DocumentCoverageOutcome) => void;
    const pending = new Promise<DocumentCoverageOutcome>((accept) => { resolve = accept; });
    render(<PrdCoverage goalId="goal-1" pollMs={60_000} read={() => pending} />);
    expect(screen.getByTestId("cr.coverage.loading")).toBeTruthy();
    resolve(coverage());
    await waitFor(() => expect(screen.queryByTestId("cr.coverage.loading")).toBeNull());
    expect(screen.getByTestId("cr.coverage.body")).toBeTruthy();
  });
});
