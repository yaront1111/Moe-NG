/**
 * DEVELOPMENT_ONLY / NOT_CONFIRMATORY shared harness for the foundation fault
 * tests.
 *
 * This lives under tests/, not under packages/testkit, for one reason: it is
 * the only place allowed to import production packages. The testkit foundation
 * modules import `@moe/contracts` and nothing else, so everything they need
 * from @moe/core, @moe/store and @moe/scheduler arrives through here.
 *
 * `tests/fault/foundation/tsconfig.json` puts this directory under the shared
 * strict base, so the guarantees below are types as well as runtime assertions.
 * That tsconfig is not optional decoration: QA found that nothing in the repo
 * typechecked or executed this directory, and the coverage ratchet in
 * `packages/testkit/src/foundation/foundation-gate-coverage.test.ts` now fails
 * if either ever stops being true.
 */

import { expect } from "vitest";

import * as contracts from "../../../packages/contracts/src/index.js";
import * as core from "../../../packages/core/src/index.js";
import * as scheduler from "../../../packages/scheduler/src/index.js";
import * as store from "../../../packages/store/src/index.js";
import { exportNames } from "../../../packages/testkit/src/foundation/foundation-fakes.js";
import { FOUNDATION_FIXTURES } from "../../../packages/testkit/src/foundation/foundation-journey-fixtures.js";
import { FOUNDATION_ABSENCE_PROBES } from "../../../packages/testkit/src/foundation/foundation-fault-schedule.js";
import {
  evaluateAbsenceProbe,
  expectedRed,
  passExpected,
  productionBehaviorAbsent,
} from "../../../packages/testkit/src/foundation/foundation-outcomes-fixtures.js";
import type {
  FoundationAbsenceProbe,
  FoundationFixture,
  FoundationManifestEntry,
  FoundationOutcome,
} from "../../../packages/testkit/src/foundation/foundation-outcomes-fixtures.js";

/** The real, live export surfaces the probes are evaluated against. */
export const LIVE_EXPORT_SURFACES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "@moe/contracts": exportNames(contracts),
  "@moe/core": exportNames(core),
  "@moe/scheduler": exportNames(scheduler),
  "@moe/store": exportNames(store),
});

export { contracts, core, scheduler, store };

/** Every held-out model verdict: accepted, or refused with a named refusal. */
export type RefusableVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: string };

/** The accepted/refused shape the landed reducers and decoders share. */
export type OkOrRefused =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: { readonly code: string } };

/** One manifest entry's executor. Its return value is compared with the declared outcome. */
export type FoundationExecutor = (entry: FoundationManifestEntry) => FoundationOutcome;
export type FoundationExecutors = Readonly<Record<string, FoundationExecutor>>;

export function fixtureById(fixtureId: string): FoundationFixture {
  const found = FOUNDATION_FIXTURES.find((candidate) => candidate.fixtureId === fixtureId);
  if (found === undefined) {
    throw new ReferenceError(`No foundation fixture named ${fixtureId}`);
  }
  return found;
}

/**
 * The typed payload of a registered fixture.
 *
 * `FoundationFixture.payload` is `unknown` by design — one manifest carries
 * three journeys' shapes. The caller passes the typed constant the fixture was
 * built from and this asserts they are the same object, so the fixture stays
 * the source of registration and the constant the source of the type. No cast,
 * and a fixture rebuilt from different data fails loudly instead of silently.
 */
export function fixturePayload<TPayload>(fixtureId: string, payload: TPayload): TPayload {
  if (fixtureById(fixtureId).payload !== payload) {
    throw new TypeError(`Fixture ${fixtureId} does not carry the payload passed for it`);
  }
  return payload;
}

export function probeByRef(probeRef: string): FoundationAbsenceProbe {
  const found = FOUNDATION_ABSENCE_PROBES.find((candidate) => candidate.probeRef === probeRef);
  if (found === undefined) {
    throw new ReferenceError(`No foundation probe named ${probeRef}`);
  }
  return found;
}

