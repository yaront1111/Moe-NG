/**
 * Cross-host evidence: the repository root's real consumer edge onto the two
 * public production surfaces the cross-host acceptance work will import.
 *
 * CONSUMER: task-01c5f96ec1e247dc846fd628c929974a. That task composes host
 * evidence from `@moe/runner`'s platform seam and `@moe/daemon`'s doctor
 * collector. This file exists so the edge it depends on is proven BEFORE it is
 * written: a lockfile-backed root dependency plus a durable call site that
 * reaches both producers through their BARE package specifiers only. A deep
 * relative path, a tsconfig `paths` entry, a project reference, or a
 * package-directory cwd would all resolve here while leaving the real root edge
 * broken, so none of them may appear in this file.
 *
 * AUTHORITY: none. Proving that a symbol is published and loadable says nothing
 * about the host this process is running on. The OS classifiers below are bound
 * and shape-pinned, never executed as executing-host probes, and nothing here
 * raises any observation above UNKNOWN.
 *
 * The catalogues are hand-written and their cardinalities are pinned, so a
 * dropped import, a silently emptied producer catalogue, or a sweep that
 * generates zero cases turns this file red instead of passing vacuously.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { collectDoctorVersionReport } from "@moe/daemon";
import { PLATFORM_BOUNDARIES, observeLinuxPlatform, observeMacosPlatform } from "@moe/runner";

/** The downstream task this edge is landed for. */
const CONSUMER_TASK_ID = "task-01c5f96ec1e247dc846fd628c929974a";

/** The two bare package roots — the only package specifiers permitted here. */
const RUNNER_SPECIFIER = "@moe/runner";
const DAEMON_SPECIFIER = "@moe/daemon";

/**
 * Hand-written, independent of both producers: the exact public values the
 * consumer must be able to reach through a bare specifier, with the kind each
 * one must have. Written out rather than derived, so it cannot drift silently.
 */
const EXPECTED_PUBLIC_SYMBOLS = Object.freeze([
  Object.freeze({ specifier: RUNNER_SPECIFIER, name: "PLATFORM_BOUNDARIES", kind: "object" }),
  Object.freeze({ specifier: RUNNER_SPECIFIER, name: "observeLinuxPlatform", kind: "function" }),
  Object.freeze({ specifier: RUNNER_SPECIFIER, name: "observeMacosPlatform", kind: "function" }),
  Object.freeze({ specifier: DAEMON_SPECIFIER, name: "collectDoctorVersionReport", kind: "function" }),
] as const);

const EXPECTED_PUBLIC_SYMBOL_COUNT = 4;

/** The imported values, in the same hand-written order. */
const IMPORTED_VALUES: readonly unknown[] = Object.freeze([
  PLATFORM_BOUNDARIES,
  observeLinuxPlatform,
  observeMacosPlatform,
  collectDoctorVersionReport,
]);

/**
 * The boundary names the production catalogue must publish, in order. Written
 * by hand here; asserted against the imported production value, never against a
 * local re-derivation of it.
 */
const EXPECTED_BOUNDARY_NAMES = Object.freeze([
  "PROVIDER_LAUNCH",
  "GIT_WORKSPACE",
  "PATH_SYMLINK",
  "LOCK",
  "SIGNAL_CANCELLATION",
  "RUNTIME_CLOSURE",
  "CRASH_RECOVERY",
] as const);

const EXPECTED_BOUNDARY_COUNT = 7;

/** This module's own bytes, read back to police its import specifiers. */
const MODULE_SOURCE = readFileSync(fileURLToPath(import.meta.url), "utf8");

const IMPORT_SPECIFIER_PATTERN = /from\s+["']([^"']+)["']/gu;

/** Every specifier this module imports from, in source order. */
function importedSpecifiers(): readonly string[] {
  return [...MODULE_SOURCE.matchAll(IMPORT_SPECIFIER_PATTERN)].flatMap((match) => {
    const specifier = match[1];
    return specifier === undefined ? [] : [specifier];
  });
}

