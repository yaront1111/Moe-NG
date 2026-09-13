import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Gate1ApprovalPortV1, Gate1PendingViewV1 } from "./gate1-v1-approval.js";
import { Gate1CardV1 } from "./gate1-v1-card.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Six identifier families per roster, 25 statements each: 150 requirements and 150
 * criteria, 300 statements in all, each ~400 characters — the shape of the live PRD
 * contract (128 + 150, ~111 KB) that stalled the tab when every row mounted at once.
 */
const FAMILIES = ["AI", "CON", "DATA", "OPS", "SEC", "UX"] as const;
const PER_FAMILY = 25;
const FILLER = "the daemon records the decision and the board shows it ".repeat(7);

function statement(kind: string, family: string, index: number): string {
  return `${kind} ${family} ${String(index)}: ${FILLER}`;
}

function pendingWith(overrides: Partial<Gate1PendingViewV1> = {}): Gate1PendingViewV1 {
  const numbered = (index: number): string => String(index + 1).padStart(3, "0");
  return {
    approval: {
      affordance: { commandId: "gate1-cmd-1" },
      commandId: "gate1-cmd-1",
      requestDigest: "b".repeat(64),
    },
    clarifications: [],
    contractId: "contract-1",
    criteria: FAMILIES.flatMap((family) => Array.from({ length: PER_FAMILY }, (_, index) => ({
      criterionId: `CRT-${family}-${numbered(index)}`,
      statement: statement("Criterion", family, index + 1),
    }))),
    requirements: FAMILIES.flatMap((family) => Array.from({ length: PER_FAMILY }, (_, index) => ({
      requirementId: `REQ-${family}-${numbered(index)}`,
      statement: statement("Requirement", family, index + 1),
    }))),
    revisionDigest: "c".repeat(64),
    revisionId: "rev-1",
    status: "PENDING",
    ...overrides,
  };
}

function portWith(): Gate1ApprovalPortV1 {
  return {
    answer: vi.fn(async () => ({ commandId: "answer-cmd-1", ok: true as const })),
    submit: vi.fn(async () => ({ commandId: "gate1-cmd-1", ok: true as const })),
  };
}

function precedes(first: Element, second: Element): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)
    === Node.DOCUMENT_POSITION_FOLLOWING;
}

describe("the V1 Gate 1 card with a 300-statement contract", () => {
  it("offers the approve control with the totals before any roster, every family collapsed", async () => {
    const pending = pendingWith();
    render(<Gate1CardV1 goalId="goal-1" port={portWith()} read={async () => pending} />);

    const approve = await screen.findByTestId("cr.gate1.approve") as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    expect(screen.getByTestId("cr.gate1.totals").textContent)
      .toContain("150 requirements");
    expect(screen.getByTestId("cr.gate1.totals").textContent)
      .toContain("150 acceptance criteria");
    // The decision comes BEFORE the rosters in the document, not after them.
    expect(precedes(approve, screen.getByTestId("cr.gate1.requirements"))).toBe(true);
    expect(precedes(approve, screen.getByTestId("cr.gate1.criteria"))).toBe(true);
    expect(precedes(screen.getByTestId("cr.gate1.requirements"), screen.getByTestId("cr.gate1.inspect")))
      .toBe(true);

    // Six families per roster, each announced with its count and closed.
    const requirementFamilies = screen.getAllByTestId(/^cr\.gate1\.requirements\.group\./u);
    const criterionFamilies = screen.getAllByTestId(/^cr\.gate1\.criteria\.group\./u);
    expect(requirementFamilies).toHaveLength(FAMILIES.length);
    expect(criterionFamilies).toHaveLength(FAMILIES.length);
    for (const toggle of [...requirementFamilies, ...criterionFamilies]) {
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.textContent).toContain(String(PER_FAMILY));
    }
    expect(screen.getByTestId("cr.gate1.requirements.group.REQ-AI").textContent).toContain("REQ-AI");
    expect(screen.getByTestId("cr.gate1.criteria.group.CRT-UX").textContent).toContain("CRT-UX");
    expect(screen.getByTestId("cr.gate1.requirements").textContent).toContain("REQUIREMENTS");
    expect(screen.getByTestId("cr.gate1.criteria").textContent).toContain("ACCEPTANCE CRITERIA");
    expect(screen.getByTestId("cr.gate1.requirements.openall").textContent).toBe("Open all");
    expect(screen.getByTestId("cr.gate1.criteria.openall").textContent).toBe("Open all");

    // No statement row is in the tree until a family is opened: 0 of the 300.
    expect(screen.queryAllByTestId(/^cr\.gate1\.requirement\./u)).toHaveLength(0);
    expect(screen.queryAllByTestId(/^cr\.gate1\.criterion\./u)).toHaveLength(0);
    expect(screen.queryByText(statement("Requirement", "AI", 1))).toBeNull();
  });

  it("opens one family on click and shows only that family's statements", async () => {
    const user = userEvent.setup();
    const pending = pendingWith();
    render(<Gate1CardV1 goalId="goal-1" port={portWith()} read={async () => pending} />);
    const toggle = await screen.findByTestId("cr.gate1.criteria.group.CRT-CON");

    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const shown = screen.getAllByTestId(/^cr\.gate1\.criterion\./u);
    expect(shown).toHaveLength(PER_FAMILY);
    expect(shown.every((row) => row.getAttribute("data-testid")?.startsWith("cr.gate1.criterion.CRT-CON-")))
      .toBe(true);
    expect(screen.getByTestId("cr.gate1.criterion.CRT-CON-007").textContent)
      .toContain(statement("Criterion", "CON", 7));
    // The sibling roster and the other families stay closed.
    expect(screen.queryAllByTestId(/^cr\.gate1\.requirement\./u)).toHaveLength(0);
    expect(screen.getByTestId("cr.gate1.criteria.group.CRT-AI").getAttribute("aria-expanded"))
      .toBe("false");

    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByTestId(/^cr\.gate1\.criterion\./u)).toHaveLength(0);
  });

  it("keeps an open product question ahead of the rosters and withholds approval", async () => {
    const pending = pendingWith({
      approval: null,
      clarifications: [{
        answerAffordance: { commandId: "answer-cmd-1" },
        answered: false,
        clarificationId: "clar-1",
        optionDigests: [{ optionId: "option-a", projectionDigest: "d".repeat(64) }],
        options: [{ label: "Option A", optionId: "option-a" }],
        question: "Which sign-in provider?",
      }],
    });
    render(<Gate1CardV1 goalId="goal-1" port={portWith()} read={async () => pending} />);

    const answer = await screen.findByTestId("cr.gate1.answer.clar-1.option-a");
    expect(screen.queryByTestId("cr.gate1.approve")).toBeNull();
    expect(precedes(answer, screen.getByTestId("cr.gate1.requirements"))).toBe(true);
    expect(precedes(screen.getByTestId("cr.gate1.totals"), screen.getByTestId("cr.gate1.requirements")))
      .toBe(true);
    expect(screen.queryAllByTestId(/^cr\.gate1\.requirement\./u)).toHaveLength(0);
  });
});
