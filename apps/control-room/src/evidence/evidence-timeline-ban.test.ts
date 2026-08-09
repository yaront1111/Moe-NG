import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

/**
 * DoD 2 — "rejected commands, cursor gaps, recovery markers, and typed session messages
 * remain visible WITHOUT BECOMING AUTHORITY" — is a NEGATIVE property, and a negative
 * property cannot be proven by behaviour. A rendering test can only show that these
 * surfaces did not become authority for the inputs it happened to try. This scan proves
 * it structurally instead, the same way `data-ban.test.ts` proves the adapter ban.
 *
 * Four assertions, all load-bearing:
 *  1. the file list under BOTH owned directories equals an exact set, so a new file
 *     cannot escape the ban;
 *  2. the union of every production import specifier equals an exact allow-list — not
 *     merely a subset of it, so a stale over-broad entry cannot sit there unnoticed;
 *  3. no banned package appears in any production source, and no banned package may be
 *     added to the allow-list either, so widening assertion 2 cannot quietly defeat it;
 *  4. no named computation identifier appears in any production source.
 *
 * Only production files are scanned for identifiers and imports. This file holds the
 * forbidden vocabulary itself, so scanning tests would fail the ban on its own words.
 */

/**
 * `import.meta.url` is converted DIRECTLY, with no relative `new URL(".", base)` step:
 * these tests run under jsdom, whose global `URL` resolves a relative specifier against
 * the jsdom document base and yields `http://localhost:3000/...`, which then fails
 * `fileURLToPath` with "The URL must be of scheme file".
 */
const EVIDENCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const TIMELINE_DIRECTORY = join(EVIDENCE_DIRECTORY, "..", "timeline");

const EXPECTED_EVIDENCE_FILES = Object.freeze([
  "evidence-contract.ts",
  "evidence-inspect.test.tsx",
  "evidence-inspect.tsx",
  "evidence-j1.tsx",
  "evidence-timeline-ban.test.ts",
]);

const EXPECTED_TIMELINE_FILES = Object.freeze([
  "timeline-contract.ts",
  "timeline-list.test.tsx",
  "timeline-list.tsx",
  "timeline-page.test.ts",
  "timeline-page.ts",
  "timeline-row.tsx",
]);

/**
 * Every specifier these surfaces are permitted to reach, and — because assertion 2 is an
 * equality — every specifier they actually do reach. Truth presentation arrives through
 * `../nodes/node-authority.js` -> the kernel -> `@moe/control-room-model`, and daemon
 * facts arrive as props, so there is structurally no import path to a reducer, a
 * transition table, or the store's own `CURSOR_GAP` contract.
 */
const ALLOWED_IMPORTS = Object.freeze([
  "../data/data-contract.js",
  "../fixtures.js",
  "../nodes/node-authority.js",
  "../shell/provenance-panel.js",
  "../timeline/timeline-contract.js",
  "./evidence-contract.js",
  "./timeline-contract.js",
  "./timeline-page.js",
  "./timeline-row.js",
  "react",
]);

/**
 * Packages that own authority. `@moe/store` and `@moe/coordination` each declare their
 * own `CURSOR_GAP`; reaching for one would give this app a second path to daemon truth
 * beside the gated client. `@moe/contracts` carries the lifecycle ordering.
 */
const BANNED_PACKAGES = Object.freeze([
  "@moe/contracts",
  "@moe/coordination",
  "@moe/core",
  "@moe/store",
]);

/**
 * Identifiers that would mean these surfaces had started computing what the daemon
 * states. The first block is `data-ban.test.ts`'s list; the second is what a timeline and
 * an evidence view could plausibly grow.
 */
const FORBIDDEN_IDENTIFIERS = Object.freeze([
  "RUNTIME_LIFECYCLES",
  "TRANSITIONS",
  "canTransition",
  "compareTruth",
  "deriveTruth",
  "inferState",
  "inferStatus",
  "nextState",
  "rankTruth",
  "reduceGoal",
  "reduceNodeRun",
  "reduceProject",
  "strongerTruth",
  "truthStrength",
  "compareDigests",
  "deriveCausality",
  "digestsMatch",
  "inferCause",
  "rankEvidence",
  "resyncCursor",
  "sortByTruth",
  "upgradeTruth",
]);

const IMPORT_SPECIFIER = /^\s*(?:import|export)[\s\S]*?from\s+"([^"]+)"/gmu;

interface SourceFile {
  readonly name: string;
  readonly path: string;
}

function sourceNames(directory: string): readonly string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .sort();
}

function productionFiles(): readonly SourceFile[] {
  const found: SourceFile[] = [];
  for (const directory of [EVIDENCE_DIRECTORY, TIMELINE_DIRECTORY]) {
    for (const name of sourceNames(directory)) {
      if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) continue;
      found.push({ name, path: join(directory, name) });
    }
  }
  return found;
}

function importsOf(text: string): readonly string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1];
    if (specifier !== undefined) found.add(specifier);
  }
  return [...found];
}

it("scans exactly the expected file set in both owned directories", () => {
  expect(sourceNames(EVIDENCE_DIRECTORY)).toEqual([...EXPECTED_EVIDENCE_FILES]);
  expect(sourceNames(TIMELINE_DIRECTORY)).toEqual([...EXPECTED_TIMELINE_FILES]);
});

it("scans every production file in both directories, so the sweep cannot pass vacuously", () => {
  expect(productionFiles().map((file) => file.name)).toEqual([
    "evidence-contract.ts",
    "evidence-inspect.tsx",
    "evidence-j1.tsx",
    "timeline-contract.ts",
    "timeline-list.tsx",
    "timeline-page.ts",
    "timeline-row.tsx",
  ]);
});

it("reaches exactly the allowed specifiers — no more, and none of them stale", () => {
  const union = new Set<string>();
  for (const file of productionFiles()) {
    const specifiers = importsOf(readFileSync(file.path, "utf8"));
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(ALLOWED_IMPORTS).toContain(specifier);
      union.add(specifier);
    }
  }
  expect([...union].sort()).toEqual([...ALLOWED_IMPORTS]);
});

it("cannot reach a package that owns authority, and cannot be widened to allow one", () => {
  for (const banned of BANNED_PACKAGES) {
    // Widening the allow-list is the obvious way to defeat the assertion above.
    expect(ALLOWED_IMPORTS).not.toContain(banned);
  }
  const offenders: string[] = [];
  for (const file of productionFiles()) {
    const text = readFileSync(file.path, "utf8");
    for (const banned of BANNED_PACKAGES) {
      if (text.includes(banned)) offenders.push(`${file.name}:${banned}`);
    }
  }
  expect(offenders).toEqual([]);
});

it("computes no causality, no ranking, and no truth upgrade in any production source", () => {
  const offenders: string[] = [];
  for (const file of productionFiles()) {
    const text = readFileSync(file.path, "utf8");
    for (const identifier of FORBIDDEN_IDENTIFIERS) {
      if (text.includes(identifier)) offenders.push(`${file.name}:${identifier}`);
    }
  }
  expect(offenders).toEqual([]);
});
