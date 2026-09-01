import { adapterConfirm, adapterFail, grantSuccessorCapacity } from "@moe/scheduler";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupRestoreHarnesses } from "../recovery/restore-test-harness.js";
import {
  DAEMON_ATTEMPT_RESOURCE, deriveAttemptResourceAggregateId,
} from "./attempt-resource-authority-contracts.js";
import type {
  AttemptResourceOutcome, AttemptResourceReport,
} from "./attempt-resource-authority-contracts.js";
import { applyAttemptResourceReport } from "./attempt-resource-authority.js";
import {
  ACTIVATION_AGGREGATE, failableRows, openUnactivatedResourceFixture,
} from "./attempt-resource-test-harness.js";
import type { ResourceFixture } from "./attempt-resource-test-harness.js";

/**
 * The TRANSITION arm, over a store holding NO ACTIVATION.
 *
 * `applyAttemptResourceReport` reads the activation through `durableActivation` before it
 * measures a horizon, projects a record or consults a reducer. While policy cannot
 * authoritatively ALLOW, production cannot mint a committed activation and no honest route
 * reaches a bound set from a test; governor ruling comment-937524c83a1945a5afae3ed8ac2405b9
 * forbids manufacturing one "by any name" and directs a suite in this position to change
 * WHAT it asserts. So what is asserted here is the reachable claim: every report shape —
 * well formed or hostile — is refused on the ACTIVATION, with the exact code, the exact
 * layer and the reader's own upstream code, and nothing durable is written.
 *
 * THE UNIFORM ANSWER IS DISCRIMINATED, not assumed. Every generated report is also pushed
 * through the very reducers `reduceReport` would dispatch it to — `adapterConfirm`,
 * `adapterFail`, `grantSuccessorCapacity` — over a store-free admitted set, and those
 * answers are required to differ across the matrix. An applier that reduced before reading
 * the activation could not answer every case with one triple.
 *
 * RETIRED WITH THIS MIGRATION, each needing a bind that lands: the RELEASED-versus-
 * QUARANTINED preservation cases, the aggregate-order fold, the five transcribed scheduler
 * refusal arms, the accepted-no-op suppression pair, and BOTH moved-read-horizon guards
 * (including the discriminating no-op variant qa-fc9c6bbd added on task-7eceb55b). The
 * horizon and no-op-suppression guards are daemon-local and have NO surviving owner; they
 * are recorded as an open gap in this row's reconciliation comment. The pure reducer
 * semantics are covered by packages/scheduler/src/authority/lease-resource.test.ts.
 */

afterEach(cleanupRestoreHarnesses);

const RESOURCE_AGGREGATE = deriveAttemptResourceAggregateId(ACTIVATION_AGGREGATE);

/** The exact triple every report owes while the activation aggregate is empty. */
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

const apply = (fixture: ResourceFixture, report: AttemptResourceReport): AttemptResourceOutcome =>
  applyAttemptResourceReport(fixture.store, fixture.binding, report);

const FAIL_RES_1: AttemptResourceReport = Object.freeze({
  disposition: "FAILED", epoch: 1, kind: "FAIL", resourceId: "res-1",
});

interface ReportCase { readonly label: string; readonly report: AttemptResourceReport }

/**
 * GENERATED, and the count is asserted before any outcome is: a matrix that lost
 * its entries would produce zero cases and pass while asserting nothing.
 */
function reportCases(): readonly ReportCase[] {
  const cases: ReportCase[] = [
    { label: "confirm", report: { epoch: 1, kind: "CONFIRM", resourceId: "res-1" } },
    { label: "confirm:stale-epoch", report: { epoch: 9, kind: "CONFIRM", resourceId: "res-1" } },
    { label: "fail:released", report: FAIL_RES_1 },
    {
      label: "fail:unknown",
      report: { disposition: "UNKNOWN", epoch: 1, kind: "FAIL", resourceId: "res-2" },
    },
    { label: "grant:proven", report: { kind: "GRANT", proofRef: "proof-ref-1" } },
    { label: "grant:no-proof", report: { kind: "GRANT", proofRef: "" } },
  ];
  for (const disposition of ["PROBABLY_FINE", "", "FAILED"]) {
    cases.push({
      label: `fail:disposition:${JSON.stringify(disposition)}`,
      report: { disposition, epoch: 1, kind: "FAIL", resourceId: "res-1" },
    });
  }
  for (const epoch of [0, 9, -1, Number.NaN]) {
    cases.push({
      label: `fail:epoch:${String(epoch)}`,
      report: { disposition: "FAILED", epoch, kind: "FAIL", resourceId: "res-1" },
    });
  }
  for (const resourceId of ["res-elsewhere", "", "res-3"]) {
    cases.push({
      label: `fail:resource:${JSON.stringify(resourceId)}`,
      report: { disposition: "FAILED", epoch: 1, kind: "FAIL", resourceId },
    });
  }
  // A report carrying fields production has no channel for. There is no way for a
  // caller to name the resulting states, and the answer must not vary with them.
  cases.push({
    label: "fail:smuggled-set",
    report: {
      ...FAIL_RES_1, members: [{ resourceId: "res-1", state: "RELEASED" }],
      rows: [{ resourceId: "res-2", state: "RELEASED" }], state: "RELEASED",
    } as unknown as AttemptResourceReport,
  });
  return cases;
}