describe(`cross-host production surfaces are reachable from the repository root (consumer ${CONSUMER_TASK_ID})`, () => {
  it("binds exactly the four hand-written public symbols, with the declared kinds", () => {
    expect(EXPECTED_PUBLIC_SYMBOLS).toHaveLength(EXPECTED_PUBLIC_SYMBOL_COUNT);
    expect(IMPORTED_VALUES).toHaveLength(EXPECTED_PUBLIC_SYMBOL_COUNT);

    const declaredNames = EXPECTED_PUBLIC_SYMBOLS.map((entry) => entry.name);
    expect(new Set(declaredNames).size).toBe(EXPECTED_PUBLIC_SYMBOL_COUNT);
    expect(declaredNames).toEqual([
      "PLATFORM_BOUNDARIES",
      "observeLinuxPlatform",
      "observeMacosPlatform",
      "collectDoctorVersionReport",
    ]);
    expect(new Set(EXPECTED_PUBLIC_SYMBOLS.map((entry) => entry.specifier))).toEqual(
      new Set([RUNNER_SPECIFIER, DAEMON_SPECIFIER]),
    );

    for (const value of IMPORTED_VALUES) {
      expect(value).toBeDefined();
      expect(value).not.toBeNull();
    }
    expect(IMPORTED_VALUES.map((value) => typeof value)).toEqual(
      EXPECTED_PUBLIC_SYMBOLS.map((entry) => entry.kind),
    );
  });

  it("reads the production boundary catalogue as the exact ordered seven-name tuple", () => {
    expect(EXPECTED_BOUNDARY_NAMES).toHaveLength(EXPECTED_BOUNDARY_COUNT);

    // Asserted against the imported production value, not a local substitute.
    expect(PLATFORM_BOUNDARIES).toHaveLength(EXPECTED_BOUNDARY_COUNT);
    expect([...PLATFORM_BOUNDARIES]).toEqual([...EXPECTED_BOUNDARY_NAMES]);
    expect(new Set(PLATFORM_BOUNDARIES).size).toBe(EXPECTED_BOUNDARY_COUNT);
    expect(Object.isFrozen(PLATFORM_BOUNDARIES)).toBe(true);

    let inspected = 0;
    for (const name of PLATFORM_BOUNDARIES) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
      inspected += 1;
    }
    // The sweep above must have actually produced cases.
    expect(inspected).toBe(EXPECTED_BOUNDARY_COUNT);
  });

  it("reaches both producers by bare package root, with no deep or relative escape hatch", () => {
    const specifiers = importedSpecifiers();
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers).toContain(RUNNER_SPECIFIER);
    expect(specifiers).toContain(DAEMON_SPECIFIER);

    const packageSpecifiers = specifiers.filter((specifier) => specifier.startsWith("@moe/"));
    expect(new Set(packageSpecifiers)).toEqual(new Set([RUNNER_SPECIFIER, DAEMON_SPECIFIER]));
    expect(packageSpecifiers).toHaveLength(2);

    for (const specifier of specifiers) {
      expect(specifier.startsWith(".")).toBe(false);
      expect(specifier).not.toContain("/src/");
      expect(specifier.endsWith(".ts")).toBe(false);
    }
  });

  it("pins the callable shapes without executing them as executing-host probes", () => {
    expect(typeof observeLinuxPlatform).toBe("function");
    expect(observeLinuxPlatform).toHaveLength(1);
    expect(typeof observeMacosPlatform).toBe("function");
    expect(observeMacosPlatform).toHaveLength(1);
    // Two distinct OS adapters: a single shared classifier would make a darwin
    // judgement indistinguishable from a Linux one.
    expect(observeLinuxPlatform).not.toBe(observeMacosPlatform);

    expect(typeof collectDoctorVersionReport).toBe("function");
    expect(collectDoctorVersionReport).toHaveLength(0);
    expect(collectDoctorVersionReport.constructor.name).toBe("AsyncFunction");
  });
});
