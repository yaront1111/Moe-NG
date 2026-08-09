import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const DIRECTORY = resolve(process.cwd(), "src/styles");
const STYLE_FILES = [
  "tokens.css", "base.css", "shell.css", "chrome.css", "inspector.css", "surfaces.css",
  "workspace.css", "document-dossier.css", "document-dossier-disclosure.css",
  "preview-board.css", "responsive.css",
] as const;

function read(name: string): string {
  return readFileSync(join(DIRECTORY, name), "utf8");
}

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return 0.2126 * channel(channels[0] ?? 0)
    + 0.7152 * channel(channels[1] ?? 0)
    + 0.0722 * channel(channels[2] ?? 0);
}

function contrast(left: string, right: string): number {
  const [bright, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return ((bright ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe("Quiet Orchestration Ledger design system", () => {
  it("imports every focused stylesheet from one deterministic local entry", () => {
    const entry = read("control-room.css");
    for (const file of STYLE_FILES) expect(entry).toContain(`@import "./${file}";`);
    expect(entry).not.toMatch(/https?:\/\//u);
    const preview = readFileSync(resolve(process.cwd(), "src/preview/control-room-preview.tsx"),
      "utf8");
    expect(preview).toContain('import "../styles/control-room.css";');
  });

  it("pins the subject-specific palette and all five truth tones", () => {
    const tokens = read("tokens.css");
    const expected = [
      ["--cr-rail", "#141c2b"], ["--cr-canvas", "#eef1f3"],
      ["--cr-surface", "#fbfcfd"], ["--cr-ink", "#1d2633"],
      ["--cr-action", "#4b66d2"], ["--cr-attention", "#c8783c"],
      ["--cr-link", "#324aa9"], ["--cr-attention-text", "#93491e"],
      ["--cr-truth-observed", "#5e6d74"], ["--cr-truth-agent", "#9a621b"],
      ["--cr-truth-verified", "#176f5b"], ["--cr-truth-human", "#3c65d4"],
      ["--cr-truth-unknown", "#b33b8f"],
    ] as const;
    for (const [token, value] of expected) expect(tokens).toContain(`${token}: ${value};`);
    expect(tokens).toContain("--cr-link: #9bafff;");
    expect(tokens).toContain("--cr-attention-text: #e5a06d;");
  });

  it("keeps primary text and every filled truth chip at WCAG AA contrast", () => {
    expect(contrast("#1d2633", "#eef1f3")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#1d2633", "#fbfcfd")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#e8edf6", "#141c2b")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#93491e", "#eef1f3")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#e5a06d", "#111820")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#324aa9", "#fbfcfd")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#9bafff", "#18212b")).toBeGreaterThanOrEqual(4.5);
    for (const tone of ["#5e6d74", "#9a621b", "#176f5b", "#3c65d4", "#b33b8f"])
      expect(contrast("#ffffff", tone)).toBeGreaterThanOrEqual(4.5);
  });

  it("visually consumes every supplied truth tone and keeps UNKNOWN dashed", () => {
    const surfaces = read("surfaces.css");
    for (const tone of [
      "neutral slate", "amber", "green", "blue", "high-contrast magenta",
    ]) expect(surfaces).toContain(`[data-tone="${tone}"]`);
    expect(surfaces).toContain('[data-truth-class="UNKNOWN"]');
    expect(surfaces).toContain("border-style: dashed");
  });

  it("pins visible focus, narrow parity, and reduced-motion behavior", () => {
    const css = STYLE_FILES.map(read).join("\n");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("outline: 2px solid");
    expect(css).toContain("@media (max-width: 959px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).not.toMatch(/@import\s+url|fonts\.googleapis|display:\s*none/u);
  });

  it("fits all five board lanes at comfortable width and widens them only in narrow mode", () => {
    const board = read("preview-board.css");
    expect(board).toContain(".cr-board-summary");
    expect(board).toContain(".cr-board-lanes");
    expect(board).toContain("repeat(5, minmax(7.25rem, 1fr))");
    const responsive = read("responsive.css");
    expect(responsive).toContain("@media (max-width: 959px)");
    expect(responsive).toContain(".cr-board-summary");
    expect(responsive).toContain("repeat(5, minmax(13rem, 72vw))");
  });

  it("gives document lineage a dedicated responsive visual layer", () => {
    expect(read("control-room.css")).toContain('@import "./document-dossier.css";');
    const dossier = `${read("document-dossier.css")}\n${read("document-dossier-disclosure.css")}`;
    expect(dossier).toContain(".cr-dossier-source-list::before");
    expect(dossier).toContain(".cr-dossier-candidates");
    expect(dossier).toContain(".cr-dossier-source-list details");
    expect(dossier).toContain("min-block-size: 24px;");
    expect(dossier).toContain("min-block-size: 44px;");
    expect(dossier).toContain(".cr-dossier-source-list summary::after");
    expect(dossier).toMatch(/\.cr-dossier-decomposition\s*\{[^}]*grid-column:\s*1;/su);
    expect(dossier).toMatch(/\.cr-dossier-sources\s*\{[^}]*grid-column:\s*2;/su);
    expect(dossier).toContain("@media (max-width: 959px)");
    expect(dossier).not.toMatch(/display\s*:\s*none|text-overflow\s*:\s*ellipsis/u);
  });
});
