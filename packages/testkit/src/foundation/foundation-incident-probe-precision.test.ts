/**
 * DEVELOPMENT_ONLY / NOT_CONFIRMATORY precision guard for the six mandatory
 * incident absence probes.
 *
 * `foundation-incident-schedules.ts` states an invariant about itself in its own
 * doc comment: "none of them matches an already-exported runtime name, so every
 * probe starts absent for a real reason rather than because its pattern was
 * chosen to miss." That sentence was aspirational, and it silently went false
 * three times — a bare `Distribution|DISTRIBUTION` matches, by construction,
 * every symbol a task publishing distribution vocabulary is REQUIRED to export,
 * so a correct landing turned a mandatory gate red with no owned-path fix.
 *
 * This file makes the sentence mechanical, from both directions at once:
 *
 * 1. NOT TOO BROAD — every probe pattern is evaluated against the CURRENT root
 *    exports of its real package. Re-broadening a pattern fails here.
 * 2. NOT TOO NARROW — every probe still fires on plausible near-miss renames of
 *    its own capability, through the PATTERN alone. A pattern narrowed to an
 *    exact literal would satisfy (1) and every fault-lane gate while quietly
 *    retiring the anti-gaming property the broad pattern existed for. That
 *    failure mode is worse than the bug this file repairs, because it is silent.
 *
 * Both assert through `evaluateAbsenceProbe`, the same production evaluator the
 * fault harness routes `produceAbsenceOutcome` through, so neither property can
 * drift onto a re-implemented matcher that agrees with nothing but itself.
 *
 * ONE DELIBERATE TENSION, stated so it is not mistaken for an oversight. The
 * foundation MODULES import `@moe/contracts` and nothing else; the landed core,
 * store and scheduler reach them only through injected ports, and this file is
 * the first thing under `src/foundation` to read a production barrel directly.
 * That seam keeps the shipped testkit free of production dependencies, and it
 * still does: this is a `.test.ts`, it resolves by relative path rather than by
 * package specifier, so no manifest dependency edge and no shipped import is
 * created. The alternative — a hand-supplied name list — is exactly the stale
 * hand-maintained mirror whose drift caused the defect this file repairs.
 */

import { describe, expect, it } from "vitest";

import { exportNames } from "./foundation-fakes.js";
import { FOUNDATION_INCIDENT_PROBES } from "./foundation-incident-schedules.js";
import { evaluateAbsenceProbe } from "./foundation-outcomes-fixtures.js";

/** Hand-written, not derived: a probe silently dropped must fail, not shrink the sweep. */
const EXPECTED_PROBE_COUNT = 6;

/** Floor per package. A surface that resolves empty would make every probe vacuously absent. */
const MINIMUM_ROOT_EXPORTS = 40;
const LIVE_EXPORT_PROBE_TIMEOUT_MS = 20_000;

/**
 * The repository directory behind each probed package name. The probe is
 * evaluated against a package's PUBLIC RUNTIME EXPORTS — `Object.keys` of the
 * imported namespace, exactly as `LIVE_EXPORT_SURFACES` in the fault harness
 * builds them — so `export type` names are correctly invisible here: a type
 * cannot appear in a namespace object and can never fire a probe.
 */
const PROBED_PACKAGE_DIRECTORIES: Readonly<Record<string, string>> = Object.freeze({
  "@moe/contracts": "contracts",
  "@moe/core": "core",
  "@moe/scheduler": "scheduler",
});

/**
 * Import the real barrel and read its runtime names.
 *
 * The specifier is assembled at runtime deliberately. A literal one would make
 * the production barrel an input of `packages/testkit/tsconfig.json`, whose
 * `rootDir` is `src`, and `tsc` would refuse it with TS6059. Reading the export
 * list out of the barrel's TEXT instead was rejected: `packages/core/src/index.ts`
 * ends in `export * from "./identity/index.js"`, which no text scan can resolve,
 * and a hand-rolled parser is precisely the re-implemented proxy that detaches
 * from the property it claims to check.
 */
async function liveExportNames(packageName: string): Promise<readonly string[]> {
  const directory = PROBED_PACKAGE_DIRECTORIES[packageName];
  if (directory === undefined) {
    throw new ReferenceError(`No repository directory registered for ${packageName}`);
  }
  const specifier = ["..", "..", "..", directory, "src", "index.js"].join("/");
  const namespace = (await import(specifier)) as Readonly<Record<string, unknown>>;
  return exportNames(namespace);
}

/**
 * Plausible renames of each probe's OWN capability. Every one must still fire
 * its probe: these are the shapes a near-miss rename would actually take —
 * camelCase, PascalCase, snake_case, SCREAMING_SNAKE, and prefixed or suffixed
 * variants — and none of them is a declared `absentExportNames` entry, so only
 * the pattern can answer.
 */
