import { adapterConfirm, adapterFail, grantSuccessorCapacity } from "@moe/scheduler";
import type { AcquisitionSet } from "@moe/scheduler";
import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, cleanupRestoreHarnesses } from "../recovery/restore-test-harness.js";
import {
  DAEMON_ATTEMPT_RESOURCE, SCHEDULER_RESOURCE_AUTHORITY, deriveAttemptResourceAggregateId,
} from "./attempt-resource-authority-contracts.js";
import type {
  AttemptResourceMember, AttemptResourceOutcome, AttemptResourceReport,
} from "./attempt-resource-authority-contracts.js";
import {
  applyAttemptResourceReport, bindAttemptResources, readAttemptResources,
} from "./attempt-resource-authority.js";
import {
  ACTIVATION_AGGREGATE, activatedWith, duplicateRows, failableRows,
} from "./attempt-resource-test-harness.js";
import type { ResourceFixture } from "./attempt-resource-test-harness.js";

/**
 * The TRANSITION arm.
 *
 * NO EXPECTED STATE IN THIS FILE IS HAND-WRITTEN. Each case computes what it
 * expects by running the SAME public reducer over the SAME durable members and
 * comparing against those returned rows, because a test whose both operands are
 * hand-written string literals is a tautology: it would stay green if the applier
 * re-derived the states itself, which is exactly the defect the epic forbids.
 *
 * Every reducer comparison is guarded against being vacuous: `statesOf` results
 * are checked to contain MORE THAN ONE distinct state before being compared, so
 * a reducer that collapsed the whole set to one value could not satisfy the
 * assertion by accident.
 */

afterEach(cleanupRestoreHarnesses);

const RESOURCE_AGGREGATE = deriveAttemptResourceAggregateId(ACTIVATION_AGGREGATE);

/** Bound over `failableRows`, hosted on an activation whose own bind cannot land
 *  so this suite's first write is always the bind under test. */
function bound(label: string): ResourceFixture {
  const fixture = activatedWith(label, duplicateRows());
  const outcome = bindAttemptResources(fixture.store, fixture.binding, failableRows());
  if (!outcome.ok) throw new Error(`bind refused: ${outcome.code}`);
  return fixture;
}

const membersOf = (outcome: AttemptResourceOutcome): readonly AttemptResourceMember[] => {
  if (!outcome.ok) throw new Error(`expected a bound set, refused with ${outcome.code}`);
  return outcome.members;
};

const statesOf = (
  rows: readonly { readonly resourceId: string; readonly state: string }[],
): Record<string, string> =>
  Object.fromEntries(rows.map((row) => [row.resourceId, row.state]));

/** The reducer's OWN answer over the same durable members. */
function reduced(
  members: readonly AttemptResourceMember[], run: (rows: readonly unknown[]) => unknown,
): AcquisitionSet {
  const outcome = run(members.map((member) => ({ ...member }))) as
    { ok: boolean; value: AcquisitionSet };
  if (!outcome.ok) throw new Error("the reducer refused the control run");
  return outcome.value;
}

const read = (fixture: ResourceFixture): AttemptResourceOutcome =>
  readAttemptResources(fixture.store, ACTIVATION_AGGREGATE, PROJECT_ID);

const apply = (fixture: ResourceFixture, report: AttemptResourceReport): AttemptResourceOutcome =>
  applyAttemptResourceReport(fixture.store, fixture.binding, report);

function refusalOf(outcome: AttemptResourceOutcome): {
  authority: string; code: string; refusedBy: string; upstreamCode: string | null;
} {
  if (outcome.ok) throw new Error("expected a refusal, received a bound resource set");
  return {
    authority: outcome.authority, code: outcome.code, refusedBy: outcome.refusedBy,
    upstreamCode: outcome.upstreamCode,
  };
}

const FAIL_RES_1: AttemptResourceReport = Object.freeze({
  disposition: "FAILED", epoch: 1, kind: "FAIL", resourceId: "res-1",
});