const REQUIRED_REPORT_LABELS: readonly string[] = [
  "confirm", "fail:released", "fail:unknown", "grant:proven", "grant:no-proof",
  "fail:disposition:\"PROBABLY_FINE\"", "fail:epoch:9", "fail:epoch:NaN",
  "fail:resource:\"res-elsewhere\"", "fail:smuggled-set",
];

/** A reducer-admitted member list built with NO store at all, so the dispatch
 *  below exercises the same three public reducers `reduceReport` would call. */
function admittedMembers(): readonly unknown[] {
  const outcome = grantSuccessorCapacity(failableRows(), null);
  if (!outcome.ok) throw new Error("the reducer refused the control set");
  return outcome.value.rows.map((row) => ({ ...row }));
}

/** What the SCHEDULER answers for this report over that set: "ACCEPTED", its own
 *  refusal code, or `null` when it throws rather than returning. */
function reducerAnswer(report: AttemptResourceReport): string | null {
  const members = admittedMembers();
  let outcome: ReturnType<typeof grantSuccessorCapacity>;
  try {
    if (report.kind === "CONFIRM") {
      outcome = adapterConfirm(members, report.resourceId, report.epoch);
    } else if (report.kind === "FAIL") {
      outcome = adapterFail(members, report.resourceId, report.epoch, report.disposition);
    } else {
      outcome = grantSuccessorCapacity(members, report.proofRef);
    }
  } catch { return null; }
  return outcome.ok ? "ACCEPTED" : outcome.issues[0]?.code ?? "REFUSED";
}

describe("attempt resource transitions — the report matrix is generated and discriminating", () => {
  it("emits uniquely labelled cases the reducers do NOT answer uniformly", () => {
    const cases = reportCases();
    const labels = cases.map((testCase) => testCase.label);
    expect(cases.length).toBeGreaterThanOrEqual(16);
    expect(new Set(labels).size).toBe(cases.length);
    expect(REQUIRED_REPORT_LABELS.filter((label) => !labels.includes(label))).toEqual([]);
    // All three report kinds are represented, so no dispatch branch is unswept.
    expect(new Set(cases.map((testCase) => testCase.report.kind)))
      .toEqual(new Set(["CONFIRM", "FAIL", "GRANT"]));
    // THE DISCRIMINATOR. Over one admitted set these reports genuinely diverge at
    // the layer that reads them, so the single triple asserted below can only be
    // the activation gate speaking first.
    const answers = cases.map((testCase) => reducerAnswer(testCase.report));
    expect(new Set(answers).size).toBeGreaterThan(2);
    expect(answers).toContain("ACCEPTED");
  });

  for (const testCase of reportCases()) {
    it(`refuses ${testCase.label} on the activation and appends no event`, () => {
      const fixture = openUnactivatedResourceFixture(`apply-${testCase.label}`);
      const outcome = apply(fixture, testCase.report);
      expect([testCase.label, refusalOf(outcome)]).toEqual([testCase.label, ACTIVATION_ABSENT]);
      expect(fixture.store.readEvents(RESOURCE_AGGREGATE)).toHaveLength(0);
      // Store-wide, so a report cannot have written to some other aggregate.
      expect(fixture.store.readEventHorizon()).toBe(0n);
    });
  }
});

describe("attempt resource transitions — the activation read is not a generic failure", () => {
  it("reports the STORE's own failure as a null upstream, not as a missing binding", () => {
    // A REAL store failure, not a mock: a closed handle throws before any reader is
    // consulted, so there is no upstream code to preserve. Folding this into
    // FOUNDATION_BINDING_NOT_FOUND would report a broken store as an absent activation.
    const fixture = openUnactivatedResourceFixture("apply-unreadable");
    fixture.store.close();
    expect(refusalOf(apply(fixture, FAIL_RES_1))).toEqual({
      authority: "NONE", code: "ATTEMPT_RESOURCE_ACTIVATION_UNREADABLE",
      refusedBy: DAEMON_ATTEMPT_RESOURCE, upstreamCode: null,
    });
  });

  it("answers absence before the project fence, and says so rather than implying one", () => {
    // AN HONEST STRUCTURAL LIMIT. `tracedProject` refuses a foreign project, but it
    // is only reached once the aggregate holds an event, so over an empty aggregate
    // FOUNDATION_BINDING_PROJECT_MISMATCH is unreachable and the answer is absence.
    // Pinned so a reader cannot mistake this case for foreign-project coverage.
    const fixture = openUnactivatedResourceFixture("apply-foreign");
    const binding = { ...fixture.binding, projectId: "project-foreign" };
    expect(refusalOf(applyAttemptResourceReport(fixture.store, binding, FAIL_RES_1)))
      .toEqual(ACTIVATION_ABSENT);
    expect(fixture.store.readEventHorizon()).toBe(0n);
  });

  it("gives a smuggled report the SAME answer as its clean twin", () => {
    // The two reports are genuinely different objects — asserted, so this is not
    // comparing a value against itself — and production still has no channel by
    // which a caller can name a resulting state.
    const smuggled = reportCases().find((testCase) => testCase.label === "fail:smuggled-set");
    if (smuggled === undefined) throw new Error("the smuggled report case was not generated");
    expect(Object.keys(smuggled.report).sort()).not.toEqual(Object.keys(FAIL_RES_1).sort());
    const hostile = openUnactivatedResourceFixture("smuggled-hostile");
    const clean = openUnactivatedResourceFixture("smuggled-clean");
    expect(refusalOf(apply(hostile, smuggled.report))).toEqual(refusalOf(apply(clean, FAIL_RES_1)));
    expect(hostile.store.readEventHorizon()).toBe(0n);
  });
});
