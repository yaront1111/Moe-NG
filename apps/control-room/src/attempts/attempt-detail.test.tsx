import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { TRUTH_ABSENT_PROVENANCE, TRUTH_INVALID_PROVENANCE } from "../kernel.js";
import { UNKNOWN_FACT_VALUE } from "../nodes/node-authority.js";
import type { PresentedFact } from "../nodes/node-authority.js";
import { AttemptDetail, TRANSCRIPT_DISCLOSURE_LABEL } from "./attempt-detail.js";
import type { AttemptDetailProps } from "./attempt-detail.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const verified = (value: string): PresentedFact => ({ truthClass: "DAEMON_VERIFIED", value });
const observed = (value: string): PresentedFact => ({ truthClass: "OBSERVED", value });
const reported = (value: string): PresentedFact => ({ truthClass: "AGENT_REPORTED", value });

const TRANSCRIPT_LINE = "I am confident the retry path is correct and should be accepted.";

function attemptProps(): AttemptDetailProps {
  return {
    attemptId: "att-2",
    currentBinding: {
      bindingVersion: observed("binding v5"),
      graphEpoch: observed("graph epoch 13"),
      leaseEpoch: observed("lease epoch 7"),
    },
    journal: [
      { entryId: "jrn-1", summary: reported("retry loop starved the connection pool") },
      { entryId: "jrn-2", summary: reported("abandoned the queue-based approach") },
    ],
    receipts: [
      { provenanceRef: "receipt/rcpt-1", receiptId: "rcpt-1", recipe: verified("pnpm test"), result: verified("exit 1") },
    ],
    recovery: {
      reason: observed("runner process terminal, effects proven absent"),
      state: observed("RESUMED_AS_NEW_ATTEMPT"),
    },
    source: {
      attemptNumber: observed("#2"),
      inputBindingHash: verified("sha256:inputbinding-1a"),
      outcome: observed("FAILED"),
      startedRevision: observed("rev 9 (started)"),
    },
    transcript: [TRANSCRIPT_LINE, "Next I will retry with a bounded pool."],
  };
}

const valueOf = (factId: string): string =>
  within(screen.getByTestId(`cr.fact.${factId}`)).getByTestId("cr.value").textContent ?? "";

const chipOf = (factId: string): HTMLElement =>
  within(screen.getByTestId(`cr.fact.${factId}`)).getByTestId(/^cr\.chip\./u);

const idsUnder = (container: HTMLElement, prefix: string): string[] =>
  [...container.querySelectorAll(`[data-testid^='${prefix}']`)]
    .map((node) => node.getAttribute("data-testid") ?? "");

describe("attempt detail separates immutable identity from current binding", () => {
  it("puts identity, binding, receipts, journal, and recovery in their own regions", () => {
    render(<AttemptDetail {...attemptProps()} />);
    for (const region of ["identity", "binding", "receipts", "journal", "recovery"]) {
      const element = screen.getByTestId(`cr.attemptdetail.section.${region}`);
      expect(element.tagName).toBe("SECTION");
      expect(within(element).getByRole("heading").textContent).not.toBe("");
    }
  });

  it("shows the attempt's own outcome and source binding, not a recomputed one", () => {
    render(<AttemptDetail {...attemptProps()} />);
    expect(valueOf("attempt.number")).toBe("#2");
    expect(valueOf("attempt.outcome")).toBe("FAILED");
    expect(valueOf("attempt.startedrevision")).toBe("rev 9 (started)");
    expect(valueOf("attempt.inputbindinghash")).toBe("sha256:inputbinding-1a");
    // Carry keeps the immutable source hash while a new binding supplies fencing, so
    // the two epochs must never be shown as one number.
    expect(valueOf("attempt.binding.graphepoch")).toBe("graph epoch 13");
    expect(valueOf("attempt.binding.leaseepoch")).toBe("lease epoch 7");
    expect(valueOf("attempt.binding.version")).toBe("binding v5");
  });

  it("renders exactly the journal entries the daemon bounded, in supplied order", () => {
    const { container } = render(<AttemptDetail {...attemptProps()} />);
    expect(idsUnder(container, "cr.inspector.journal."))
      .toEqual(["cr.inspector.journal.jrn-1", "cr.inspector.journal.jrn-2"]);
    expect(valueOf("journal.jrn-1.summary")).toBe("retry loop starved the connection pool");
    expect(idsUnder(container, "cr.inspector.receipt."))
      .toEqual(["cr.inspector.receipt.rcpt-1"]);
    expect(valueOf("receipt.rcpt-1.result")).toBe("exit 1");
    expect(valueOf("attempt.recovery.state")).toBe("RESUMED_AS_NEW_ATTEMPT");
  });
});

