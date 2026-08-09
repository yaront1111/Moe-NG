import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

/**
 * Two negative properties, neither provable by rendering.
 *
 * 1. The canonical goals and board modules never reach a reducer, a lifecycle table, a
 *    fixture, or the data adapter. A behavioural test can only show that the surfaces
 *    did not derive authority for the inputs it happened to try; the import and
 *    identifier scan shows they structurally cannot.
 * 2. The narrow-window layout contract holds. jsdom does not evaluate viewport media
 *    queries, so a rendered assertion about behaviour under 960px would be theatre.
 *    The stylesheet source is read and pinned instead.
 *
 * Every sweep here asserts its own case count first: a scan that silently matched zero
 * files would pass while testing nothing.
 */
const BOARD_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const GOALS_DIRECTORY = join(BOARD_DIRECTORY, "..", "goals");

const EXPECTED_BOARD_FILES = Object.freeze([
  "board-card.tsx", "board-contract.ts", "board-j1.tsx", "board-layout.css",
  "board-surface.test.tsx", "board-surface.tsx", "goals-board-ban.test.ts",
]);

const EXPECTED_GOALS_FILES = Object.freeze([
  "goals-home.test.tsx", "goals-home.tsx", "goals-j1.tsx", "supplied-actions.tsx",
]);

/** The canonical modules this task owns. The J1 slices keep their own older contract. */
const CANONICAL_PRODUCTION = Object.freeze([
  [BOARD_DIRECTORY, "board-card.tsx"], [BOARD_DIRECTORY, "board-contract.ts"],
  [BOARD_DIRECTORY, "board-surface.tsx"], [GOALS_DIRECTORY, "goals-home.tsx"],
  [GOALS_DIRECTORY, "supplied-actions.tsx"],
] as const);

/**
 * Everything these modules need is a presentation primitive, the command contract, or a
 * local sibling. There is no path to `@moe/core`'s reducers, to the scheduler, to a
 * store, to the fixture corpus, or to the data adapter.
 */
const ALLOWED_IMPORTS = Object.freeze([
  "../goals/supplied-actions.js", "../nodes/node-authority.js", "../shell/frame.js",
  "./board-card.js", "./board-contract.js", "./board-layout.css", "./supplied-actions.js",
  "@moe/contracts", "react",
]);

/** Substrings that would mean a canonical module had reached a forbidden layer. */
const FORBIDDEN_IMPORT_FRAGMENTS = Object.freeze([
  "@moe/core", "data-adapter", "fixtures", "scheduler", "store",
]);

/**
 * Identifiers that would mean this layer had started computing what the daemon states:
 * a transition, a phase-to-column fold, a readiness, a truth ranking, or the goal
 * creation defaults that belong to policy.
 */
const FORBIDDEN_IDENTIFIERS = Object.freeze([
  "PHASE_TO_COLUMN", "RUNTIME_LIFECYCLES", "TRANSITIONS", "canTransition", "columnForPhase",
  "compareTruth", "deriveReadiness", "deriveTruth", "inferPhase", "inferState", "nextState",
  "rankTruth", "reduceGoal", "reduceNodeRun", "strongerTruth", "truthStrength",
  "\"50\"", "\"normal\"",
]);

const IMPORT_SPECIFIER = /^\s*(?:import|export)[\s\S]*?from\s+"([^"]+)"/gmu;
const BARE_IMPORT = /^\s*import\s+"([^"]+)"/gmu;
/** A triple-slash reference would otherwise be a type-shaped hole in the import scan. */
const TYPE_REFERENCE = /\/\/\/\s*<reference\s+types="([^"]+)"/gu;
const ALLOWED_TYPE_REFERENCES = Object.freeze(["vite/client"]);

const CSS_PATH = join(process.cwd(), "src", "board", "board-layout.css");
const CSS = readFileSync(CSS_PATH, "utf8");

function listing(directory: string): readonly string[] {
  return readdirSync(directory).sort();
}

function read([directory, name]: readonly [string, string]): string {
  return readFileSync(join(directory, name), "utf8");
}

function importsOf(text: string): readonly string[] {
  const found = new Set<string>();
  for (const pattern of [IMPORT_SPECIFIER, BARE_IMPORT]) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) found.add(specifier);
    }
  }
  return [...found].sort();
}

it("scans exactly the expected files, so a new module cannot escape the ban", () => {
  expect(listing(BOARD_DIRECTORY)).toEqual([...EXPECTED_BOARD_FILES]);
  expect(listing(GOALS_DIRECTORY)).toEqual([...EXPECTED_GOALS_FILES]);
  expect(CANONICAL_PRODUCTION).toHaveLength(5);
});

it("restricts every canonical import to primitives, contracts, and local siblings", () => {
  let scanned = 0;
  for (const entry of CANONICAL_PRODUCTION) {
    const specifiers = importsOf(read(entry));
    expect(specifiers.length).toBeGreaterThan(0);
    scanned += specifiers.length;
    for (const specifier of specifiers) {
      expect(ALLOWED_IMPORTS).toContain(specifier);
      for (const fragment of FORBIDDEN_IMPORT_FRAGMENTS) {
        expect(specifier).not.toContain(fragment);
      }
    }
  }
  expect(scanned).toBeGreaterThan(CANONICAL_PRODUCTION.length);
  const references = CANONICAL_PRODUCTION.flatMap((entry) =>
    [...read(entry).matchAll(TYPE_REFERENCE)].map((match) => match[1] ?? ""));
  expect(references).toEqual(["vite/client"]);
  for (const reference of references) expect(ALLOWED_TYPE_REFERENCES).toContain(reference);
});

it("derives no transition, column fold, truth strength, or policy default", () => {
  expect(FORBIDDEN_IDENTIFIERS.length).toBeGreaterThan(0);
  const offenders: string[] = [];
  for (const entry of CANONICAL_PRODUCTION) {
    const text = read(entry);
    for (const identifier of FORBIDDEN_IDENTIFIERS) {
      if (text.includes(identifier)) offenders.push(`${entry[1]}:${identifier}`);
    }
  }
  expect(offenders).toEqual([]);
});

it("reads the real stylesheet, so the layout pins below cannot pass vacuously", () => {
  expect(CSS_PATH.endsWith(join("src", "board", "board-layout.css"))).toBe(true);
  expect(CSS.length).toBeGreaterThan(400);
  expect(CSS).toContain("[data-testid=\"cr.board.columns\"]");
});

it("pins the narrow-window layout jsdom cannot evaluate", () => {
  expect(CSS).toContain("@media (max-width: 959px)");
  expect(CSS).toContain("[data-testid=\"cr.board.columnjump\"]");
  expect(CSS).toContain("overflow-x: auto");
  expect(CSS).toContain("position: sticky");
  expect(CSS).toContain(":focus-visible");
  expect(CSS).toContain("outline: 2px solid");
  expect(CSS).toContain("@media (prefers-reduced-motion: reduce)");
});

it("hides no card or action content at any width", () => {
  expect(CSS).toContain("overflow: visible");
  expect(CSS).not.toContain("overflow: hidden");
  expect(CSS).not.toContain("text-overflow: ellipsis");
  expect(CSS).not.toContain("display: none");
  expect(CSS).not.toContain("visibility: hidden");
});
