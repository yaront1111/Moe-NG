/**
 * PARTITION AND LEDGER — shared machinery for the three runtime-provider slices.
 *
 * NOT a `*.security.ts` file, deliberately: the lane collects that suffix, so this would
 * register as a suite with no cases and `passWithNoTests: false` would fail on its emptiness.
 * Same reason `hostile-harness.ts` carries no suffix.
 *
 * WHY THE PARTITION LIVES HERE RATHER THAN IN EACH FILE. The lane runs `pool: "forks"` with
 * `isolate: true`, so no module state is shared between test files — three copies of the
 * partition would drift silently and a boundary could fall between two of them, owned by
 * neither. One frozen table, read by all three, makes the union checkable in ONE place.
 *
 * IT HOLDS NO AUTHORITY. It records what a case asserted and re-reads the roster's committed
 * bytes; it never derives an expected code or layer, and never judges a refusal. Every code
 * and layer expectation is written at the case, taken from the boundary's OWN exported
 * constant.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assertRefusedWith } from "./hostile-harness.js";
import type { HostileBound, LegOutcome, RefusalExpectation } from "./hostile-harness.js";

/**
 * Two seconds. `MAX_BOUND_MS` is 2**31-1 — the `setTimeout` clamp boundary, where a wider
 * bound silently becomes the TIGHTEST one — so this sits four orders of magnitude below it.
 * The failure mode guarded against is a HANG: the lane runs `fileParallelism: false`, so one
 * unbounded wait stalls every file after it and reports no verdict at all rather than a red.
 */
export const RUNTIME_BOUND: HostileBound = Object.freeze({
  label: "runtime-provider-boundary",
  timeoutMs: 2_000,
});

/**
 * The three slices, and which roster entry each owns. HAND-WRITTEN: no part of this is
 * emitted by the scan it is checked against. `assertRosterPartition` proves the union equals
 * the roster's `runtime-provider` tag in BOTH directions, so a boundary added to the roster
 * and forgotten here reddens, and a name invented here that the roster does not carry reddens
 * too.
 */
export const RUNTIME_PROVIDER_PARTITION = Object.freeze({
  /** Operating-system and runtime-closure surfaces. */
  PLATFORM: Object.freeze([
    "CLAUDE_RUNTIME_PIN_LAYER",
    "PLATFORM_BOUNDARIES",
    "PLATFORM_LAYERS",
    "PLATFORM_LINUX_LAYER",
    "PLATFORM_MACOS_LAYER",
    "WINDOWS_PROCESS_LAYERS",
  ] as const),
  /** Provider launch, render, telemetry and usage surfaces. */
  LAUNCH: Object.freeze([
    "CLAUDE_LAUNCH_LAYERS",
    "CLAUDE_LAUNCH_SELECTION_LAYER",
    "CLAUDE_RENDER_LAYERS",
    "CODEX_RENDER_LAYERS",
    "PROVIDER_RUN_LEDGER_LAYERS",
    "PROVIDER_TELEMETRY_LAYERS",
    "PROVIDER_USAGE_LAYERS",
  ] as const),
  /** Evidence, workspace, containment and supervision surfaces. */
  EVIDENCE: Object.freeze([
    "ARTIFACT_ENUMERATION_LAYERS",
    "EVIDENCE_REFUSAL_LAYERS",
    "MATERIALIZATION_REFUSAL_LAYERS",
    "RECOVERY_INVENTORY_LAYERS",
    "RECOVERY_LAYERS",
    "RUNNER_WORKSPACE_LAYER",
    "SCOPE_OBSERVER_LAYERS",
    "SUPERVISOR_LAYERS",
    "VERIFIER_PROCESS_LAYERS",
  ] as const),
});

export type PartitionKey = keyof typeof RUNTIME_PROVIDER_PARTITION;

const ROSTER_PATH = fileURLToPath(new URL("./boundary-roster.security.ts", import.meta.url));
const RUNTIME_ENTRY =
  /constant:\s*"([A-Z0-9_]+)",\s*file:\s*"[^"]+",\s*axis:\s*"runtime-provider"/gu;

/**
 * The roster's own committed bytes are the authority on this axis. It is read as TEXT rather
 * than imported because `boundary-roster.security.ts` registers suites at module scope, and
 * importing it would re-register its cases inside every slice that did so.
 */
