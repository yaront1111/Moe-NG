import { grantSuccessorCapacity } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, cleanupRestoreHarnesses } from "../recovery/restore-test-harness.js";
import {
  ATTEMPT_RESOURCE_APPLY_COMMAND_KIND, ATTEMPT_RESOURCE_BIND_COMMAND_KIND,
  ATTEMPT_RESOURCE_BOUND_EVENT_TYPE, ATTEMPT_RESOURCE_CODES,
  ATTEMPT_RESOURCE_RECORD_VERSION, ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE,
  DAEMON_ATTEMPT_RESOURCE, SCHEDULER_RESOURCE_AUTHORITY, deriveAttemptResourceAggregateId,
} from "./attempt-resource-authority-contracts.js";
import type { AttemptResourceOutcome } from "./attempt-resource-authority-contracts.js";
import { bindAttemptResources, readAttemptResources } from "./attempt-resource-authority.js";
import {
  ACTIVATION_AGGREGATE, canonicalBytes, cleanRows, duplicateRows, failableRows,
  openUnactivatedResourceFixture, plantResourceEvent, resourceBody, resourceRow,
} from "./attempt-resource-test-harness.js";
import type { ResourceFixture } from "./attempt-resource-test-harness.js";

/**
 * The durable per-attempt resource authority, over a REAL SqliteEventStore that
 * holds NO ACTIVATION — because production cannot currently mint one.
 *
 * WHY THE SUCCESSFUL-BIND CASES ARE GONE RATHER THAN RE-PLUMBED. `bindAttemptResources`
 * reads the activation through `durableActivation` before it admits a single row, and the
 * only non-test writer of a committed `ActivationLedgerRecord` is `activation-ingress-commit.ts`
 * below the real `effect.activate` gates. While policy cannot authoritatively ALLOW, no
 * honest route reaches a bound set from this suite. Governor ruling
 * comment-937524c83a1945a5afae3ed8ac2405b9 forbids manufacturing that state "by any name"
 * and directs a suite in this position to change WHAT it asserts rather than HOW it builds.
 * So this file asserts the state production CAN reach: activation authority is demanded
 * FIRST, unconditionally, and nothing durable is written when it is missing.
 *
 * THAT CLAIM IS NOT VACUOUS, and the matrix below is built to keep it that way. Every row
 * variant is ALSO run through the scheduler's own `grantSuccessorCapacity`, and the cases
 * are chosen so that reducer answers three DIFFERENT ways across them — accepted, refused
 * with AUTHORITY_MALFORMED_INPUT, refused with AUTHORITY_STALE_LEASE — and the expected
 * three are asserted as an exact set, not a count. A binder that admitted rows before
 * reading the activation would therefore have to answer differently per case, and the
 * single-triple assertion below would redden.
 *
 * RETIRED WITH THIS MIGRATION, recorded here so no reader mistakes the gap for coverage:
 * the accepted-bind, verbatim-field, member-duplicate, set-not-active, quarantined-set and
 * foreign-project cases, plus the whole "the production ingress binds" block. The pure
 * grant/duplicate/quarantine semantics they leaned on are directly covered by
 * packages/scheduler/src/authority/lease-resource.test.ts; genuine `effect.activate`
 * ingress coverage belongs to task-3a3d53fce0504c46b1d78f7e24f259cf.
 */

afterEach(cleanupRestoreHarnesses);

const RESOURCE_AGGREGATE = deriveAttemptResourceAggregateId(ACTIVATION_AGGREGATE);

const resourceEvents = (store: SqliteEventStore): number =>
  store.readEvents(RESOURCE_AGGREGATE).length;

/** The exact refusal a bind owes while the activation aggregate holds nothing:
 *  this module's own code, this module's own layer, and the READER's code kept as
 *  the upstream rather than flattened into a generic failure. */
const ACTIVATION_ABSENT = Object.freeze({
  authority: "NONE", code: "ATTEMPT_RESOURCE_ACTIVATION_UNREADABLE",
  refusedBy: DAEMON_ATTEMPT_RESOURCE, upstreamCode: "FOUNDATION_BINDING_NOT_FOUND",
});

function refusalOf(outcome: AttemptResourceOutcome): {
  authority: string; code: string; refusedBy: string; upstreamCode: string | null;
} {
  if (outcome.ok) throw new Error("expected a refusal, received a bound resource set");
  return {
    authority: outcome.authority, code: outcome.code, refusedBy: outcome.refusedBy,
    upstreamCode: outcome.upstreamCode,
  };
}

