import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * SOURCE-TEXT PINS ONLY. Vitest's DOM does not evaluate media queries, so a
 * rendered width assertion would stay green even if the responsive rules were
 * deleted. These checks prove both halves of the contract: the surface still
 * renders every daemon-supplied state/action, and narrow CSS only reflows it.
 */
const LIVE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(LIVE_DIRECTORY, "live-board.css");
const SURFACE_PATH = join(LIVE_DIRECTORY, "live-board.tsx");
const APP_PATH = join(LIVE_DIRECTORY, "live-app.tsx");
const CSS = readFileSync(CSS_PATH, "utf8");
const SURFACE = readFileSync(SURFACE_PATH, "utf8");
const NARROW_MARKER = "@media (max-width: 959px)";
const NARROW_CSS = CSS.includes(NARROW_MARKER)
  ? CSS.slice(CSS.indexOf(NARROW_MARKER))
  : "";

describe("live board narrow layout inventory", () => {
  it("reads the shipped stylesheet and surface before checking their inventory", () => {
    expect(CSS_PATH.endsWith(join("src", "live", "live-board.css"))).toBe(true);
    expect(SURFACE_PATH.endsWith(join("src", "live", "live-board.tsx"))).toBe(true);
    expect(CSS.length).toBeGreaterThan(1_500);
    expect(SURFACE.length).toBeGreaterThan(4_000);
    expect(CSS).toContain(".cr-liveboard-columns");
    expect(SURFACE).toContain('data-testid="cr.liveboard.columns"');
  });

  it("keeps every column, step, action, and supplied truth marker in the surface", () => {
    const columns = [...SURFACE.matchAll(/key: "(READY|BLOCKED|COMMITTED)"/gu)]
      .map((match) => match[1]);
    expect(columns).toEqual(["READY", "BLOCKED", "COMMITTED"]);
    for (const marker of [
      "frame.steps.filter((step) => step.status === column.key).map((step) => {",
      "data-status={step.status}",
      "data-testid={`cr.liveboard.card.${key}`}",
      "data-testid={`cr.liveboard.missing.${step.kind}`}",
      "data-testid={`cr.liveboard.dispatch.${step.kind}`}",
      "data-testid={`cr.liveboard.report.${key}`}",
    ]) expect(SURFACE).toContain(marker);
  });

  it("stacks narrow columns without clipping cards or their contents", () => {
    expect(NARROW_CSS.length).toBeGreaterThan(0);
    expect(NARROW_CSS).toMatch(
      /\.cr-liveboard-columns\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/su,
    );
    expect(NARROW_CSS).toMatch(
      /\.cr-liveboard-column\s*\{[^}]*min-block-size:\s*0;/su,
    );
    expect(NARROW_CSS).toMatch(
      /\.cr-liveboard-card\s*\{[^}]*min-inline-size:\s*0;/su,
    );
    expect(NARROW_CSS).toContain("overflow-wrap: anywhere");
    expect(NARROW_CSS).not.toMatch(
      /display\s*:\s*none|visibility\s*:\s*hidden|overflow\s*:\s*hidden|text-overflow\s*:\s*ellipsis/u,
    );
  });

  it("loads the stylesheet from the live composition that renders the board", () => {
    const app = readFileSync(APP_PATH, "utf8");
    expect(app).toContain('import "./live-board.css";');
    expect(app).toContain("<LiveBoard");
  });
});
