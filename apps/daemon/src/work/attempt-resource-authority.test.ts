import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import { cleanupRestoreHarnesses } from "../recovery/restore-test-harness.js";
import {
  ATTEMPT_RESOURCE_APPLY_COMMAND_KIND, ATTEMPT_RESOURCE_BIND_COMMAND_KIND,
  ATTEMPT_RESOURCE_BOUND_EVENT_TYPE, ATTEMPT_RESOURCE_CODES,
  ATTEMPT_RESOURCE_RECORD_VERSION, ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE,
  DAEMON_ATTEMPT_RESOURCE, SCHEDULER_RESOURCE_AUTHORITY, deriveAttemptResourceAggregateId,
} from "./attempt-resource-authority-contracts.js";
import type { AttemptResourceOutcome } from "./attempt-resource-authority-contracts.js";
import { bindAttemptResources, readAttemptResources } from "./attempt-resource-authority.js";
import {
  ACTIVATION_AGGREGATE, DURABLE_ATTEMPT_REF, DURABLE_EFFECT_INTENT_REF, activatedWith,
  activationBytes, cleanRows, duplicateRows, resourceRow,
} from "./attempt-resource-test-harness.js";
import type { ResourceFixture } from "./attempt-resource-test-harness.js";

/**
 * The durable per-attempt resource authority, over a REAL SqliteEventStore and a
 * REAL activation committed by the production ingress.
 *
 * EVERY DIRECT-CALL TEST HOSTS ITSELF ON AN ACTIVATION WHOSE OWN PRODUCTION BIND
 * CANNOT LAND (duplicate resource ids pass the claim leg but the binder refuses
 * them). That is deliberate: it makes the call under test the ONLY writer on the
 * resource aggregate, so "zero durable residue" means literally zero events both
 * before and after the ingress is wired, and a direct bind can never collide with
 * a command key production already consumed.
 *
 * Every refusal case asserts THREE things: the exact code, the exact refusing
 * LAYER — this module's or the scheduler's, never folded together — and that no
 * durable row exists afterwards. A handler that wrote a row and then refused
 * sails through a return-value assertion.
 */

afterEach(cleanupRestoreHarnesses);

const RESOURCE_AGGREGATE = deriveAttemptResourceAggregateId(ACTIVATION_AGGREGATE);

/** A committed activation the binder can read, whose own bind never lands. */
const hostFixture = (label: string): ResourceFixture =>
  activatedWith(label, duplicateRows());

const resourceEvents = (store: SqliteEventStore): number =>
  store.readEvents(RESOURCE_AGGREGATE).length;

function refusalOf(outcome: AttemptResourceOutcome): {
  code: string; refusedBy: string; upstreamCode: string | null;
} {
  if (outcome.ok) throw new Error("expected a refusal, received a bound resource set");
  return { code: outcome.code, refusedBy: outcome.refusedBy, upstreamCode: outcome.upstreamCode };
}

function answerOf(outcome: AttemptResourceOutcome): {
  attemptRef: string; effectIntentRef: string; ids: readonly string[]; projectId: string;
} {
  if (!outcome.ok) throw new Error(`expected a bound set, refused with ${outcome.code}`);
  return {
    attemptRef: outcome.attemptRef, effectIntentRef: outcome.effectIntentRef,
    ids: outcome.members.map((member) => member.resourceId), projectId: outcome.projectId,
  };
}

/** Read through the module's OWN reader, so a row written and then refused
 *  cannot hide behind a return value. */
