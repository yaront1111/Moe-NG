import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { cleanup, render } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { CordumShell } from "../shell/cordum-shell.js";

/**
 * The v1 -> v2 stylesheet firewall, measured rather than asserted in prose.
 *
 * WHY IT EXISTS. main.tsx statically imports the v1 shell mode, which pulls
 * styles/control-room.css -> shell.css / chrome.css / workspace.css /
 * inspector.css (and shell/shell-layout.css) into the SAME bundle asset the v2
 * Cordum shell is served from. v2 deliberately keeps the v1 `data-testid`
 * contract (cr.shell.navrail, .contextbar, .context.title, .main, .statusstrip,
 * .inspector, .help) so the shared tests keep passing - so every v1 rule written
 * against one of those testids also matches a LIVE v2 node. That is how the "Moe"
 * wordmark ended up painted in v1's dark-rail ink on the cream rail (~1.1:1,
 * invisible in every screenshot), how the main area got v1's grey striped canvas,
 * and how the status strip became 9px uppercase.
 *
 * HOW IT MEASURES. jsdom performs no layout but it DOES run the cascade with
 * specificity and source order (verified against this build). `var(...)` survives
 * as a literal, which is all that is needed to say WHICH sheet won. So: render the
 * real shell, snapshot every computed property of every node with the v2 sheets
 * alone, re-mount with the v1 testid rules loaded as well, and snapshot again.
 * The fence holds iff the two snapshots are identical - if any value moves, a v1
 * selector reached a v2 node and won. The v1 rule set is harvested off disk, so
 * the day v1 grows another `[data-testid="cr...."]` rule this fails closed instead
 * of the owner finding it in a screenshot.
 *
 * BOTH ORDERS. The shipped bundle emits v1 first, so a specificity TIE currently
 * resolves to v2 - by accident of main.tsx's import order. The second sweep loads
 * v1 LAST, which passes only if v2 wins on specificity alone. That is why the six
 * shared-testid elements are authored `.cr2-shell`-deep in cordum-shell.css.
 *
 * SCOPE. Only v1 rules that select by testid are installed: those are the ones
 * that collide BECAUSE v2 kept the contract. Element-level ground (base.css
 * `button`, `input`, `*`) is shared by both trees, not a v1/v2 collision. @media
 * blocks are skipped - jsdom applies none of them, so installing them would
 * measure nothing; the narrow viewport is covered by cordum-shell-responsive.
 * The fence must live in cordum-shell.css alone: sibling sheets (cordum-proof.css,
 * cordum-status-strip.css ...) are corrections layered on top, not the fence.
 */

const APP_ROOT = process.cwd();
const V1_STYLE_DIR = resolve(APP_ROOT, "src/styles");
const V1_EXTRA_SHEETS = [resolve(APP_ROOT, "src/shell/shell-layout.css")];
const V2_SHEETS = [
  resolve(APP_ROOT, "src/v2/styles/cordum-tokens.css"),
  resolve(APP_ROOT, "src/v2/styles/cordum-shell.css"),
];
const TESTID_SELECTOR = '[data-testid="cr.';

interface Rule { readonly selector: string; readonly body: string }

/** Top-level rules only; at-rule blocks (@media, @keyframes, @supports) are skipped. */
function topLevelRules(css: string): readonly Rule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const rules: Rule[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf("{", cursor);
    if (open < 0) break;
    let depth = 0;
    let close = open;
    for (; close < source.length; close += 1) {
      if (source[close] === "{") depth += 1;
      else if (source[close] === "}" && (depth -= 1) === 0) break;
    }
    const selector = source.slice(cursor, open).trim();
    if (!selector.startsWith("@")) rules.push({ selector, body: source.slice(open + 1, close) });
    cursor = close + 1;
  }
  return rules;
}

function v1TestidRules(): readonly Rule[] {
  const sheets = readdirSync(V1_STYLE_DIR)
    .filter((name) => name.endsWith(".css"))
    .map((name) => join(V1_STYLE_DIR, name));
  return [...sheets, ...V1_EXTRA_SHEETS].flatMap((path) =>
    topLevelRules(readFileSync(path, "utf8")).filter((rule) => rule.selector.includes(TESTID_SELECTOR)));
}

