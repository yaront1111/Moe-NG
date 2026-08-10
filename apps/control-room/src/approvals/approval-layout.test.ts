import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

/**
 * SOURCE-TEXT PINS ONLY. Nothing here is a behavioural assertion.
 *
 * jsdom evaluates no CSS and Vitest stubs the stylesheet import, so
 * `document.styleSheets.length` is 0 and every layout box measures 0 wide. A
 * rendered assertion that the decision buttons "reached the bottom of the
 * viewport" at narrow width would be theatre — it would pass with the
 * stylesheet deleted. The sheet's SOURCE is read and pinned instead, exactly as
 * board/goals-board-ban.test.ts:134-156 does for the board.
 *
 * The pins below are ordered so they cannot pass vacuously: the file is proven
 * to be the real stylesheet, and non-trivial, BEFORE any `toContain` runs. A
 * missing or empty file fails at the first assertion rather than silently
 * satisfying every `not.toContain`.
 */
const APPROVALS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(APPROVALS_DIRECTORY, "approval-layout.css");
const CSS = readFileSync(CSS_PATH, "utf8");

it("reads the real stylesheet, so the layout pins below cannot pass vacuously", () => {
  expect(CSS_PATH.endsWith(join("src", "approvals", "approval-layout.css"))).toBe(true);
  expect(CSS.length).toBeGreaterThan(200);
  expect(CSS).toContain("[data-testid=\"cr.approvals.detail.actions\"]");
});

it("pins the decision-button rule to the marker the surface ALREADY renders", () => {
  // approval-detail-plan.tsx:146 has shipped `data-pinned="true"` since the
  // approval surfaces landed and nothing targeted it. The rule hangs off that
  // existing marker; introducing a second one would leave two sources of truth
  // for the same fact.
  expect(CSS).toContain("[data-pinned=\"true\"]");
  expect(CSS).toContain("@media (max-width: 959px)");
  expect(CSS).toContain("position: sticky");
});

it("presents the reason step as a full-viewport decision desk", () => {
  expect(CSS).toContain(".cr-approval-reason-backdrop");
  expect(CSS).toContain("position: fixed");
  expect(CSS).toContain("place-items: center");
  expect(CSS).toContain('[data-testid="cr.approvals.reasonmodal"]');
  expect(CSS).toContain("max-block-size: calc(100dvh - 2rem)");
});

it("carries its own reduced-motion block", () => {
  // board-layout.css:68 provides this today. The guarantee is per-stylesheet,
  // so a second sheet without one silently narrows it the moment it exists.
  expect(CSS).toContain("@media (prefers-reduced-motion: reduce)");
  expect(CSS).toContain("animation: none");
  expect(CSS).toContain("transition: none");
});

it("suppresses motion without forbidding the board's scroll-snap", () => {
  // scroll-snap-type and scroll-snap-align are section 4.16's own column
  // behaviour, not motion. A guard that banned them would fight the spec it is
  // meant to serve.
  expect(CSS).not.toContain("scroll-behavior: smooth");
  expect(CSS).not.toContain("@keyframes");
});

it("removes nothing at narrow width", () => {
  // Section 4.16 reflows; it never drops content. These are the four ways a
  // stylesheet takes something away.
  expect(CSS).not.toContain("display: none");
  expect(CSS).not.toContain("visibility: hidden");
  expect(CSS).not.toContain("overflow: hidden");
  expect(CSS).not.toContain("text-overflow: ellipsis");
});

it("is imported by the surface that renders the marker", () => {
  // A stylesheet nobody imports is dead source. Vite emits it only because the
  // module graph reaches it, so this pin is what makes the rule real.
  const surface = readFileSync(join(APPROVALS_DIRECTORY, "approval-detail-plan.tsx"), "utf8");
  expect(surface).toContain("import \"./approval-layout.css\";");
  expect(surface).toContain("data-pinned=\"true\"");
});
