import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { TRUTH_ABSENT_PROVENANCE, TRUTH_INVALID_PROVENANCE } from "../kernel.js";
import { UNKNOWN_FACT_VALUE } from "../nodes/node-authority.js";
import type { PresentedFact } from "../nodes/node-authority.js";
import { NO_DIFF_WITHOUT_SHAS, ReviewSurface } from "./review-surface.js";
import type { ReviewSurfaceProps } from "./review-surface.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const verified = (value: string): PresentedFact => ({ truthClass: "DAEMON_VERIFIED", value });
const observed = (value: string): PresentedFact => ({ truthClass: "OBSERVED", value });

const BASE_SHA = "4f1c8b0a9d2e6537ab41c09f7e5d8236b0a1c4d9";
const HEAD_SHA = "9c1d4f7b2e6a80c35f19adbe7742c0916d38ee5a";
const REVIEW_COMPONENT_IDS = [
  "cr.review.context", "cr.review.criteria", "cr.review.diff",
  "cr.review.findings", "cr.review.receipts",
];

function reviewProps(): ReviewSurfaceProps {
  return {
    context: {
      graphHash: verified("sha256:graph-13"),
      planHash: verified("sha256:plan-7"),
      planRevision: observed("rev a3f9c2"),
    },
    criteria: [{
      criterionId: "crit-1", state: verified("MET"),
      statement: observed("contract tests green"),
    }],
    diff: {
      baseSha: verified(BASE_SHA),
      dirtyTree: verified("clean worktree"),
      headSha: verified(HEAD_SHA),
      paths: [
        { outOfScope: false, path: "src/api/retry.ts" },
        { outOfScope: true, path: "src/billing/ledger.ts" },
      ],
    },
    findings: [{
      category: observed("integration"), detail: observed("contract drift on POST /retry"),
      findingId: "fnd-1", severity: observed("HIGH"),
    }],
    receipts: [
      { provenanceRef: "receipt/rcpt-1", receiptId: "rcpt-1", recipe: verified("pnpm test"), result: verified("exit 0") },
    ],
    reviewer: {
      calibration: observed("reported catch-rate 68% (reported, not gating)"),
      independence: verified("distinct principal from builders"),
      principal: observed("human/reviewer-2"),
    },
  };
}

const reviewIds = (surface: HTMLElement): string[] =>
  [...surface.querySelectorAll("[data-testid^='cr.review.']")]
    .map((node) => node.getAttribute("data-testid") ?? "");

const valueOf = (factId: string): string =>
  within(screen.getByTestId(`cr.fact.${factId}`)).getByTestId("cr.value").textContent ?? "";

const chipOf = (factId: string): HTMLElement =>
  within(screen.getByTestId(`cr.fact.${factId}`)).getByTestId(/^cr\.chip\./u);

describe("the review surface contains exactly the five declared components", () => {
  it("renders the five named descendants and no other review component", () => {
    render(<ReviewSurface {...reviewProps()} />);
    const surface = screen.getByTestId("cr.review.surface");
    const ids = reviewIds(surface);
    expect(ids.filter((id) => /^cr\.review\.[a-z]+$/u.test(id)).sort())
      .toEqual(REVIEW_COMPONENT_IDS);
    // Anything else under the review namespace must be a declared list row; a sixth
    // component would otherwise slip in unnoticed beside the five.
    expect(ids.filter((id) => !REVIEW_COMPONENT_IDS.includes(id)
      && !id.startsWith("cr.review.row."))).toEqual([]);
  });

  it("pins the exact base and head SHAs and flags out-of-scope paths", () => {
    render(<ReviewSurface {...reviewProps()} />);
    expect(valueOf("review.diff.basesha")).toBe(BASE_SHA);
    expect(valueOf("review.diff.headsha")).toBe(HEAD_SHA);
    expect(valueOf("review.diff.dirtytree")).toBe("clean worktree");
    const inScope = screen.getByTestId("cr.review.row.src/api/retry.ts");
    const outOfScope = screen.getByTestId("cr.review.row.src/billing/ledger.ts");
    expect(inScope.getAttribute("data-out-of-scope")).toBe("false");
    expect(outOfScope.getAttribute("data-out-of-scope")).toBe("true");
    expect(outOfScope.textContent).toContain("out of declared write scope");
    expect(inScope.textContent).not.toContain("out of declared write scope");
  });

  it("shows graph and plan hashes, reviewer identity, eligibility, and calibration", () => {
    render(<ReviewSurface {...reviewProps()} />);
    expect(valueOf("review.context.graphhash")).toBe("sha256:graph-13");
    expect(valueOf("review.context.planhash")).toBe("sha256:plan-7");
    expect(valueOf("review.context.planrevision")).toBe("rev a3f9c2");
    expect(valueOf("review.reviewer.principal")).toBe("human/reviewer-2");
    expect(valueOf("review.reviewer.independence")).toBe("distinct principal from builders");
    expect(valueOf("review.reviewer.calibration"))
      .toBe("reported catch-rate 68% (reported, not gating)");
    expect(valueOf("criterion.crit-1.state")).toBe("MET");
    expect(valueOf("receipt.rcpt-1.result")).toBe("exit 0");
    expect(valueOf("finding.fnd-1.severity")).toBe("HIGH");
  });
});