describe("attempt resource transitions — the reducer decides, this module records", () => {
  it("preserves RELEASED versus QUARANTINED exactly as adapterFail returned them", () => {
    const fixture = bound("fail");
    const before = membersOf(read(fixture));
    const control = reduced(before, (rows) => adapterFail(rows, "res-1", 1, "FAILED"));
    const expected = statesOf(control.rows);
    // NOT VACUOUS: the control genuinely splits the set, so a comparison against
    // it can fail. A reducer that collapsed everything to one state would trip
    // here rather than making the next assertion trivially true.
    expect(new Set(Object.values(expected)).size).toBeGreaterThan(1);
    const applied = apply(fixture, FAIL_RES_1);
    expect(statesOf(membersOf(applied))).toEqual(expected);
    // All three members survive the hold; none is dropped and none is invented.
    expect(membersOf(applied).map((member) => member.resourceId))
      .toEqual(["res-1", "res-2", "res-3"]);
    expect(membersOf(read(fixture))).toEqual(membersOf(applied));
  });

  it("keeps a QUARANTINED member in the answer, granting it no terminal authority", () => {
    const fixture = bound("quarantine-visible");
    const before = membersOf(read(fixture));
    const control = reduced(before, (rows) => adapterFail(rows, "res-1", 1, "FAILED"));
    const applied = apply(fixture, FAIL_RES_1);
    // res-2 cannot be fenced, so a SIBLING's failure must not release it — and
    // what it becomes is read off the reducer's own row, never written here.
    expect(statesOf(membersOf(applied))["res-2"]).toBe(statesOf(control.rows)["res-2"]);
    expect(statesOf(control.rows)["res-2"]).not.toBe(statesOf(control.rows)["res-1"]);
    if (!applied.ok) throw new Error("expected a bound set");
    // The answer exposes no terminality: classifying that is the consumer's job,
    // and a second definition inside durable bytes would drift silently.
    expect(Object.keys(applied).sort()).toEqual([
      "attemptRef", "authority", "digest", "effectIntentRef", "members", "ok", "projectId",
    ]);
    expect(applied.authority).toBe("DURABLE_RESOURCE_SET");
  });

  it("returns every nonterminal ACTIVE member when a grant changes nothing", () => {
    const fixture = bound("grant-noop");
    const before = membersOf(read(fixture));
    const control = reduced(before, (rows) => grantSuccessorCapacity(rows, "proof-ref-1"));
    const applied = apply(fixture, { kind: "GRANT", proofRef: "proof-ref-1" });
    expect(statesOf(membersOf(applied))).toEqual(statesOf(control.rows));
    // Nothing was QUARANTINED, so the reducer returned the set untouched and
    // every member is still the nonterminal ACTIVE it was bound as.
    expect(new Set(Object.values(statesOf(control.rows)))).toEqual(new Set(["ACTIVE"]));
    expect(membersOf(applied)).toHaveLength(3);
  });

  it("clears a quarantine only through the reducer that is allowed to clear it", () => {
    const fixture = bound("grant-clear");
    const held = membersOf(apply(fixture, FAIL_RES_1));
    const control = reduced(held, (rows) => grantSuccessorCapacity(rows, "proof-ref-2"));
    const cleared = apply(fixture, { kind: "GRANT", proofRef: "proof-ref-2" });
    expect(statesOf(membersOf(cleared))).toEqual(statesOf(control.rows));
    // The state genuinely moved, so this is not comparing a set against itself.
    expect(statesOf(held)["res-2"]).not.toBe(statesOf(control.rows)["res-2"]);
  });
});