/** Read through the module's OWN reader, so a row written and then refused
 *  cannot hide behind a return value. */
function expectNoDurableSet(fixture: ResourceFixture): void {
  expect(resourceEvents(fixture.store)).toBe(0);
  expect(refusalOf(readAttemptResources(
    fixture.store, ACTIVATION_AGGREGATE, fixture.binding.projectId,
  ))).toEqual({
    authority: "NONE", code: "ATTEMPT_RESOURCE_RECORD_ABSENT",
    refusedBy: DAEMON_ATTEMPT_RESOURCE, upstreamCode: null,
  });
}

describe("attempt resource authority — frozen vocabulary", () => {
  it("publishes a closed code list with no duplicate member", () => {
    expect(ATTEMPT_RESOURCE_CODES.length).toBeGreaterThan(0);
    expect(new Set(ATTEMPT_RESOURCE_CODES).size).toBe(ATTEMPT_RESOURCE_CODES.length);
    expect([...ATTEMPT_RESOURCE_CODES].sort()).toEqual([
      "ATTEMPT_RESOURCE_ACTIVATION_UNREADABLE", "ATTEMPT_RESOURCE_BINDING_MISMATCH",
      "ATTEMPT_RESOURCE_COMMIT_UNAVAILABLE", "ATTEMPT_RESOURCE_MEMBERSHIP_CHANGED",
      "ATTEMPT_RESOURCE_MEMBER_DUPLICATE", "ATTEMPT_RESOURCE_PROJECT_MISMATCH",
      "ATTEMPT_RESOURCE_RECORD_ABSENT", "ATTEMPT_RESOURCE_RECORD_AMBIGUOUS",
      "ATTEMPT_RESOURCE_RECORD_MALFORMED", "ATTEMPT_RESOURCE_RECORD_UNREADABLE",
      "ATTEMPT_RESOURCE_SET_NOT_ACTIVE", "ATTEMPT_RESOURCE_SET_REFUSED",
    ].sort());
  });

  it("keeps ABSENT, UNREADABLE, MALFORMED and AMBIGUOUS four distinct codes", () => {
    const readerCodes = ATTEMPT_RESOURCE_CODES.filter((code) => code.startsWith(
      "ATTEMPT_RESOURCE_RECORD_"));
    expect([...readerCodes].sort()).toEqual([
      "ATTEMPT_RESOURCE_RECORD_ABSENT", "ATTEMPT_RESOURCE_RECORD_AMBIGUOUS",
      "ATTEMPT_RESOURCE_RECORD_MALFORMED", "ATTEMPT_RESOURCE_RECORD_UNREADABLE",
    ]);
  });

  it("names its own layer, disjoint from the scheduler's and the sibling's", () => {
    expect(DAEMON_ATTEMPT_RESOURCE).toBe("DAEMON_ATTEMPT_RESOURCE");
    expect(SCHEDULER_RESOURCE_AUTHORITY).toBe("SCHEDULER_RESOURCE_AUTHORITY");
    expect(DAEMON_ATTEMPT_RESOURCE).not.toBe(SCHEDULER_RESOURCE_AUTHORITY);
    expect(DAEMON_ATTEMPT_RESOURCE).not.toBe("DAEMON_ATTEMPT_RELEASE");
    expect([
      ATTEMPT_RESOURCE_RECORD_VERSION, ATTEMPT_RESOURCE_BOUND_EVENT_TYPE,
      ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE, ATTEMPT_RESOURCE_BIND_COMMAND_KIND,
      ATTEMPT_RESOURCE_APPLY_COMMAND_KIND,
    ]).toEqual([
      "moe-attempt-resource-set/1", "AttemptResourcesBound", "AttemptResourceTransitioned",
      "work.attempt_resources_bind", "work.attempt_resources_apply",
    ]);
  });

  it("derives a resource aggregate distinct from the activation it reads", () => {
    expect(RESOURCE_AGGREGATE).not.toBe(ACTIVATION_AGGREGATE);
    expect(RESOURCE_AGGREGATE).toBe(deriveAttemptResourceAggregateId(ACTIVATION_AGGREGATE));
    expect(RESOURCE_AGGREGATE).not.toBe(
      deriveAttemptResourceAggregateId(`${ACTIVATION_AGGREGATE}x`));
  });
});

/**
 * WHAT THE FIXTURE IS, asserted rather than described. The migration is only
 * honest if the replacement world really carries no upstream authority, so the
 * emptiness is MEASURED store-wide — not per aggregate, which would miss a policy
 * or budget aggregate whose id this file never names.
 */