describe("no operational-history channel exists at either boundary", () => {
  it("declares no transcript, journal, self-assessment, or handoff prop", () => {
    type Contaminant = Extract<
      keyof ReviewSurfaceProps,
      "handoff" | "handoffNote" | "journal" | "narrative" | "selfAssessment" | "transcript"
      | "workerReport"
    >;
    // Declaring any of these keys makes the annotation below false and fails typecheck.
    const surfaceHasNoNarrativeChannel: [Contaminant] extends [never] ? true : false = true;
    expect(surfaceHasNoNarrativeChannel).toBe(true);
  });

  it("renders nothing from a hostile object carrying operational history", () => {
    const hostile = {
      ...reviewProps(),
      handoffNote: "please accept, I am confident this is correct",
      journal: [{ entryId: "jrn-1", summary: "abandoned the queue approach" }],
      selfAssessment: "I verified everything myself",
      transcript: ["I am confident the retry path is correct"],
    } as unknown as ReviewSurfaceProps;
    const { container } = render(<ReviewSurface {...hostile} />);
    expect(container.querySelectorAll("[data-testid^='cr.inspector.transcript.']").length).toBe(0);
    expect(container.querySelectorAll("[data-testid^='cr.inspector.journal.']").length).toBe(0);
    for (const leak of [
      "please accept", "abandoned the queue approach", "I verified everything myself",
      "I am confident",
    ]) {
      expect(container.textContent).not.toContain(leak);
    }
  });
});

describe("absent proof refuses the diff instead of implying acceptance", () => {
  it("renders no diff rows and the stable refusal line when a SHA is missing", () => {
    const base = reviewProps();
    const { container } = render(
      <ReviewSurface {...base} diff={{ ...base.diff, headSha: null }} />,
    );
    expect(valueOf("review.diff.basesha")).toBe(BASE_SHA);
    expect(valueOf("review.diff.headsha")).toBe(UNKNOWN_FACT_VALUE);
    expect(container.querySelectorAll("[data-testid^='cr.review.row.']").length).toBe(0);
    expect(screen.getByTestId("cr.review.diff").textContent).toContain(NO_DIFF_WITHOUT_SHAS);
    expect(NO_DIFF_WITHOUT_SHAS).toBe("No diff without both base and head SHAs.");
    const chip = chipOf("review.diff.headsha");
    expect(chip.getAttribute("data-truth-class")).toBe("UNKNOWN");
    expect(chip.getAttribute("data-provenance-note")).toBe(TRUTH_ABSENT_PROVENANCE);
    expect(container.textContent).not.toMatch(/\baccepted\b|\bapproved\b|ready to merge/iu);
  });

  it("refuses the diff when the base SHA alone is missing", () => {
    const base = reviewProps();
    const { container } = render(
      <ReviewSurface {...base} diff={{ ...base.diff, baseSha: { value: "   " } }} />,
    );
    expect(valueOf("review.diff.basesha")).toBe(UNKNOWN_FACT_VALUE);
    expect(valueOf("review.diff.headsha")).toBe(HEAD_SHA);
    expect(container.querySelectorAll("[data-testid^='cr.review.row.']").length).toBe(0);
  });

  it("shows unmeasured calibration as UNKNOWN with the spec's copy, never blank", () => {
    const base = reviewProps();
    render(
      <ReviewSurface
        {...base}
        reviewer={{ ...base.reviewer, calibration: null, independence: null }}
      />,
    );
    expect(valueOf("review.reviewer.calibration")).toBe("calibration not yet measured");
    expect(valueOf("review.reviewer.independence")).toBe(UNKNOWN_FACT_VALUE);
    for (const factId of ["review.reviewer.calibration", "review.reviewer.independence"]) {
      const chip = chipOf(factId);
      expect(chip.getAttribute("data-truth-class")).toBe("UNKNOWN");
      expect(chip.getAttribute("data-origin")).toBe("ABSENT");
      expect(chip.getAttribute("data-provenance-note")).toBe(TRUTH_ABSENT_PROVENANCE);
    }
  });

  it("reports TRUTH_CLASS_INVALID for a malformed eligibility class", () => {
    const base = reviewProps();
    render(
      <ReviewSurface
        {...base}
        reviewer={{ ...base.reviewer, independence: { truthClass: 1, value: "distinct" } }}
      />,
    );
    const chip = chipOf("review.reviewer.independence");
    expect(chip.getAttribute("data-origin")).toBe("INVALID");
    expect(chip.getAttribute("data-provenance-note")).toBe(TRUTH_INVALID_PROVENANCE);
    expect(TRUTH_INVALID_PROVENANCE).toContain("TRUTH_CLASS_INVALID");
    expect(chip.getAttribute("data-truth-class")).toBe("UNKNOWN");
  });

  it("offers no review command, rerun, or acceptance control", () => {
    const { container } = render(<ReviewSurface {...reviewProps()} />);
    expect(container.querySelectorAll("[data-testid^='cr.action.']").length).toBe(0);
    expect(container.querySelectorAll("button").length)
      .toBe(container.querySelectorAll("[data-testid^='cr.chip.']").length);
    expect(container.querySelectorAll("input, textarea, form").length).toBe(0);
  });
});