describe("attempt resource transitions — order is the aggregate's, and it matters", () => {
  it("folds two transitions in aggregateSequence order, the later one winning", () => {
    const fixture = bound("ordering");
    const first = membersOf(apply(fixture, FAIL_RES_1));
    const second = membersOf(apply(fixture, { kind: "GRANT", proofRef: "proof-ref-3" }));
    // THE ORDERING ASSERTION IS NOT VACUOUS: res-2's state differs between the
    // two transitions, so a reversed fold would give a DIFFERENT answer.
    expect(statesOf(first)["res-2"]).not.toBe(statesOf(second)["res-2"]);
    expect(fixture.store.readEvents(RESOURCE_AGGREGATE)).toHaveLength(3);
    expect(statesOf(membersOf(read(fixture)))).toEqual(statesOf(second));
    expect(statesOf(membersOf(read(fixture)))).not.toEqual(statesOf(first));
  });
});

describe("attempt resource transitions — a refused report writes nothing", () => {
  const cases: readonly {
    readonly label: string; readonly report: AttemptResourceReport;
    readonly refusedBy: string; readonly code: string; readonly upstreamCode: string | null;
  }[] = [
    {
      code: "ATTEMPT_RESOURCE_SET_REFUSED", label: "a confirmation for a non-external resource",
      refusedBy: SCHEDULER_RESOURCE_AUTHORITY,
      report: { epoch: 1, kind: "CONFIRM", resourceId: "res-1" },
      upstreamCode: "AUTHORITY_STALE_LEASE",
    },
    {
      code: "ATTEMPT_RESOURCE_SET_REFUSED", label: "a stale acquisition epoch",
      refusedBy: SCHEDULER_RESOURCE_AUTHORITY,
      report: { disposition: "FAILED", epoch: 9, kind: "FAIL", resourceId: "res-1" },
      upstreamCode: "AUTHORITY_STALE_EPOCH",
    },
    {
      code: "ATTEMPT_RESOURCE_SET_REFUSED", label: "a disposition outside FAILED or UNKNOWN",
      refusedBy: SCHEDULER_RESOURCE_AUTHORITY,
      report: { disposition: "PROBABLY_FINE", epoch: 1, kind: "FAIL", resourceId: "res-1" },
      upstreamCode: "AUTHORITY_MALFORMED_INPUT",
    },
    {
      code: "ATTEMPT_RESOURCE_SET_REFUSED", label: "a resource outside this acquisition set",
      refusedBy: SCHEDULER_RESOURCE_AUTHORITY,
      report: { disposition: "FAILED", epoch: 1, kind: "FAIL", resourceId: "res-elsewhere" },
      upstreamCode: "AUTHORITY_STALE_LEASE",
    },
    {
      code: "ATTEMPT_RESOURCE_SET_REFUSED", label: "a grant with no proof over a held set",
      refusedBy: SCHEDULER_RESOURCE_AUTHORITY,
      report: { kind: "GRANT", proofRef: "" },
      upstreamCode: "AUTHORITY_STALE_LEASE",
    },
  ];

  for (const testCase of cases) {
    it(`refuses ${testCase.label} and appends no event`, () => {
      const fixture = bound(`refuse-${testCase.upstreamCode}-${testCase.report.kind}`);
      // The grant-without-proof case needs a quarantine in front of it, since a
      // set with nothing quarantined is settled without consulting the proof.
      if (testCase.report.kind === "GRANT") apply(fixture, FAIL_RES_1);
      const before = fixture.store.readEvents(RESOURCE_AGGREGATE).length;
      const digest = read(fixture);
      expect(refusalOf(apply(fixture, testCase.report))).toEqual({
        authority: "NONE", code: testCase.code, refusedBy: testCase.refusedBy,
        upstreamCode: testCase.upstreamCode,
      });
      expect(fixture.store.readEvents(RESOURCE_AGGREGATE)).toHaveLength(before);
      expect(read(fixture)).toEqual(digest);
    });
  }

  it("propagates the reader's own ABSENT when nothing was ever bound", () => {
    const fixture = activatedWith("apply-absent", duplicateRows());
    expect(refusalOf(apply(fixture, FAIL_RES_1))).toEqual({
      authority: "NONE", code: "ATTEMPT_RESOURCE_RECORD_ABSENT",
      refusedBy: DAEMON_ATTEMPT_RESOURCE, upstreamCode: null,
    });
    expect(fixture.store.readEvents(RESOURCE_AGGREGATE)).toHaveLength(0);
  });

  it("refuses a report whose activation names a foreign project", () => {
    const fixture = bound("apply-foreign");
    const before = fixture.store.readEvents(RESOURCE_AGGREGATE).length;
    const binding = { ...fixture.binding, projectId: "project-foreign" };
    expect(refusalOf(applyAttemptResourceReport(fixture.store, binding, FAIL_RES_1))).toEqual({
      authority: "NONE", code: "ATTEMPT_RESOURCE_ACTIVATION_UNREADABLE",
      refusedBy: DAEMON_ATTEMPT_RESOURCE, upstreamCode: "FOUNDATION_BINDING_PROJECT_MISMATCH",
    });
    expect(fixture.store.readEvents(RESOURCE_AGGREGATE)).toHaveLength(before);
  });

  it("ignores extra row, state and set fields smuggled onto a report", () => {
    const clean = bound("no-caller-rows-clean");
    const hostile = bound("no-caller-rows-hostile");
    // Production must answer identically: the report says WHICH resource and WHAT
    // the adapter said, and there is no channel for a caller to name the result.
    // Asserting the report's own key set instead would only test the fixture.
    const smuggled = {
      ...FAIL_RES_1, members: [{ resourceId: "res-1", state: "RELEASED" }],
      rows: [{ resourceId: "res-2", state: "RELEASED" }], state: "RELEASED",
    } as unknown as AttemptResourceReport;
    expect(statesOf(membersOf(apply(hostile, smuggled))))
      .toEqual(statesOf(membersOf(apply(clean, FAIL_RES_1))));
  });

  it("refuses a report against an unreadable store rather than crashing", () => {
    const fixture = bound("apply-unreadable");
    fixture.store.close();
    expect(refusalOf(apply(fixture, FAIL_RES_1))).toEqual({
      authority: "NONE", code: "ATTEMPT_RESOURCE_ACTIVATION_UNREADABLE",
      refusedBy: DAEMON_ATTEMPT_RESOURCE, upstreamCode: null,
    });
  });

  it("cannot reach an ACCEPTED confirmation, and says so instead of faking one", () => {
    // AN HONEST STRUCTURAL LIMIT, asserted rather than glossed over. A bind
    // requires every member ACTIVE, and no public reducer maps an ACTIVE set back
    // to PENDING_ACQUIRE (`adapterFail` yields RELEASED/QUARANTINED,
    // `grantSuccessorCapacity` yields RELEASED). `adapterConfirm` accepts ONLY an
    // external PENDING_ACQUIRE row, so over any set this module can bind it must
    // refuse. The CONFIRM arm therefore has no accepted-path coverage here, and
    // this case pins WHY so a reader cannot mistake it for one.
    const fixture = bound("confirm-unreachable");
    const before = membersOf(read(fixture));
    const held = membersOf(apply(fixture, FAIL_RES_1));
    for (const members of [before, held]) {
      const control = adapterConfirm(members.map((member) => ({ ...member })), "res-1", 1);
      expect(control.ok).toBe(false);
      expect(members.every((member) => member.state !== "PENDING_ACQUIRE")).toBe(true);
    }
    expect(refusalOf(apply(fixture, { epoch: 1, kind: "CONFIRM", resourceId: "res-1" })))
      .toEqual({
        authority: "NONE", code: "ATTEMPT_RESOURCE_SET_REFUSED",
        refusedBy: SCHEDULER_RESOURCE_AUTHORITY, upstreamCode: "AUTHORITY_STALE_LEASE",
      });
  });
});