describe("attempt resource authority — the unactivated fixture carries no authority", () => {
  it("opens a store holding no event of any kind, on any aggregate", () => {
    const fixture = openUnactivatedResourceFixture("empty-world");
    expect(fixture.store.readEventHorizon()).toBe(0n);
    expect(fixture.store.readEventsAfter(0n, 100).items).toEqual([]);
    expect(fixture.store.readEvents(ACTIVATION_AGGREGATE)).toEqual([]);
    expect(resourceEvents(fixture.store)).toBe(0);
    // POSITIVE CONTROL: the emptiness above is a real measurement, not a method
    // that answers zero regardless. One planted event moves both readings.
    plantResourceEvent(fixture.store, ATTEMPT_RESOURCE_BOUND_EVENT_TYPE,
      canonicalBytes(resourceBody()), 0, "empty-world-control");
    expect(fixture.store.readEventHorizon()).not.toBe(0n);
    expect(fixture.store.readEventsAfter(0n, 100).items).toHaveLength(1);
  });

  it("binds a project and activation identity without committing either", () => {
    const fixture = openUnactivatedResourceFixture("identity");
    // The identities the retired fixture used to obtain from a COMMITTED
    // activation are still the ones under test; only their durability is gone.
    expect(fixture.binding.projectId).toBe(PROJECT_ID);
    expect(fixture.binding.activationAggregateId).toBe(ACTIVATION_AGGREGATE);
    expect(fixture.binding.commandId).toBe("cmd-direct-identity");
  });
});

interface BindCase {
  readonly label: string;
  readonly rows: unknown;
  /** How the SCHEDULER's own reducer answers these same rows. `null` would mean it
   *  THREW; measured at this tree it never does, even for a revoked proxy, so a
   *  null here is a real regression rather than an expected shape. */
  readonly reducerCode: string | null;
}

/** Built from escapes, never from source literals: a combining mark can be folded
 *  in transit, and a decomposed/composed pair that arrived byte-identical would
 *  make the preservation case compare a value against itself. */
const DECOMPOSED_ID = "res-e\u0301";

const nonNfcRows = (): unknown[] => {
  const rows = cleanRows();
  rows[1] = resourceRow(DECOMPOSED_ID);
  return rows;
};

const revokedRows = (): unknown => {
  const revocable = Proxy.revocable(cleanRows(), {});
  revocable.revoke();
  return revocable.proxy;
};

/**
 * GENERATED, and its size and membership are asserted before any outcome is: a
 * matrix that silently produced zero cases would pass while testing nothing.
 */
function bindCases(): readonly BindCase[] {
  const notActive = cleanRows();
  notActive[2] = resourceRow("res-3", { external: true, state: "PENDING_ACQUIRE" });
  const quarantined = cleanRows();
  quarantined[0] = resourceRow("res-1", { state: "QUARANTINED" });
  const undecodable = cleanRows();
  undecodable[1] = resourceRow("res-2", { epoch: -1 });
  return [
    { label: "clean", reducerCode: "ACCEPTED", rows: cleanRows() },
    { label: "failable", reducerCode: "ACCEPTED", rows: failableRows() },
    { label: "duplicate-id", reducerCode: "ACCEPTED", rows: duplicateRows() },
    { label: "non-nfc-id", reducerCode: "ACCEPTED", rows: nonNfcRows() },
    { label: "not-active", reducerCode: "ACCEPTED", rows: notActive },
    { label: "quarantined", reducerCode: "AUTHORITY_STALE_LEASE", rows: quarantined },
    { label: "undecodable-epoch", reducerCode: "AUTHORITY_MALFORMED_INPUT", rows: undecodable },
    { label: "empty", reducerCode: "AUTHORITY_MALFORMED_INPUT", rows: [] },
    { label: "rows-null", reducerCode: "AUTHORITY_MALFORMED_INPUT", rows: null },
    // MEASURED, not assumed: reflection on a revoked proxy throws, but the
    // scheduler contains it and answers AUTHORITY_MALFORMED_INPUT. Production's
    // `runReducer` catch is the backstop behind that, not the first line.
    { label: "revoked-proxy", reducerCode: "AUTHORITY_MALFORMED_INPUT", rows: revokedRows() },
  ];
}

const REQUIRED_BIND_LABELS: readonly string[] = [
  "clean", "duplicate-id", "failable", "non-nfc-id", "not-active", "quarantined",
  "undecodable-epoch", "empty", "rows-null", "revoked-proxy",
];

