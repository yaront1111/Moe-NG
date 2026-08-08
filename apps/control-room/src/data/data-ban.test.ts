import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

/**
 * DoD 3 is a NEGATIVE property, and a negative property cannot be proven by behaviour: a
 * test can only show that the adapters did not compute a transition for the inputs it
 * happened to try. This scan proves it structurally instead, the same way the lease core
 * proved its import ban.
 *
 * Three assertions, and all three are load-bearing:
 *  1. the file list under data/ equals an exact set, so a NEW file cannot escape the ban;
 *  2. every production file's import specifiers equal an exact allow-list, so the layer
 *     structurally cannot reach a reducer, a transition table, or a lifecycle ordering;
 *  3. no named computation identifier appears in any production source.
 *
 * Only production files are scanned for identifiers. This file holds the forbidden list
 * itself, so scanning tests would make the ban fail on its own vocabulary.
 */

/**
 * `import.meta.url` is converted directly, with no relative `new URL(".", base)` step:
 * this app's tests run under jsdom, whose global `URL` resolves a relative specifier
 * against the jsdom document base and returns `http://localhost:3000/...` instead of the
 * file URL, which then fails `fileURLToPath` with "The URL must be of scheme file".
 */
const DIRECTORY = dirname(fileURLToPath(import.meta.url));

const EXPECTED_FILES = Object.freeze([
  "data-adapter.test.ts",
  "data-adapter.ts",
  "data-ban.test.ts",
  "data-contract.ts",
]);

/**
 * The whole layer may reach exactly one package. Everything it needs — query builders,
 * command builders, the error table, the contract pins, the wire protocol version —
 * arrives through the gated client surface, so there is no import path to `@moe/core`'s
 * reducers or to `@moe/contracts`' RUNTIME_LIFECYCLES ordering.
 */
const ALLOWED_IMPORTS = Object.freeze(["./data-contract.js", "@moe/control-room-client"]);

/**
 * Identifiers that would mean this layer had started computing what the daemon states.
 * Transition computation first, then truth-strength derivation.
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
]);

const IMPORT_SPECIFIER = /^\s*(?:import|export)[\s\S]*?from\s+"([^"]+)"/gmu;

function sourceFiles(): readonly string[] {
  return readdirSync(DIRECTORY).filter((name) => name.endsWith(".ts")).sort();
}

function productionFiles(): readonly string[] {
  return sourceFiles().filter((name) => !name.endsWith(".test.ts"));
}

function read(name: string): string {
  return readFileSync(join(DIRECTORY, name), "utf8");
}

function importsOf(text: string): readonly string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1];
    if (specifier !== undefined) found.add(specifier);
  }
  return [...found].sort();
}

it("scans exactly the expected file set, so a new file cannot escape the ban", () => {
  expect(sourceFiles()).toEqual([...EXPECTED_FILES]);
});

it("scans at least one production file, so the sweep cannot pass vacuously", () => {
  expect(productionFiles().length).toBeGreaterThan(0);
  expect(productionFiles()).toEqual(["data-adapter.ts", "data-contract.ts"]);
});

it("restricts every production import to the gated client and local siblings", () => {
  for (const name of productionFiles()) {
    const specifiers = importsOf(read(name));
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(ALLOWED_IMPORTS).toContain(specifier);
    }
  }
});

it("computes no transition and derives no truth strength in any production source", () => {
  const offenders: string[] = [];
  for (const name of productionFiles()) {
    const text = read(name);
    for (const identifier of FORBIDDEN_IDENTIFIERS) {
      if (text.includes(identifier)) offenders.push(`${name}:${identifier}`);
    }
  }
  expect(offenders).toEqual([]);
});