describe("the transcript is narrative, quarantined, and collapsed", () => {
  it("exists exactly once, only under the attempt-scoped transcript id", () => {
    const { container } = render(<AttemptDetail {...attemptProps()} />);
    expect(idsUnder(container, "cr.inspector.transcript."))
      .toEqual(["cr.inspector.transcript.att-2"]);
    const transcript = screen.getByTestId("cr.inspector.transcript.att-2");
    expect(transcript.tagName).toBe("DETAILS");
    for (const region of ["receipts", "journal", "recovery", "identity", "binding"]) {
      const element = screen.getByTestId(`cr.attemptdetail.section.${region}`);
      expect(element.contains(transcript)).toBe(false);
      expect(element.textContent).not.toContain(TRANSCRIPT_LINE);
    }
  });

  it("uses a native disclosure that is collapsed by default and carries the exact label", async () => {
    const user = userEvent.setup();
    render(<AttemptDetail {...attemptProps()} />);
    const transcript = screen.getByTestId("cr.inspector.transcript.att-2");
    const summary = within(transcript).getByText(TRANSCRIPT_DISCLOSURE_LABEL);
    expect(TRANSCRIPT_DISCLOSURE_LABEL).toBe("💬 AGENT_REPORTED — narrative, not evidence");
    expect(summary.tagName).toBe("SUMMARY");
    expect((transcript as HTMLDetailsElement).open).toBe(false);
    expect(transcript.hasAttribute("open")).toBe(false);
    // A native summary is keyboard operable by the platform; the surface must not
    // remove it from the tab order or hide it from assistive technology.
    expect(summary.getAttribute("tabindex")).toBeNull();
    expect(summary.getAttribute("aria-hidden")).toBeNull();
    await user.click(summary);
    expect((transcript as HTMLDetailsElement).open).toBe(true);
    expect(transcript.textContent).toContain(TRANSCRIPT_LINE);
  });

  it("renders no fact claim or evidence link inside the narrative", () => {
    render(<AttemptDetail {...attemptProps()} />);
    const transcript = screen.getByTestId("cr.inspector.transcript.att-2");
    expect(transcript.querySelectorAll("[data-testid^='cr.fact.']").length).toBe(0);
    expect(transcript.querySelectorAll("[data-testid^='cr.chip.']").length).toBe(0);
    expect(transcript.querySelectorAll("[data-testid^='cr.evidence.link.']").length).toBe(0);
    expect(transcript.querySelectorAll("[data-testid^='cr.action.']").length).toBe(0);
  });

  it("omits the disclosure entirely when no narrative was supplied", () => {
    const { container } = render(<AttemptDetail {...attemptProps()} transcript={[]} />);
    expect(container.querySelectorAll("[data-testid^='cr.inspector.transcript.']").length).toBe(0);
    expect(container.textContent).not.toContain(TRANSCRIPT_DISCLOSURE_LABEL);
  });
});

describe("missing operational proof stays UNKNOWN", () => {
  it("renders UNKNOWN with the missing-class note for absent outcome and receipts", () => {
    const base = attemptProps();
    render(
      <AttemptDetail
        {...base}
        receipts={[{ provenanceRef: null, receiptId: "rcpt-9", recipe: null, result: null }]}
        source={{ ...base.source, outcome: null }}
      />,
    );
    expect(valueOf("attempt.outcome")).toBe(UNKNOWN_FACT_VALUE);
    expect(valueOf("receipt.rcpt-9.result")).toBe(UNKNOWN_FACT_VALUE);
    for (const factId of ["attempt.outcome", "receipt.rcpt-9.result"]) {
      const chip = chipOf(factId);
      expect(chip.getAttribute("data-truth-class")).toBe("UNKNOWN");
      expect(chip.getAttribute("data-origin")).toBe("ABSENT");
      expect(chip.getAttribute("data-provenance-note")).toBe(TRUTH_ABSENT_PROVENANCE);
    }
    expect(screen.getByTestId("cr.attemptdetail.section.receipts").textContent)
      .not.toMatch(/pass|success|verified|exit 0/iu);
  });

  it("reports TRUTH_CLASS_INVALID rather than trusting a malformed class", () => {
    const base = attemptProps();
    render(
      <AttemptDetail
        {...base}
        currentBinding={{ ...base.currentBinding, leaseEpoch: { truthClass: "OBSERVED_", value: "9" } }}
      />,
    );
    const chip = chipOf("attempt.binding.leaseepoch");
    expect(chip.getAttribute("data-origin")).toBe("INVALID");
    expect(chip.getAttribute("data-provenance-note")).toBe(TRUTH_INVALID_PROVENANCE);
    expect(TRUTH_INVALID_PROVENANCE).toContain("TRUTH_CLASS_INVALID");
    expect(chip.getAttribute("data-truth-class")).toBe("UNKNOWN");
  });

  it("says none when the daemon supplied no journal entries", () => {
    const { container } = render(<AttemptDetail {...attemptProps()} journal={[]} />);
    expect(screen.getByTestId("cr.attemptdetail.section.journal").textContent).toContain("none");
    expect(container.querySelectorAll("[data-testid^='cr.inspector.journal.']").length).toBe(0);
  });
});