/** The scheduler's own answer for these rows, so the matrix below can prove the
 *  activation gate spoke FIRST rather than the rows happening to be acceptable. */
function reducerAnswer(rows: unknown): string | null {
  let outcome: ReturnType<typeof grantSuccessorCapacity>;
  try { outcome = grantSuccessorCapacity(rows, null); }
  catch { return null; }
  return outcome.ok ? "ACCEPTED" : outcome.issues[0]?.code ?? "REFUSED";
}

describe("attempt resource authority — activation authority is demanded first", () => {
  it("generates a matrix whose reducer answers genuinely differ", () => {
    const cases = bindCases();
    const labels = cases.map((testCase) => testCase.label);
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(new Set(labels).size).toBe(cases.length);
    expect(REQUIRED_BIND_LABELS.filter((label) => !labels.includes(label))).toEqual([]);
    // THE DISCRIMINATOR. Each declared reducer answer is verified against the
    // production reducer, and the set of distinct answers is checked to be wider
    // than one. A binder that admitted rows before reading the activation could
    // not answer these ten cases with a single triple.
    for (const testCase of cases) {
      expect([testCase.label, reducerAnswer(testCase.rows)])
        .toEqual([testCase.label, testCase.reducerCode]);
    }
    // The EXACT set, not a count: a matrix that lost its accepted cases or its
    // second refusal code would still satisfy a floor.
    expect(new Set(cases.map((testCase) => testCase.reducerCode))).toEqual(
      new Set(["ACCEPTED", "AUTHORITY_MALFORMED_INPUT", "AUTHORITY_STALE_LEASE"]));
  });

  for (const testCase of bindCases()) {
    it(`refuses a ${testCase.label} bind before admitting a row, and writes nothing`, () => {
      const fixture = openUnactivatedResourceFixture(`bind-${testCase.label}`);
      // A CRASH IS NOT A REFUSAL: the revoked-proxy case would throw inside the
      // reducer, so a decision has to come back rather than an exception.
      const outcome = bindAttemptResources(fixture.store, fixture.binding, testCase.rows);
      expect([testCase.label, refusalOf(outcome)]).toEqual([testCase.label, ACTIVATION_ABSENT]);
      expectNoDurableSet(fixture);
    });
  }

  it("refuses just as absolutely when the binding names another activation entirely", () => {
    const fixture = openUnactivatedResourceFixture("elsewhere");
    const binding = { ...fixture.binding, activationAggregateId: "activation-nowhere" };
    expect(refusalOf(bindAttemptResources(fixture.store, binding, cleanRows())))
      .toEqual(ACTIVATION_ABSENT);
    expect(fixture.store.readEvents(
      deriveAttemptResourceAggregateId("activation-nowhere"))).toHaveLength(0);
  });

  it("reports the STORE's own failure as a null upstream, not as a missing binding", () => {
    // The two branches of the activation read are distinguishable and stay so: a
    // closed handle throws before any reader is consulted, so there is no upstream
    // reader code to preserve, and folding it into FOUNDATION_BINDING_NOT_FOUND
    // would report a broken store as an absent activation.
    const fixture = openUnactivatedResourceFixture("closed");
    fixture.store.close();
    expect(refusalOf(bindAttemptResources(fixture.store, fixture.binding, cleanRows()))).toEqual({
      authority: "NONE", code: "ATTEMPT_RESOURCE_ACTIVATION_UNREADABLE",
      refusedBy: DAEMON_ATTEMPT_RESOURCE, upstreamCode: null,
    });
  });
});

describe("attempt resource authority — the duplicate rule is this module's own", () => {
  it("shows the reducer ADMITS duplicate ids, so the daemon check has to exist", () => {
    // Run against the production reducer, not restated as a literal. This is the
    // control that keeps ATTEMPT_RESOURCE_MEMBER_DUPLICATE meaningful now that no
    // bind can reach it: the scheduler hands back three rows carrying two distinct
    // ids, so a consumer folding by resourceId would see a member vanish.
    const admitted = grantSuccessorCapacity(duplicateRows(), null);
    if (!admitted.ok) throw new Error("the reducer was expected to admit duplicates");
    expect(admitted.value.rows).toHaveLength(3);
    expect(new Set(admitted.value.rows.map((row) => row.resourceId)).size).toBe(2);
    // The daemon owns the code that refuses it, and still publishes it.
    expect(ATTEMPT_RESOURCE_CODES).toContain("ATTEMPT_RESOURCE_MEMBER_DUPLICATE");
  });
});
