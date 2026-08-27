import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { TruthChip } from "./truth-chip.js";

/**
 * goalshome-09 / shell-11 / truth-07: the chip is the one place a non-engineer
 * meets a truth class, and it used to introduce itself as
 * "Ready. DAEMON_VERIFIED Daemon verified press Enter for provenance." - a raw
 * daemon token plus a keyboard instruction the screen reader already gives. The
 * class code belongs behind Inspect/Proof; the chip says what it means in words.
 * The legend variant is a plain span, so its label needs a role to be announced
 * at all, and a harness needs to tell a legend entry from a clickable claim.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

function readStyles(name: string): string {
  return readFileSync(resolve(process.cwd(), "src/v2/styles", name), "utf8");
}

describe("goalshome-09: a truth chip says what it means, not its code", () => {
  it("names the class in words and keeps the raw code as data", () => {
    render(<TruthChip contextLabel="Ready" truthClass="DAEMON_VERIFIED" />);
    const chip = screen.getByTestId("cr.chip.daemon_verified");
    expect(chip.getAttribute("aria-label")).toBe("Ready: Daemon verified");
    expect(chip.getAttribute("aria-label")).not.toContain("DAEMON_VERIFIED");
    expect(chip.getAttribute("aria-label")).not.toContain("press Enter");
    // Inspect/Proof still reads the code: it stays on the element as data.
    expect(chip.getAttribute("data-truth-class")).toBe("DAEMON_VERIFIED");
  });

  it("speaks the provenance of an absent class without the diagnostic code", () => {
    render(<TruthChip contextLabel="Budget" />);
    const chip = screen.getByTestId("cr.chip.unknown");
    expect(chip.getAttribute("aria-label")).toContain("Budget: Unknown");
    expect(chip.getAttribute("aria-label")).toContain("class missing from payload");
  });

  it("strips the CODE prefix a malformed class carries into the spoken name", () => {
    render(<TruthChip contextLabel="Budget" truthClass="daemon_verified" />);
    const chip = screen.getByTestId("cr.chip.unknown");
    const label = chip.getAttribute("aria-label") ?? "";
    expect(label).toContain("class present but not a daemon-supplied supported value");
    expect(label).not.toContain("TRUTH_CLASS_INVALID");
  });

  it("explains the click through the tooltip instead of the accessible name", () => {
    render(<TruthChip contextLabel="Ready" truthClass="OBSERVED" />);
    const chip = screen.getByTestId("cr.chip.observed");
    expect(chip.getAttribute("title")).toContain("Observed by the daemon");
    expect(chip.getAttribute("title")).toContain("proof");
  });
});

describe("shell-11 / truth-07: legend chips announce themselves and are distinguishable", () => {
  it("gives the non-interactive legend chip a role so its label is announced", () => {
    render(<TruthChip compact interactive={false} truthClass="OBSERVED" />);
    const chip = screen.getByTestId("cr.chip.observed");
    expect(chip.tagName).toBe("SPAN");
    expect(chip.getAttribute("role")).toBe("img");
    expect(chip.getAttribute("aria-label")).toBe("Observed by the daemon");
  });

  it("marks which chips are clickable, so a selector cannot land on a legend entry", () => {
    const { unmount } = render(<TruthChip interactive={false} truthClass="OBSERVED" />);
    expect(screen.getByTestId("cr.chip.observed").getAttribute("data-interactive")).toBe("false");
    unmount();

    render(<TruthChip contextLabel="Ready" truthClass="OBSERVED" />);
    expect(screen.getByTestId("cr.chip.observed").getAttribute("data-interactive")).toBe("true");
  });

  it("gives the chip a focus ring that is not the fill it lands on", () => {
    // jsdom applies no stylesheet, so the paint rule is asserted as text against
    // the component-scoped sheet the chip imports.
    const css = readStyles("cordum-truth-chip.css");
    const rule = /\.cr2-chip:focus-visible\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/outline:\s*2px solid var\(--cr-ink\)/);
    expect(rule).toMatch(/box-shadow/);
    // The old ring was the same teal as the accent fills it lands on.
    expect(rule).not.toContain("--cr-accent");
  });
});
