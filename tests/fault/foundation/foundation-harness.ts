/**
 * DEVELOPMENT_ONLY / NOT_CONFIRMATORY shared harness for the foundation fault
 * tests.
 *
 * This lives under tests/, not under packages/testkit, for one reason: it is
 * the only place allowed to import production packages. The testkit foundation
 * modules import `@moe/contracts` and nothing else, so everything they need
 * from @moe/core, @moe/store and @moe/scheduler arrives through here.
 *
 * Nothing under tests/ is typechecked, so every guarantee in this file is a
 * runtime assertion rather than a type.
 */

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

/** The real, live export surfaces the probes are evaluated against. */
export const LIVE_EXPORT_SURFACES = {
  "@moe/contracts": exportNames(contracts),
  "@moe/core": exportNames(core),
  "@moe/scheduler": exportNames(scheduler),
  "@moe/store": exportNames(store),
};

export { contracts, core, scheduler, store };

export function fixtureById(fixtureId) {
  const found = FOUNDATION_FIXTURES.find((candidate) => candidate.fixtureId === fixtureId);
  if (found === undefined) {
    throw new ReferenceError(`No foundation fixture named ${fixtureId}`);
  }
  return found;
}

export function probeByRef(probeRef) {
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
export function produceAbsenceOutcome(entry) {
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

/** Map a model verdict onto the outcome vocabulary. Refusals become EXPECTED_RED. */
export function outcomeFromVerdict(verdict) {
  return verdict.ok === true ? passExpected() : expectedRed(verdict.refusal);
}

/**
 * Assert that the executors a fault-test file declares are exactly its manifest
 * partition. Combined with the spec test's partition-completeness assertion,
 * no manifest entry can be quietly dropped from the suite.
 */
export function assertPartitionOwnership(expect, partition, executors, expectedSize) {
  expect(partition.length).toBe(expectedSize);
  expect(Object.keys(executors).sort()).toEqual(
    partition.map((entry) => entry.entryId).sort(),
  );
}

/** The `it.each` rows for one partition: [entryId, entry]. */
export function partitionRows(partition) {
  return partition.map((entry) => [entry.entryId, entry]);
}
