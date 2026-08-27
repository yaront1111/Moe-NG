import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
 * selector reached a v2 node and won. The v1 sheets are read off disk at run
 * time, so the day one of them grows another `[data-testid="cr...."]` rule this
 * fails closed instead of the owner finding it in a screenshot - and every leak
 * is reported with the sheet and selector it came from and the one move that
 * closes it, so a peer's rule never surfaces as an anonymous array diff.
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
 *
 * NAMED, NOT HARVESTED. V1_SHEETS lists the v1 sheets that carry testid rules:
 * the control-room.css import chain plus shell/shell-layout.css. Sweeping the
 * whole styles/ directory instead would fence any sheet a peer drops there and
 * red this suite from a lane that never touched it. A new v1 sheet joins the
 * fence by being added here, on purpose, by whoever fences it.
 */

const APP_ROOT = process.cwd();
const V1_SHEETS = [
  "src/styles/shell.css",
  "src/styles/chrome.css",
  "src/styles/inspector.css",
  "src/styles/surfaces.css",
  "src/styles/workspace.css",
  "src/styles/preview-board.css",
  "src/styles/responsive.css",
  "src/shell/shell-layout.css",
] as const;
const V2_SHEETS = [
  resolve(APP_ROOT, "src/v2/styles/cordum-tokens.css"),
  resolve(APP_ROOT, "src/v2/styles/cordum-shell.css"),
];
const TESTID_SELECTOR = '[data-testid="cr.';

interface Rule { readonly sheet: string; readonly selector: string; readonly body: string }

/** Top-level rules only; at-rule blocks (@media, @keyframes, @supports) are skipped. */
function topLevelRules(sheet: string, css: string): readonly Rule[] {
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
    if (!selector.startsWith("@")) rules.push({ sheet, selector, body: source.slice(open + 1, close) });
    cursor = close + 1;
  }
  return rules;
}

function v1TestidRules(): readonly Rule[] {
  return V1_SHEETS.flatMap((sheet) =>
    topLevelRules(sheet, readFileSync(resolve(APP_ROOT, sheet), "utf8"))
      .filter((rule) => rule.selector.includes(TESTID_SELECTOR)));
}

const V1_RULES = v1TestidRules();
const V2_CSS = V2_SHEETS.map((path) => readFileSync(path, "utf8")).join("\n");

const sheetText = (rules: readonly Rule[]): string =>
  rules.map((rule) => `${rule.selector}{${rule.body}}`).join("\n");

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

function snapshot(nodes: readonly Element[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const [index, node] of nodes.entries()) {
    const computed = window.getComputedStyle(node);
    const name = node.getAttribute("data-testid") ?? node.className;
    for (let slot = 0; slot < computed.length; slot += 1) {
      const property = computed.item(slot);
      values.set(`${index}|${String(name)}|${property}`, computed.getPropertyValue(property));
    }
  }
  return values;
}

/** Whether `rule` sets `property`, directly or through the shorthand it belongs to. */
function declares(rule: Rule, property: string): boolean {
  return rule.body.split(";").some((declaration) => {
    const colon = declaration.indexOf(":");
    if (colon <= 0) return false;
    const declared = declaration.slice(0, colon).trim();
    return declared === property || property.startsWith(`${declared}-`);
  });
}

function matches(node: Element, selector: string): boolean {
  try {
    return node.matches(selector);
  } catch {
    return false;
  }
}

/** The v1 rule that reached `node` with `property` - on it, or on an ancestor it inherits from. */
function culprit(node: Element, property: string, rules: readonly Rule[]): Rule | undefined {
  for (let at: Element | null = node; at !== null; at = at.parentElement) {
    const hit = rules.find((rule) => declares(rule, property) && matches(at as Element, rule.selector));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Every computed value that moves when `rules` join the document, each named by its source. */
function leaksAgainst(root: HTMLElement, rules: readonly Rule[], v1First: boolean): readonly string[] {
  const nodes: readonly Element[] = [root, ...root.querySelectorAll("*")];
  const v1 = sheetText(rules);
  loadSheets(V2_CSS);
  const alone = snapshot(nodes);
  loadSheets(...(v1First ? [v1, V2_CSS] : [V2_CSS, v1]));
  const together = snapshot(nodes);
  const found: string[] = [];
  // The UNION of both key sets: a property v2 never declares is absent from the
  // first snapshot, and those silent additions (the rail's colour, the strip's
  // text-transform) are exactly what made the wordmark disappear.
  for (const key of new Set([...alone.keys(), ...together.keys()])) {
    const before = alone.get(key) ?? "";
    const after = together.get(key) ?? "";
    if (after === before) continue;
    const index = Number(key.slice(0, key.indexOf("|")));
    const property = key.slice(key.lastIndexOf("|") + 1);
    const hit = culprit(nodes[index] ?? root, property, rules);
    const from = hit === undefined ? "an unattributed rule in V1_SHEETS" : `${hit.sheet} ${hit.selector}`;
    found.push(`${key}: v2 "${before}" -> v1 "${after}" - ${from} reached it; `
      + `state ${property} under .cr2-shell in cordum-shell.css`);
  }
  return found;
}

const leaks = (root: HTMLElement, v1First: boolean): readonly string[] => leaksAgainst(root, V1_RULES, v1First);

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
  it("reads a real v1 rule set off the named sheets, so an empty sweep cannot pass quietly", () => {
    const rules = v1TestidRules();
    expect(rules.length).toBeGreaterThan(8);
    for (const testid of ["navrail", "main", "statusstrip", "help", "inspector", "context.title"]) {
      expect(rules.some((rule) => rule.selector.includes(`cr.shell.${testid}"`)), testid).toBe(true);
    }
    for (const rule of rules) expect(V1_SHEETS).toContain(rule.sheet);
  });

  it("renders every fenced surface, so the sweep below has something to measure", () => {
    const root = shell();
    for (const testid of ["cr.shell.navrail", "cr.shell.contextbar", "cr.shell.context.title",
      "cr.shell.main", "cr.shell.inspector", "cr.shell.statusstrip"]) {
      expect(root.querySelector(`[data-testid="${testid}"]`), testid).toBeTruthy();
    }
  });

  it("can see a leak, and names the sheet and selector it came from", () => {
    // A control for the sweep itself: one planted rule on a property v2 never
    // states, from a sheet that does not exist. The report has to say which node
    // moved, which property, where the rule lives, and what closes it - so a
    // peer's rule is never an anonymous `expected [ Array(n) ] to equal []`.
    const probe: Rule = {
      sheet: "src/styles/probe.css",
      selector: '[data-testid="cr.shell.main"]',
      body: "text-indent: 7px;",
    };
    const found = leaksAgainst(shell(), [probe], true);
    expect(found).toHaveLength(1);
    const [report = ""] = found;
    for (const named of ["cr.shell.main", "text-indent", probe.sheet, probe.selector, "cordum-shell.css"]) {
      expect(report, named).toContain(named);
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
    loadSheets(sheetText(V1_RULES), V2_CSS);
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