const V1_CSS = v1TestidRules().map((rule) => `${rule.selector}{${rule.body}}`).join("\n");
const V2_CSS = V2_SHEETS.map((path) => readFileSync(path, "utf8")).join("\n");

/** jsdom registers a sheet when its node is inserted, so order is rebuilt from scratch. */
function loadSheets(...sheets: readonly string[]): void {
  for (const style of [...document.head.querySelectorAll("style[data-fence]")]) style.remove();
  for (const css of sheets) {
    const style = document.createElement("style");
    style.setAttribute("data-fence", "");
    style.textContent = css;
    document.head.append(style);
  }
}

function snapshot(root: HTMLElement): Map<string, string> {
  const values = new Map<string, string>();
  for (const [index, node] of [root, ...root.querySelectorAll("*")].entries()) {
    const computed = window.getComputedStyle(node);
    const name = node.getAttribute("data-testid") ?? node.className;
    for (let slot = 0; slot < computed.length; slot += 1) {
      const property = computed.item(slot);
      values.set(`${index}|${String(name)}|${property}`, computed.getPropertyValue(property));
    }
  }
  return values;
}

/** Every computed value that moves when the v1 rules join the document. */
function leaks(root: HTMLElement, v1First: boolean): readonly string[] {
  loadSheets(V2_CSS);
  const alone = snapshot(root);
  loadSheets(...(v1First ? [V1_CSS, V2_CSS] : [V2_CSS, V1_CSS]));
  const together = snapshot(root);
  const found: string[] = [];
  // The UNION of both key sets: a property v2 never declares is absent from the
  // first snapshot, and those silent additions (the rail's colour, the strip's
  // text-transform) are exactly what made the wordmark disappear.
  for (const key of new Set([...alone.keys(), ...together.keys()])) {
    const before = alone.get(key) ?? "";
    const after = together.get(key) ?? "";
    if (after !== before) found.push(`${key}: v2 "${before}" -> v1 "${after}"`);
  }
  return found;
}

/** The rail, bar, title, main + its children, drawer and strip in one tree. */
function shell(): HTMLElement {
  const { container } = render(
    <CordumShell initialProofOpen title="Goals">
      <p className="cr2-slot-body">A main-slot child, so v1 child rules are in scope.</p>
    </CordumShell>,
  );
  return container.firstElementChild as HTMLElement;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(cleanup);

describe("the v2 shell is fenced off from the v1 stylesheets in the same bundle", () => {
  it("harvests a real v1 rule set, so an empty sweep cannot pass quietly", () => {
    const rules = v1TestidRules();
    expect(rules.length).toBeGreaterThan(8);
    for (const testid of ["navrail", "main", "statusstrip", "help", "inspector", "context.title"]) {
      expect(rules.some((rule) => rule.selector.includes(`cr.shell.${testid}"`)), testid).toBe(true);
    }
  });

  it("renders every fenced surface, so the sweep below has something to measure", () => {
    const root = shell();
    for (const testid of ["cr.shell.navrail", "cr.shell.contextbar", "cr.shell.context.title",
      "cr.shell.main", "cr.shell.inspector", "cr.shell.statusstrip"]) {
      expect(root.querySelector(`[data-testid="${testid}"]`), testid).toBeTruthy();
    }
  });

  it("keeps every rendered v2 node identical when the v1 rules load first, as shipped", () => {
    expect(leaks(shell(), true)).toEqual([]);
  });

  it("keeps them identical when v1 loads LAST, so the fence rests on specificity", () => {
    expect(leaks(shell(), false)).toEqual([]);
  });

  it("fences the keyboard help overlay, which v1 sizes into a corner card", async () => {
    const user = userEvent.setup();
    const root = shell();
    await user.keyboard("?");
    expect(root.querySelector('[data-testid="cr.shell.help"]')).toBeTruthy();
    expect(leaks(root, true)).toEqual([]);
  });

  it("paints the rail, wordmark, canvas and strip from v2 tokens under the v1 load", () => {
    const root = shell();
    loadSheets(V1_CSS, V2_CSS);
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