export function rosterRuntimeProvider(): readonly string[] {
  const source = readFileSync(ROSTER_PATH, "utf8");
  return Object.freeze([...source.matchAll(RUNTIME_ENTRY)].map((match) => match[1] ?? ""));
}

export type Arm = "AFTER" | "BEFORE" | "RACE";

export interface Admission {
  readonly boundary: string;
  readonly arm: Arm;
  /** True only if a hostile input was ADMITTED. Every case here records `false`. */
  readonly admitted: boolean;
  /** The refusal message the production surface returned, kept for the hygiene property. */
  readonly message: string;
}

/** Reads a layer off the boundary's OWN declared constant, so a layer that stops being
 *  declared there reddens here instead of surviving as a string literal nobody rechecks. */
export function layerOf<T extends string>(declared: readonly T[], name: string): T {
  const found = declared.find((layer) => layer === name);
  if (found === undefined) {
    throw new Error(`${name} is no longer declared by its boundary constant`);
  }
  return found;
}

/** Cast a hostile fixture into the declared parameter type. Named so a reader can grep every
 *  place a slice deliberately hands production something its type forbids. */
export const hostile = <T,>(value: unknown): T => value as T;

function messageOf(actual: unknown): string {
  if (typeof actual !== "object" || actual === null) return "";
  const record = actual as Record<string, unknown>;
  const text = record["message"] ?? record["reason"] ?? record["detail"];
  return typeof text === "string" ? text : "";
}

export interface Ledger {
  readonly entries: readonly Admission[];
  /** Assert a refusal by code AND layer, and record that the input was not admitted. */
  refused: (boundary: string, arm: Arm, actual: unknown, expected: RefusalExpectation) => void;
  /** As `refused`, for ONE side of a race. Asserted per side: an aggregate assertion over a
   *  race can hide a double admit, which is the one defect a race case exists to find. */
  refusedSide: <T>(boundary: string, side: LegOutcome<T>, expected: RefusalExpectation) => void;
  /** Record a non-admission whose code the CASE already asserted against the production value
   *  and whose surface reports no layer of its own. Never a shortcut around `refused`: the only
   *  callers are the render contracts, whose layer vocabulary lives on the accepted envelope's
   *  manifest and is exercised by a manifest-attributed case on the same boundary. */
  record: (boundary: string, arm: Arm, message: string) => void;
}

export function createLedger(): Ledger {
  const entries: Admission[] = [];
  return {
    entries,
    refused(boundary, arm, actual, expected) {
      assertRefusedWith(actual, expected);
      entries.push({ admitted: false, arm, boundary, message: messageOf(actual) });
    },
    record(boundary, arm, message) {
      entries.push({ admitted: false, arm, boundary, message });
    },
    refusedSide(boundary, side, expected) {
      expect(side.status).toBe("fulfilled");
      assertRefusedWith(side.status === "fulfilled" ? side.value : side.reason, expected);
      entries.push({
        admitted: false,
        arm: "RACE",
        boundary,
        message: messageOf(side.status === "fulfilled" ? side.value : side.reason),
      });
    },
  };
}

/** Every boundary in `owned` swept, nothing outside it swept, and all three arms present. */
export function assertSweepsExactly(ledger: Ledger, owned: readonly string[]): void {
  const covered = new Set(ledger.entries.map((entry) => entry.boundary));
  expect([...covered].filter((name) => !owned.includes(name)).sort()).toEqual([]);
  expect(owned.filter((name) => !covered.has(name)).sort()).toEqual([]);
  expect(
    owned.flatMap((name) =>
      (["AFTER", "BEFORE", "RACE"] as const)
        .filter((arm) => !ledger.entries.some((e) => e.boundary === name && e.arm === arm))
        .map((arm) => `${name}#${arm}`),
    ),
  ).toEqual([]);
}

/** A POSITIVE case count per boundary AND per arm. A boundary or an arm that silently
 *  generated nothing would otherwise satisfy every set assertion above vacuously. */
export function assertPositiveCounts(ledger: Ledger, owned: readonly string[]): void {
  expect(owned.length).toBeGreaterThan(0);
  for (const name of owned) {
    for (const arm of ["AFTER", "BEFORE", "RACE"] as const) {
      expect(
        ledger.entries.filter((entry) => entry.boundary === name && entry.arm === arm).length,
      ).toBeGreaterThan(0);
    }
  }
}