const NEAR_MISS_RENAMES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "probe:contracts-distribution-handshake": Object.freeze([
    "verify_distribution_manifest", "VerifyDistributionManifest", "checkDistributionCompat",
    "VERIFY_DISTRIBUTION_MANIFEST", "validateDistributionHandshake",
    "refuseStaleDistributionHandshake", "DISTRIBUTION_HANDSHAKE_REFUSALS",
    "distribution_compat_result",
  ]),
  "probe:core-release-handoff": Object.freeze([
    "release_with_handoff", "ReleaseWithHandoff", "releaseHandoff", "reduceWorkHandoffAtomic",
    "WORK_HANDOFF_TRANSITIONS", "HandoffTransitionKind", "handoff_transition_kinds",
  ]),
  "probe:core-review-assignment": Object.freeze([
    "reduceReviewAssignment", "REVIEW_ASSIGNMENT_TRANSITIONS", "assignReviewer", "reassignReview",
  ]),
  "probe:core-terminal-release": Object.freeze([
    "reduceWorkReleaseCommand", "WORK_RELEASE_TRANSITIONS", "releaseTerminalWorkItem",
    "applyReleaseTerminal", "TERMINAL_RELEASE_KINDS",
  ]),
  "probe:scheduler-hot-claim-admission": Object.freeze([
    "admit_claim", "AdmitClaim", "claimWork", "admitClaimRequest", "hotClaimAdmission",
    "ADMIT_CLAIM_REASONS", "reduce_claim", "CLAIM_WORK_TRANSITIONS",
  ]),
  "probe:scheduler-timer-reentrancy": Object.freeze([
    "reduceTimerCallback", "TIMER_TRANSITIONS", "scheduleTimer", "reacquireTimerLease",
  ]),
});

function renamesFor(probeRef: string): readonly string[] {
  const renames = NEAR_MISS_RENAMES[probeRef];
  if (renames === undefined) {
    throw new ReferenceError(`No near-miss renames declared for ${probeRef}`);
  }
  return renames;
}

describe("foundation incident probes are enumerable and patterned", () => {
  it("carries exactly the six mandatory incident probes, each with a pattern", () => {
    expect(FOUNDATION_INCIDENT_PROBES.length).toBe(EXPECTED_PROBE_COUNT);
    for (const probe of FOUNDATION_INCIDENT_PROBES) {
      const pattern = probe.absentExportPattern;
      expect(pattern, probe.probeRef).not.toBeNull();
      expect(probe.absentExportNames.length, probe.probeRef).toBeGreaterThan(0);
      expect(PROBED_PACKAGE_DIRECTORIES[probe.packageName], probe.probeRef).toBeDefined();
      if (pattern === null) continue;
      // The narrowed patterns are written as multi-line string concatenations,
      // so a bad seam edit can leave a stray space or an unbalanced group. A
      // dropped "|" is NOT caught here — it stays whitespace-free and compiles;
      // the near-miss suite below is what reddens for that.
      expect(/\s/u.test(pattern), probe.probeRef).toBe(false);
      expect(() => new RegExp(pattern, "u"), probe.probeRef).not.toThrow();
    }
  });

  it("declares near-miss renames for every probe, none of them a declared name", () => {
    expect(Object.keys(NEAR_MISS_RENAMES).sort())
      .toEqual([...FOUNDATION_INCIDENT_PROBES].map((probe) => probe.probeRef).sort());
    for (const probe of FOUNDATION_INCIDENT_PROBES) {
      const renames = renamesFor(probe.probeRef);
      expect(renames.length, probe.probeRef).toBeGreaterThanOrEqual(4);
      for (const rename of renames) {
        expect(probe.absentExportNames, `${probe.probeRef} ${rename}`).not.toContain(rename);
      }
    }
  });
});

describe("foundation incident probe patterns discriminate from published names", () => {
  it("resolves a non-empty runtime export surface for every probed package", async () => {
    const packageNames = Object.keys(PROBED_PACKAGE_DIRECTORIES).sort();
    expect(packageNames).toEqual(["@moe/contracts", "@moe/core", "@moe/scheduler"]);
    for (const packageName of packageNames) {
      const names = await liveExportNames(packageName);
      expect(names.length, packageName).toBeGreaterThanOrEqual(MINIMUM_ROOT_EXPORTS);
      expect(new Set(names).size, packageName).toBe(names.length);
    }
  }, LIVE_EXPORT_PROBE_TIMEOUT_MS);

  it("leaves every probe ABSENT against its package's current root exports", async () => {
    const collisions: string[] = [];
    for (const probe of FOUNDATION_INCIDENT_PROBES) {
      const names = await liveExportNames(probe.packageName);
      expect(names.length, probe.probeRef).toBeGreaterThanOrEqual(MINIMUM_ROOT_EXPORTS);
      const result = evaluateAbsenceProbe(probe, names);
      if (!result.absent) {
        collisions.push(`${probe.probeRef} matches ${result.presentExportNames.join(", ")}`);
      }
    }
    expect(collisions).toEqual([]);
  }, LIVE_EXPORT_PROBE_TIMEOUT_MS);
});

describe("foundation incident probe patterns still catch a near-miss rename", () => {
  it("fires on every declared near-miss rename, through the pattern alone", () => {
    for (const probe of FOUNDATION_INCIDENT_PROBES) {
      for (const rename of renamesFor(probe.probeRef)) {
        expect(evaluateAbsenceProbe(probe, ["unrelatedExport", rename]), `${probe.probeRef} ${rename}`)
          .toEqual({ absent: false, presentExportNames: [rename] });
      }
    }
  });

  it("stays ABSENT on an export set with no near-miss in it, so the guard can fail", () => {
    for (const probe of FOUNDATION_INCIDENT_PROBES) {
      expect(evaluateAbsenceProbe(probe, ["unrelatedExport"]), probe.probeRef)
        .toEqual({ absent: true });
    }
  });
});