/**
 * Produce the outcome an ABSENT entry deserves RIGHT NOW.
 *
 * This is the ratchet. It never echoes the declared outcome: it evaluates the
 * probe against the package's live export names and returns PASS_EXPECTED the
 * moment the surface exists. A landing surface therefore turns the schedule red
 * against its declared PRODUCTION_BEHAVIOR_ABSENT and forces the manifest to be
 * updated, instead of the entry rotting into false evidence.
 */
export function produceAbsenceOutcome(entry: FoundationManifestEntry): FoundationOutcome {
  if (entry.outcome.kind !== "PRODUCTION_BEHAVIOR_ABSENT") {
    throw new TypeError(`${entry.entryId} is ${entry.outcome.kind}, not a probed absence`);
  }
  const probe = probeByRef(entry.outcome.probeRef);
  const names = LIVE_EXPORT_SURFACES[probe.packageName];
  if (names === undefined) {
    throw new ReferenceError(`No live export surface for ${probe.packageName}`);
  }
  const result = evaluateAbsenceProbe(probe, names);
  return result.absent
    ? productionBehaviorAbsent(entry.outcome.missingSurface, probe.probeRef)
    : passExpected();
}

/**
 * The missing-evidence string of an entry that declared HONEST_UNKNOWN.
 *
 * Same discipline as `produceAbsenceOutcome`: routing an entry of any other
 * kind here is a bug in the executor map, not a reason to fall back to a pass.
 */
export function missingEvidenceOf(entry: FoundationManifestEntry): string {
  if (entry.outcome.kind !== "HONEST_UNKNOWN") {
    throw new TypeError(`${entry.entryId} is ${entry.outcome.kind}, not an honest unknown`);
  }
  return entry.outcome.missingEvidence;
}

/** Map a model verdict onto the outcome vocabulary. Refusals become EXPECTED_RED. */
export function outcomeFromVerdict(verdict: RefusableVerdict): FoundationOutcome {
  return verdict.ok === true ? passExpected() : expectedRed(verdict.refusal);
}

function refusalCodeOf(result: OkOrRefused): string {
  return result.ok === true ? "nothing" : result.error.code;
}

/**
 * Narrow a landed reducer or decoder result to its accepted branch.
 *
 * The cast follows a runtime discriminant check, so it removes no guarantee:
 * `Extract` keeps the caller's own result type, which is what makes the typed
 * `state`/`envelope` access below it real rather than an `any` escape hatch.
 */
export function accepted<TResult extends OkOrRefused>(
  result: TResult,
  label: string,
): Extract<TResult, { readonly ok: true }> {
  if (result.ok !== true) {
    throw new Error(`${label} was refused with ${refusalCodeOf(result)}`);
  }
  return result as Extract<TResult, { readonly ok: true }>;
}

/** The mirror of `accepted`: a schedule that requires a refusal must get one. */
export function refused<TResult extends OkOrRefused>(
  result: TResult,
  label: string,
): Extract<TResult, { readonly ok: false }> {
  if (result.ok === true) {
    throw new Error(`${label} was accepted, but the schedule requires a refusal`);
  }
  return result as Extract<TResult, { readonly ok: false }>;
}

export function executorFor(
  executors: FoundationExecutors,
  entryId: string,
): FoundationExecutor {
  const found = executors[entryId];
  if (found === undefined) {
    throw new ReferenceError(`No executor for manifest entry ${entryId}`);
  }
  return found;
}

/**
 * Assert that the executors a fault-test file declares are exactly its manifest
 * partition. Combined with the spec test's partition-completeness assertion,
 * no manifest entry can be quietly dropped from the suite.
 */
export function assertPartitionOwnership(
  partition: readonly FoundationManifestEntry[],
  executors: FoundationExecutors,
  expectedSize: number,
): void {
  expect(partition.length).toBe(expectedSize);
  expect(Object.keys(executors).sort()).toEqual(
    partition.map((entry) => entry.entryId).sort(),
  );
}

/** The `it.each` rows for one partition: [entryId, entry]. */
export function partitionRows(
  partition: readonly FoundationManifestEntry[],
): [string, FoundationManifestEntry][] {
  return partition.map((entry) => [entry.entryId, entry]);
}