/**
 * THE WHOLE-SLICE INVARIANT. One assertion over every outcome the file collected, rather than
 * one per case, so a case added later cannot escape it. `isolate: true` means the three files
 * cannot share one array, so this runs once per file over that file's entire ledger — one
 * implementation, three invocations, no case outside it.
 */
export function assertAdmittedNothing(ledger: Ledger): void {
  expect(ledger.entries.length).toBeGreaterThan(0);
  expect(ledger.entries.filter((entry) => entry.admitted)).toEqual([]);
}

/**
 * MESSAGE HYGIENE, asserted as a property over the WHOLE refusal set rather than one example.
 * A refusal message quoting a path, an argv element, an environment value, a digest or a
 * captured byte would echo provider output back out of a failure path — the rail
 * `PROVIDER_TELEMETRY_MESSAGES` is written to keep, and a producer was rejected once on it.
 */
const ECHO_PATTERNS: readonly (readonly [string, RegExp])[] = Object.freeze([
  ["a windows drive path", /[A-Za-z]:[\\/]/u],
  ["a posix absolute path", /(?:^|\s)\/(?:[\w.-]+\/){2}/u],
  ["a hex digest", /\b[0-9a-f]{32,}\b/u],
  ["a base64 blob", /\b[A-Za-z0-9+/]{40,}={0,2}\b/u],
  ["a secret-shaped environment value", /\b(?:SECRET|TOKEN|API_KEY|PASSWORD)\b\s*[:=]/u],
]);

export function assertMessagesEchoNothing(ledger: Ledger, secrets: readonly string[]): void {
  expect(ledger.entries.length).toBeGreaterThan(0);
  const offences: string[] = [];
  for (const entry of ledger.entries) {
    for (const [what, pattern] of ECHO_PATTERNS) {
      if (pattern.test(entry.message)) offences.push(`${entry.boundary}#${entry.arm}: ${what}`);
    }
    for (const secret of secrets) {
      if (secret !== "" && entry.message.includes(secret)) {
        // The offending bytes are NOT quoted: printing them here would publish exactly what
        // the rail forbids production from publishing.
        offences.push(`${entry.boundary}#${entry.arm}: a hostile input value`);
      }
    }
  }
  expect(offences).toEqual([]);
}

/**
 * The four checks EVERY slice owes, registered as one block so a slice cannot ship without
 * them and cannot spell them differently. One implementation, three invocations: `isolate:
 * true` means the three files cannot share one array, so each runs these over its own whole
 * ledger rather than per case.
 */
export function describeSliceInvariants(
  group: string,
  ledger: Ledger,
  owned: readonly string[],
  secrets: readonly string[],
): void {
  describe(`${group} — completeness and the no-admission invariant`, () => {
    it("sweeps exactly this slice's partition, in BOTH directions, with all three arms", () => {
      assertSweepsExactly(ledger, owned);
    });
    it("records a POSITIVE case count per boundary AND per arm", () => {
      assertPositiveCounts(ledger, owned);
    });
    it("admits nothing: no hostile input raised a truth class or yielded authority", () => {
      assertAdmittedNothing(ledger);
    });
    it("echoes nothing: no refusal message carries a path, a digest or a hostile value", () => {
      assertMessagesEchoNothing(ledger, secrets);
    });
  });
}

/**
 * THE COMPLETENESS HOME. Called from exactly ONE slice, so the union check has a single
 * owner. Both directions: the roster's runtime-provider tag equals the union of the three
 * partitions, and no partition names a boundary the roster does not carry.
 */
export function assertRosterPartition(): void {
  const roster = rosterRuntimeProvider();
  // A parse that silently matched nothing would make every set assertion below vacuous.
  expect(roster.length).toBeGreaterThan(0);
  expect(roster).toHaveLength(22);
  const union: readonly string[] = [
    ...RUNTIME_PROVIDER_PARTITION.PLATFORM,
    ...RUNTIME_PROVIDER_PARTITION.LAUNCH,
    ...RUNTIME_PROVIDER_PARTITION.EVIDENCE,
  ];
  // No boundary owned twice: two slices covering one entry would let a third go missing while
  // the cardinality check still balanced.
  expect(new Set(union).size).toBe(union.length);
  expect(union.filter((name) => !roster.includes(name)).sort()).toEqual([]);
  expect(roster.filter((name) => !union.includes(name)).sort()).toEqual([]);
}
