import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The authority ban is a NEGATIVE property, so behaviour cannot prove it: a render test
 * only shows the surface did not reach a daemon for the props it happened to be given.
 * This scan proves it structurally over every owned production module.
 *
 * Four assertions carry it, and all four are load-bearing:
 *  1. the file listing of both owned directories equals an exact set, so a NEW file
 *     cannot escape the ban by being added;
 *  2. the scanned set equals exactly the new production modules, with `doctor-j1.tsx`
 *     excluded by name rather than by pattern, so nothing can hide behind the exclusion;
 *  3. every scanned file is read non-empty and still contains its declared anchor, so
 *     the `not.toContain` assertions below cannot pass over an unread or wrong path;
 *  4. import specifiers equal an allow-list and no forbidden token appears.
 *
 * Paths resolve from `process.cwd()` — the Vitest root is this package — because
 * `import.meta.url` is rewritten to an http URL for `.tsx` under the React plugin, and
 * a scan that silently reads nothing passes every absence assertion forever.
 *
 * Only production files are scanned. This file holds the forbidden list itself, so
 * scanning tests would make the ban fail on its own vocabulary.
 */
const DOCTOR_DIR = resolve(process.cwd(), "src/doctor");
const RECOVERY_DIR = resolve(process.cwd(), "src/recovery");
const LEGACY_DOCTOR_SLICE = "doctor-j1.tsx";

const EXPECTED_DOCTOR_FILES = Object.freeze([
  "doctor-console.test.tsx", "doctor-console.tsx", "doctor-j1.tsx",
]);

const EXPECTED_RECOVERY_FILES = Object.freeze([
  "reconciliation-inventory.test.tsx", "reconciliation-inventory.tsx",
  "recovery-actions.test.tsx", "recovery-actions.tsx", "recovery-external.tsx",
  "recovery-import-ban.test.ts", "recovery-status.test.tsx", "recovery-status.tsx",
]);

const SCANNED_MODULES = Object.freeze([
  [DOCTOR_DIR, "doctor-console.tsx", "export function DoctorConsole"],
  [RECOVERY_DIR, "reconciliation-inventory.tsx", "export function ReconciliationInventory"],
  [RECOVERY_DIR, "recovery-actions.tsx", "export function RecoveryActions"],
  [RECOVERY_DIR, "recovery-external.tsx", "export function RecoveryExternalInventory"],
  [RECOVERY_DIR, "recovery-status.tsx", "export function RecoveryStatus"],
] as const);

const ALLOWED_IMPORTS = Object.freeze([
  "@moe/contracts", "../nodes/node-authority.js", "../shell/frame.js",
  "./recovery-actions.js", "./recovery-external.js", "react",
]);

/**
 * Identifiers that would mean a presentation module had grown its own authority: a
 * fixture or adapter it could believe instead of the daemon, an error it could mint, or
 * any path off the browser onto the machine.
 */
const FORBIDDEN_TOKENS = Object.freeze([
  "../fixtures.js", "../data/", "@moe/control-room-client", "@moe/core", "@moe/daemon",
  "@moe/runner", "XMLHttpRequest", "child_process", "createRuntimeError",
  "dangerouslySetInnerHTML", "fetch(", "localStorage", "node:fs", "process.cwd",
  "process.env", "type=\"file\"",
]);

const IMPORT_SPECIFIER = /^\s*(?:import|export)[\s\S]*?from\s+"([^"]+)"/gmu;

function listing(directory: string): readonly string[] {
  return readdirSync(directory).sort();
}

function read(directory: string, name: string): string {
  return readFileSync(join(directory, name), "utf8");
}

function importsOf(text: string): readonly string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1];
    if (specifier !== undefined) found.add(specifier);
  }
  return [...found].sort();
}

describe("the owned production modules structurally cannot reach authority", () => {
  it("scans exactly the expected owned file set, so a new file cannot escape", () => {
    expect(listing(DOCTOR_DIR)).toEqual([...EXPECTED_DOCTOR_FILES]);
    expect(listing(RECOVERY_DIR)).toEqual([...EXPECTED_RECOVERY_FILES]);
  });

  it("scans every new production module and none of the legacy slice", () => {
    const scanned = SCANNED_MODULES.map(([, name]) => name);
    expect(scanned).toHaveLength(5);
    expect(scanned).not.toContain(LEGACY_DOCTOR_SLICE);
    const production = [...EXPECTED_DOCTOR_FILES, ...EXPECTED_RECOVERY_FILES]
      .filter((name) => !name.includes(".test.") && name !== LEGACY_DOCTOR_SLICE);
    expect([...scanned].sort()).toEqual(production.sort());
  });

  it("reads real source for each module, so the absence assertions are not vacuous", () => {
    for (const [directory, name, anchor] of SCANNED_MODULES) {
      const source = read(directory, name);
      expect(source.length, `${name} read empty`).toBeGreaterThan(400);
      expect(source, `${name} lost its anchor`).toContain(anchor);
    }
  });

  it("restricts every production import to react, contracts, and owned siblings", () => {
    for (const [directory, name] of SCANNED_MODULES) {
      const specifiers = importsOf(read(directory, name));
      expect(specifiers.length, `${name} imports nothing`).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        expect(ALLOWED_IMPORTS, `${name} imports ${specifier}`).toContain(specifier);
      }
    }
  });

  it("names no fixture, adapter, transport, filesystem, or error-minting identifier", () => {
    const offenders: string[] = [];
    for (const [directory, name] of SCANNED_MODULES) {
      const source = read(directory, name);
      for (const token of FORBIDDEN_TOKENS) {
        if (source.includes(token)) offenders.push(`${name}:${token}`);
      }
    }
    expect(FORBIDDEN_TOKENS.length).toBe(16);
    expect(offenders).toEqual([]);
  });

  it("keeps every production module under the 400-line cap", () => {
    for (const [directory, name] of SCANNED_MODULES) {
      const lines = read(directory, name).split("\n").length;
      expect(lines, `${name} is ${lines} lines`).toBeLessThan(400);
    }
  });
});
