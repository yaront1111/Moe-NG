/**
 * PARTITION AND SLICE INVARIANTS for the three runtime-provider slices.
 *
 * NOT a `*.security.ts` file, deliberately: the lane collects that suffix, so this would
 * register as a suite with no cases and `passWithNoTests: false` would fail on its emptiness.
 * Same reason `hostile-harness.ts` and `runtime-provider-ledger.ts` carry no suffix.
 *
 * Split out of `runtime-provider-ledger.ts` when that file crossed the 400-line rail. The
 * division is by concern, not by size: the LEDGER records what a boundary answered, and this
 * module reads a completed ledger and judges COVERAGE — completeness, the no-admission
 * invariant, and message hygiene. Nothing here touches a production surface.
 *
 * WHY THE PARTITION LIVES IN ONE FILE. The lane runs `pool: "forks"` with `isolate: true`, so
 * no module state is shared between test files — three copies of the partition would drift
 * silently and a boundary could fall between two of them, owned by neither. One frozen table,
 * read by all three, makes the union checkable in ONE place.
 *
 * IT HOLDS NO AUTHORITY. It re-reads the roster's committed bytes; it never derives an expected
 * code or layer, and never judges an individual refusal.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Ledger } from "./runtime-provider-ledger.js";

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
    "BENCHMARK_PROJECTION_LAYERS",
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
    "PROVIDER_EFFECT_SETTLEMENT_LAYER",
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
 * THE WHOLE-SLICE INVARIANT, in two clauses: nothing was admitted, and no truth class was
 * upgraded to PROVEN. One assertion over every outcome the file collected, rather than one per
 * case, so a case added later cannot escape it. `isolate: true` means the three files cannot
 * share one array, so this runs once per file over that file's entire ledger.
 *
 * BOTH clauses read fields DERIVED from the production value at the ledger's writers. An
 * earlier revision hard-coded `admitted: false` at all three writers and carried no truth class
 * at all, which made this function unable to fail for any mutation whatsoever.
 */
export function assertAdmittedNothing(ledger: Ledger, truthBearing: number): void {
  expect(ledger.entries.length).toBeGreaterThan(0);
  // CLAUSE 1 — nothing was admitted. Mapped to labels rather than filtered to a count, so a
  // breach names the boundary and arm that admitted instead of only its cardinality.
  expect(
    ledger.entries
      .filter((entry) => entry.admitted)
      .map((entry) => `${entry.boundary}#${entry.arm}`),
  ).toEqual([]);
  // CLAUSE 2 — no truth class was upgraded to PROVEN, swept over every outcome this slice
  // collected rather than spot-checked on one case.
  expect(
    ledger.entries
      .filter((entry) => entry.truthClass === "PROVEN")
      .map((entry) => `${entry.boundary}#${entry.arm}`),
  ).toEqual([]);
  // A sweep that silently found nothing to sweep passes while proving nothing, so the count of
  // truth-BEARING outcomes is pinned per slice. A surface that stops reporting its truth class
  // reddens here instead of quietly dropping out of clause 2.
  expect(ledger.entries.filter((entry) => entry.truthClass !== null)).toHaveLength(truthBearing);
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

export function assertMessagesEchoNothing(
  ledger: Ledger,
  secrets: readonly string[],
  /**
   * Boundaries exempt from the PATH patterns only, and never from the digest, base64 or
   * hostile-value checks below. One exemption exists and it is narrow: `scopeFailure` carries
   * the CALLER'S OWN declared path as a field and names it in the message, which is the caller
   * being told which of its declarations was rejected — not provider output leaving a failure
   * path. Every provider-facing boundary is checked with no exemption at all.
   */
  pathExempt: readonly string[] = [],
): void {
  expect(ledger.entries.length).toBeGreaterThan(0);
  const offences: string[] = [];
  for (const entry of ledger.entries) {
    for (const [what, pattern] of ECHO_PATTERNS) {
      const isPathPattern = what.endsWith("path");
      if (isPathPattern && pathExempt.includes(entry.boundary)) continue;
      if (pattern.test(entry.message)) offences.push(`${entry.boundary}#${entry.arm}: ${what}`);
    }
    // The separator-stripped form too. A message that interpolated a path through a layer which
    // ate its backslashes still published it, and the drive-path pattern above would miss that.
    const stripped = entry.message.replaceAll("\\", "");
    for (const secret of secrets) {
      if (
        secret !== "" &&
        (entry.message.includes(secret) || stripped.includes(secret.replaceAll("\\", "")))
      ) {
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
  /** How many of this slice's outcomes REPORT a truth class. Stated per slice rather than
   *  inferred, so the PROVEN sweep cannot go vacuous by a surface quietly dropping the field. */
  truthBearing: number,
  pathExempt: readonly string[] = [],
): void {
  describe(`${group} — completeness and the no-admission invariant`, () => {
    it("sweeps exactly this slice's partition, in BOTH directions, with all three arms", () => {
      assertSweepsExactly(ledger, owned);
    });
    it("records a POSITIVE case count per boundary AND per arm", () => {
      assertPositiveCounts(ledger, owned);
    });
    it("admits nothing and proves nothing: no outcome was admitted or reported PROVEN", () => {
      assertAdmittedNothing(ledger, truthBearing);
    });
    it("echoes nothing: no refusal message carries a path, a digest or a hostile value", () => {
      assertMessagesEchoNothing(ledger, secrets, pathExempt);
    });
  });
}

/**
 * THE COMPLETENESS HOME. Called from exactly ONE slice, so the union check has a single
 * owner. Both directions: the roster's runtime-provider tag equals the union of the three
 * partitions, and no partition names a boundary the roster does not carry.
 */
export function describeRosterCompleteness(): void {
  describe("runtime-provider axis — roster completeness", () => {
    it("partitions exactly the roster's 24 runtime-provider entries, in BOTH directions", () => {
      assertRosterPartition();
    });
  });
}

export function assertRosterPartition(): void {
  const roster = rosterRuntimeProvider();
  // A parse that silently matched nothing would make every set assertion below vacuous.
  expect(roster.length).toBeGreaterThan(0);
  expect(roster).toHaveLength(24);
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