function expectNoDurableSet(fixture: ResourceFixture): void {
  expect(resourceEvents(fixture.store)).toBe(0);
  expect(refusalOf(readAttemptResources(
    fixture.store, ACTIVATION_AGGREGATE, fixture.binding.projectId,
  ))).toEqual({
    code: "ATTEMPT_RESOURCE_RECORD_ABSENT", refusedBy: DAEMON_ATTEMPT_RESOURCE,
    upstreamCode: null,
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

describe("attempt resource authority — the bind arm", () => {
  it("binds every member of a multi-resource set exactly once", () => {
    const fixture = hostFixture("multi");
    const outcome = bindAttemptResources(fixture.store, fixture.binding, cleanRows());
    expect(answerOf(outcome)).toEqual({
      attemptRef: DURABLE_ATTEMPT_REF, effectIntentRef: DURABLE_EFFECT_INTENT_REF,
      ids: ["res-1", "res-2", "res-3"], projectId: fixture.binding.projectId,
    });
    // Bound to the DURABLE attempt and effect intent, and exactly one event.
    expect(resourceEvents(fixture.store)).toBe(1);
  });

  it("carries each member's seven row fields verbatim from the reducer", () => {
    const fixture = hostFixture("fields");
    const outcome = bindAttemptResources(fixture.store, fixture.binding, cleanRows());
    if (!outcome.ok) throw new Error(`expected a bound set, refused with ${outcome.code}`);
    expect(outcome.members[1]).toEqual({
      capacityUnits: 1, effectIntentRef: "intent-ref-res-2", epoch: 1, external: false,
      fenceable: true, resourceId: "res-2", state: "ACTIVE",
    });
  });

  it("refuses the WHOLE set when one row is undecodable, losing no later member", () => {
    const fixture = hostFixture("undecodable");
    const rows = cleanRows();
    rows[1] = resourceRow("res-2", { epoch: -1 });
    const outcome = bindAttemptResources(fixture.store, fixture.binding, rows);
    // The scheduler's own malformed-input code, preserved and attributed to the
    // scheduler: flattening it would make a hostile row indistinguishable from a
    // quarantined one, which refuses under a different upstream code.
    expect(refusalOf(outcome)).toEqual({
      code: "ATTEMPT_RESOURCE_SET_REFUSED", refusedBy: SCHEDULER_RESOURCE_AUTHORITY,
      upstreamCode: "AUTHORITY_MALFORMED_INPUT",
    });
    // res-3 followed the undecodable row. A binder that bound the decodable
    // members would answer with a SHORTER set here rather than refusing.
    expectNoDurableSet(fixture);
  });

  it("refuses duplicate resource ids rather than collapsing them into one member", () => {
    const fixture = hostFixture("duplicate");
    const outcome = bindAttemptResources(fixture.store, fixture.binding, duplicateRows());
    expect(refusalOf(outcome)).toEqual({
      code: "ATTEMPT_RESOURCE_MEMBER_DUPLICATE", refusedBy: DAEMON_ATTEMPT_RESOURCE,
      upstreamCode: null,
    });
    expectNoDurableSet(fixture);
  });

  it("refuses a set that is not entirely ACTIVE, on the scheduler's own field", () => {
    const fixture = hostFixture("pending");
    const rows = cleanRows();
    rows[2] = resourceRow("res-3", { external: true, state: "PENDING_ACQUIRE" });
    expect(refusalOf(bindAttemptResources(fixture.store, fixture.binding, rows))).toEqual({
      code: "ATTEMPT_RESOURCE_SET_NOT_ACTIVE", refusedBy: DAEMON_ATTEMPT_RESOURCE,
      upstreamCode: null,
    });
    expectNoDurableSet(fixture);
  });

  it("refuses a quarantined set without laundering it into RELEASED", () => {
    const fixture = hostFixture("quarantined");
    const rows = cleanRows();
    rows[0] = resourceRow("res-1", { state: "QUARANTINED" });
    // `grantSuccessorCapacity(rows, <proof>)` would CLEAR the quarantine to
    // RELEASED and bind it as a settled member. The binder passes no proof, so
    // the scheduler refuses instead.
    expect(refusalOf(bindAttemptResources(fixture.store, fixture.binding, rows))).toEqual({
      code: "ATTEMPT_RESOURCE_SET_REFUSED", refusedBy: SCHEDULER_RESOURCE_AUTHORITY,
      upstreamCode: "AUTHORITY_STALE_LEASE",
    });
    expectNoDurableSet(fixture);
  });

  it("refuses an empty member list instead of binding an empty set", () => {
    const fixture = hostFixture("empty");
    expect(refusalOf(bindAttemptResources(fixture.store, fixture.binding, []))).toEqual({
      code: "ATTEMPT_RESOURCE_SET_REFUSED", refusedBy: SCHEDULER_RESOURCE_AUTHORITY,
      upstreamCode: "AUTHORITY_MALFORMED_INPUT",
    });
    expectNoDurableSet(fixture);
  });

  it("refuses a bind whose activation aggregate holds nothing", () => {
    const fixture = hostFixture("no-activation");
    const binding = { ...fixture.binding, activationAggregateId: "activation-nowhere" };
    expect(refusalOf(bindAttemptResources(fixture.store, binding, cleanRows()))).toEqual({
      code: "ATTEMPT_RESOURCE_ACTIVATION_UNREADABLE", refusedBy: DAEMON_ATTEMPT_RESOURCE,
      upstreamCode: "FOUNDATION_BINDING_NOT_FOUND",
    });
    expect(fixture.store.readEvents(
      deriveAttemptResourceAggregateId("activation-nowhere")).length).toBe(0);
  });

  it("refuses a bind whose binding names a FOREIGN project", () => {
    const fixture = hostFixture("foreign-write");
    const binding = { ...fixture.binding, projectId: "project-foreign" };
    // The activation reader's own `tracedProject` fence answers first, and its
    // code is preserved rather than reported as a project mismatch of ours.
    expect(refusalOf(bindAttemptResources(fixture.store, binding, cleanRows()))).toEqual({
      code: "ATTEMPT_RESOURCE_ACTIVATION_UNREADABLE", refusedBy: DAEMON_ATTEMPT_RESOURCE,
      upstreamCode: "FOUNDATION_BINDING_PROJECT_MISMATCH",
    });
    expectNoDurableSet(fixture);
  });
});

/**
 * THE PRODUCTION EDGE. These cases call NOTHING of this module directly on the
 * write side: `runEffectActivateCommand` is the only writer, so a green result
 * here proves production IMPORTS the binder rather than merely that the binder
 * loads. Deleting the call in `activation-ingress.ts` must redden the first case.
 */
describe("attempt resource authority — the production ingress binds", () => {
  it("binds the whole declared set through runEffectActivateCommand alone", () => {
    const fixture = activatedWith("production", cleanRows());
    const outcome = readAttemptResources(
      fixture.store, ACTIVATION_AGGREGATE, fixture.binding.projectId);
    expect(answerOf(outcome)).toEqual({
      attemptRef: DURABLE_ATTEMPT_REF, effectIntentRef: DURABLE_EFFECT_INTENT_REF,
      ids: ["res-1", "res-2", "res-3"], projectId: fixture.binding.projectId,
    });
    expect(resourceEvents(fixture.store)).toBe(1);
  });

  it("commits the activation but binds NOTHING when the declared set is invalid", () => {
    // Duplicate ids pass the claim leg: `parseRows` does not dedupe and
    // `reserveProviderSlot` only checks state. So the activation is genuinely
    // accepted while the bind refuses — the ingress neither fabricates a binding
    // nor lies about a decision the store has already committed.
    const fixture = activatedWith("production-refused", duplicateRows());
    expect(resourceEvents(fixture.store)).toBe(0);
    expect(refusalOf(readAttemptResources(
      fixture.store, ACTIVATION_AGGREGATE, fixture.binding.projectId,
    ))).toEqual({
      code: "ATTEMPT_RESOURCE_RECORD_ABSENT", refusedBy: DAEMON_ATTEMPT_RESOURCE,
      upstreamCode: null,
    });
  });

  it("replays the bind on a REPLAYED activation without appending a second set", () => {
    const fixture = activatedWith("production-replay", cleanRows());
    const first = readAttemptResources(
      fixture.store, ACTIVATION_AGGREGATE, fixture.binding.projectId);
    const again = runEffectActivateCommand(fixture.store, activationBytes(cleanRows()));
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.disposition).toBe("REPLAYED");
    // RAW COUNT, not a return value: one event, and the same answer bytes.
    expect(resourceEvents(fixture.store)).toBe(1);
    expect(readAttemptResources(
      fixture.store, ACTIVATION_AGGREGATE, fixture.binding.projectId)).toEqual(first);
  });
});
