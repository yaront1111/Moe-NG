import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { CordumShell } from "../shell/cordum-shell.js";

/**
 * The v2 shell's own paint, measured through the cascade jsdom does run.
 *
 * These six expectations came out of the v1 -> v2 stylesheet firewall (retired with the v1
 * stylesheets): they were the concrete symptoms the fence was built to keep closed — the "Moe"
 * wordmark painted in a rail ink invisible on the rail, a striped canvas behind the main area,
 * a 9px uppercase status strip. No v1 sheet shares the bundle any more, so they now pin the v2
 * sheets on their own.
 *
 * jsdom performs no layout but DOES run the cascade with specificity and source order, and a
 * `var(...)` survives as a literal, which is all that is needed to say what each sheet set.
 * Vitest stubs CSS imports, so the sheets are read off disk and installed as `<style>` nodes.
 */

const APP_ROOT = process.cwd();
const V2_SHEETS = [
  resolve(APP_ROOT, "src/v2/styles/cordum-tokens.css"),
  resolve(APP_ROOT, "src/v2/styles/cordum-shell.css"),
];
const V2_CSS = V2_SHEETS.map((path) => readFileSync(path, "utf8")).join("\n");

function loadSheets(...sheets: readonly string[]): void {
  for (const style of [...document.head.querySelectorAll("style[data-paint]")]) style.remove();
  for (const css of sheets) {
    const style = document.createElement("style");
    style.setAttribute("data-paint", "");
    style.textContent = css;
    document.head.append(style);
  }
}

/** The rail, bar, title, main + its children, drawer and strip in one tree. */
function shell(): HTMLElement {
  const { container } = render(
    <CordumShell initialProofOpen title="Goals">
      <p className="cr2-slot-body">A main-slot child, so descendant rules are in scope.</p>
    </CordumShell>,
  );
  return container.firstElementChild as HTMLElement;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  cleanup();
  loadSheets();
});

describe("the v2 shell paints from its own tokens", () => {
  it("reads a real v2 rule set off disk, so an empty sheet cannot pass quietly", () => {
    expect(V2_CSS).toContain(".cr2-shell");
    expect(V2_CSS).toContain("--cr-ink");
  });

  it("renders every measured surface, so the arm below has something to measure", () => {
    const root = shell();
    for (const testid of ["cr.shell.navrail", "cr.shell.contextbar", "cr.shell.context.title",
      "cr.shell.main", "cr.shell.inspector", "cr.shell.statusstrip"]) {
      expect(root.querySelector(`[data-testid="${testid}"]`), testid).toBeTruthy();
    }
  });

  it("paints the rail, wordmark, canvas and strip from v2 tokens", () => {
    const root = shell();
    loadSheets(V2_CSS);
    const styleOf = (testid: string): CSSStyleDeclaration =>
      window.getComputedStyle(root.querySelector(`[data-testid="${testid}"]`) as HTMLElement);
    expect(styleOf("cr.shell.navrail").color).toBe("var(--cr-ink)");
    expect(styleOf("cr.shell.navrail").alignItems).toBe("stretch");
    expect(window.getComputedStyle(root.querySelector(".cr2-brand-name") as HTMLElement).color)
      .toBe("var(--cr-ink)");
    expect(styleOf("cr.shell.main").backgroundImage).toBe("none");
    expect(styleOf("cr.shell.statusstrip").textTransform).toBe("none");
    expect(styleOf("cr.shell.context.title").whiteSpace).toBe("normal");
  });
});
