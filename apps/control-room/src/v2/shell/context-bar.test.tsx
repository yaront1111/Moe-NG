import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ContextBar } from "./context-bar.js";

/**
 * The context bar carries the eyebrow, the title, an optional back link and the Proof
 * toggle - and nothing that poses as a control without doing anything. The CARDS
 * treatment switch (Compact / Instrument / Ledger) that no surface ever read was removed
 * rather than frozen: a dead control on every screen costs a person a guess each visit.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

describe("ContextBar", () => {
  it("renders the eyebrow, the title and a live Proof toggle, and no card-treatment switch", async () => {
    const user = userEvent.setup();
    const onToggleProof = vi.fn();
    render(<ContextBar eyebrow="PROJECT" onToggleProof={onToggleProof} proofOpen={false} title="Goals" />);
    expect(screen.getByTestId("cr.shell.context.eyebrow").textContent).toBe("PROJECT");
    expect(screen.getByTestId("cr.shell.context.title").textContent).toBe("Goals");
    expect(screen.queryByTestId("cr.shell.treatment.compact")).toBeNull();
    expect(screen.queryByTestId("cr.shell.treatment.unavailable")).toBeNull();
    expect(screen.getByTestId("cr.shell.contextbar").textContent).not.toContain("SOON");
    await user.click(screen.getByTestId("cr.shell.proof.toggle"));
    expect(onToggleProof).toHaveBeenCalledTimes(1);
  });

  it("renders the back link only when a handler is given", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(<ContextBar backLabel="GOALS" eyebrow="goal-1" onBack={onBack} onToggleProof={vi.fn()} proofOpen title="Alpha" />);
    await user.click(screen.getByRole("button", { name: /GOALS/u }));
    expect(onBack).toHaveBeenCalledTimes(1);
    cleanup();
    render(<ContextBar eyebrow="PROJECT" onToggleProof={vi.fn()} proofOpen={false} title="Goals" />);
    expect(screen.queryByRole("button", { name: /GOALS/u })).toBeNull();
  });
});
