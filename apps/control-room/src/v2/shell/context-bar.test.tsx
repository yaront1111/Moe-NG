import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ContextBar } from "./context-bar.js";

/**
 * shell-02 / truth-10: the CARDS Compact / Instrument / Ledger group is a
 * pressed-button switch that no surface reads - nothing in the app matches
 * `[data-treatment`, so pressing Ledger changes no pixel. Until a board slice
 * consumes the choice it must read like every other unbacked affordance in this
 * product (the nav rail's SOON chip), not like a live control.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const TREATMENT_IDS = ["compact", "instrument", "ledger"] as const;

function renderBar(spies: { onTreatment: () => void; onToggleProof: () => void }): void {
  render(
    <ContextBar
      eyebrow="PROJECT"
      onToggleProof={spies.onToggleProof}
      onTreatment={spies.onTreatment}
      proofOpen={false}
      title="Goals"
      treatment="Compact"
    />,
  );
}

function readShellStyles(name: string): string {
  return readFileSync(resolve(process.cwd(), "src/v2/styles", name), "utf8");
}

describe("shell-02: the CARDS treatment group does not pose as a live control", () => {
  it("freezes every treatment pill and says why in words", () => {
    renderBar({ onTreatment: vi.fn(), onToggleProof: vi.fn() });
    for (const id of TREATMENT_IDS) {
      const pill = screen.getByTestId(`cr.shell.treatment.${id}`) as HTMLButtonElement;
      expect(pill.disabled, id).toBe(true);
      expect(pill.getAttribute("aria-disabled"), id).toBe("true");
      expect(pill.getAttribute("aria-label"), id).toContain("not available yet");
    }
  });

  it("carries the product's SOON marker beside the CARDS label", () => {
    renderBar({ onTreatment: vi.fn(), onToggleProof: vi.fn() });
    expect(screen.getByTestId("cr.shell.treatment.unavailable").textContent).toBe("SOON");
  });

  it("keeps the pinned pressed state while refusing the press", async () => {
    const user = userEvent.setup();
    const onTreatment = vi.fn();
    renderBar({ onTreatment, onToggleProof: vi.fn() });

    await user.click(screen.getByTestId("cr.shell.treatment.ledger"));
    expect(onTreatment).not.toHaveBeenCalled();
    expect(screen.getByTestId("cr.shell.treatment.compact").getAttribute("aria-pressed")).toBe("true");
  });

  it("leaves the Proof toggle live (the freeze is scoped to the dead group)", async () => {
    const user = userEvent.setup();
    const onToggleProof = vi.fn();
    renderBar({ onTreatment: vi.fn(), onToggleProof });

    await user.click(screen.getByTestId("cr.shell.proof.toggle"));
    expect(onToggleProof).toHaveBeenCalledTimes(1);
  });

  it("paints the frozen pills as frozen and drops the group off narrow screens", () => {
    // jsdom evaluates no media queries and applies no stylesheet, so the paint
    // rules are asserted as text against the component-scoped sheet the bar imports.
    const css = readShellStyles("cordum-context-bar.css");
    expect(css).toMatch(/\.cr2-pill:disabled\s*\{[^}]*cursor:\s*not-allowed/);
    // The frozen current choice must not wear the live accent fill.
    expect(css).toMatch(/\.cr2-pill\[data-active="true"\]:disabled\s*\{/);
    expect(css).toMatch(/@media \(max-width: 980px\)\s*\{[\s\S]*?\.cr2-treatment[^{]*\{[^}]*display:\s*none/);
  });
});
