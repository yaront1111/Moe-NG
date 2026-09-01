import { grantSuccessorCapacity } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupRestoreHarnesses } from "../recovery/restore-test-harness.js";
import {
  ATTEMPT_RESOURCE_MEMBER_KEYS, DAEMON_ATTEMPT_RESOURCE, deriveAttemptResourceAggregateId,
} from "./attempt-resource-authority-contracts.js";
import type { AttemptResourceOutcome } from "./attempt-resource-authority-contracts.js";
import { bindAttemptResources } from "./attempt-resource-authority.js";
import {
  ACTIVATION_AGGREGATE, cleanRows, duplicateRows, openUnactivatedResourceFixture, resourceRow,
} from "./attempt-resource-test-harness.js";

/**
 * The generated hostile sweep, run against a store holding NO ACTIVATION.
 *
 * `bindAttemptResources` reads the activation before it admits a row, and while policy
 * cannot authoritatively ALLOW there is no honest route to a committed activation from a
 * test (governor ruling comment-937524c83a1945a5afae3ed8ac2405b9). So what this sweep now
 * proves is that the activation gate is UNCONDITIONAL: sixty-odd hostile shapes — missing
 * keys, hostile scalars, accessors, an own `__proto__` data property, revoked proxies,
 * sparse holes, non-record containers — every one of them is refused with the SAME exact
 * triple, none crashes out as an exception, and not one writes a byte.
 *
 * THE SWEEP IS NOT VACUOUS, and the first case is what keeps it honest. The same generated
 * rows are pushed through the SCHEDULER's own `grantSuccessorCapacity`, which answers them
 * in more than one way — accepting some, refusing others. A binder that admitted rows before
 * reading the activation would have to answer this matrix with more than one triple, and the
 * uniform assertion would redden.
 *
 * RETIRED WITH THIS MIGRATION: replay idempotence, the IDEMPOTENCY_CONFLICT arm, the
 * second-key EXPECTED_VERSION_CONFLICT arm, and the accepted-bind positive control — all
 * four need a bind that lands. Their store-level identity semantics have no surviving owner
 * in this package and are recorded as an open gap in this row's reconciliation comment; the
 * pure grant/duplicate/quarantine semantics live in
 * packages/scheduler/src/authority/lease-resource.test.ts.
 */

afterEach(cleanupRestoreHarnesses);

const RESOURCE_AGGREGATE = deriveAttemptResourceAggregateId(ACTIVATION_AGGREGATE);

const events = (store: SqliteEventStore): number => store.readEvents(RESOURCE_AGGREGATE).length;

/** The exact triple every case owes: this module's code, this module's layer, and
 *  the activation reader's own code preserved as the upstream. */
const ACTIVATION_ABSENT = Object.freeze({
  authority: "NONE", code: "ATTEMPT_RESOURCE_ACTIVATION_UNREADABLE",
  refusedBy: DAEMON_ATTEMPT_RESOURCE, upstreamCode: "FOUNDATION_BINDING_NOT_FOUND",
});

/** Rendered for the failure message; compared field by field below so key order
 *  cannot make two different refusals look alike. */
const tripleOf = (outcome: AttemptResourceOutcome): string => outcome.ok ? "ACCEPTED"
  : `${outcome.authority}/${outcome.code}/${outcome.refusedBy}/${String(outcome.upstreamCode)}`;

const isActivationAbsent = (outcome: AttemptResourceOutcome): boolean =>
  !outcome.ok && outcome.authority === ACTIVATION_ABSENT.authority
  && outcome.code === ACTIVATION_ABSENT.code
  && outcome.refusedBy === ACTIVATION_ABSENT.refusedBy
  && outcome.upstreamCode === ACTIVATION_ABSENT.upstreamCode;

interface SweepCase { readonly label: string; readonly rows: unknown }

const withMember = (member: unknown): unknown[] => {
  const rows: unknown[] = cleanRows();
  rows[1] = member;
  return rows;
};

const NUMERIC_KEYS = ["capacityUnits", "epoch"] as const;
const TEXT_KEYS = ["effectIntentRef", "resourceId", "state"] as const;
const BOOLEAN_KEYS = ["external", "fenceable"] as const;

const HOSTILE_NUMBERS: readonly unknown[] = [
  -0, Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, "1", null, {},
];
const HOSTILE_TEXT: readonly unknown[] = ["", 1, null, [], { toString: null }];
const HOSTILE_BOOLEANS: readonly unknown[] = ["true", 1, 0, null];

/**
 * The sweep is GENERATED, and its size is asserted before any outcome is. A
 * sweep that silently produces zero cases passes while testing nothing.
 */
function sweepCases(): readonly SweepCase[] {
  const cases: SweepCase[] = [];
  for (const key of ATTEMPT_RESOURCE_MEMBER_KEYS) {
    const short: Record<string, unknown> = resourceRow("res-2");
    delete short[key];
    cases.push({ label: `missing:${key}`, rows: withMember(short) });
    cases.push({
      label: `extra-beside:${key}`, rows: withMember(resourceRow("res-2", { extra: key })),
    });
  }
  for (const key of NUMERIC_KEYS) {
    for (const value of HOSTILE_NUMBERS) {
      cases.push({
        // `String(-0)` is "0", which would hide the negative-zero case behind an
        // indistinguishable label.
        label: `${key}:${Object.is(value, -0) ? "-0" : String(value)}`,
        rows: withMember(resourceRow("res-2", { [key]: value })),
      });
    }
  }
  for (const key of TEXT_KEYS) {
    for (const value of HOSTILE_TEXT) {
      cases.push({
        label: `${key}:${JSON.stringify(value)}`,
        rows: withMember(resourceRow("res-2", { [key]: value })),
      });
    }
  }
  for (const key of BOOLEAN_KEYS) {
    for (const value of HOSTILE_BOOLEANS) {
      cases.push({
        label: `${key}:${String(value)}`, rows: withMember(resourceRow("res-2", { [key]: value })),
      });
    }
  }
  // A member that is not a plain record at all. Labelled by INDEX as well as by
  // value: two distinct objects both stringify to "[object Object]", and a label
  // collision would silently shrink the sweep past the uniqueness assertion.
  const nonRecords: readonly unknown[] = [null, undefined, 1, "res-2", [], () => 1, new Date(0)];
  for (const [index, member] of nonRecords.entries()) {
    cases.push({ label: `member:${index}:${typeof member}`, rows: withMember(member) });
  }
  // An own `__proto__` data property, which the literal `__proto__:` form would
  // NOT create — `defineProperty` is the only way to plant it.
  const polluted: Record<string, unknown> = resourceRow("res-2");
  Object.defineProperty(polluted, "__proto__", {
    configurable: true, enumerable: true, value: { fenceable: true }, writable: true,
  });
  cases.push({ label: "member:__proto__-own-key", rows: withMember(polluted) });
  // An accessor where a data property must be: `readOwnDataProperty` refuses a
  // descriptor with no `value` slot, so the getter is never invoked.
  const accessor: Record<string, unknown> = resourceRow("res-2");
  delete accessor["epoch"];
  Object.defineProperty(accessor, "epoch", { enumerable: true, get: () => 1 });
  cases.push({ label: "member:accessor-bearing", rows: withMember(accessor) });
  // Reflection on a revoked proxy THROWS rather than returning falsy.
  const revocableMember = Proxy.revocable(resourceRow("res-2"), {});
  revocableMember.revoke();
  cases.push({ label: "member:revoked-proxy", rows: withMember(revocableMember.proxy) });
  const revocableList = Proxy.revocable(cleanRows(), {});
  revocableList.revoke();
  cases.push({ label: "rows:revoked-proxy", rows: revocableList.proxy });
  // The container itself, likewise labelled by index.
  const containers: readonly unknown[] = [null, undefined, {}, "rows", 1, cleanRows()[0], true];
  for (const [index, rows] of containers.entries()) {
    cases.push({ label: `rows:${index}:${typeof rows}`, rows });
  }
  cases.push({ label: "rows:empty", rows: [] });
  cases.push({ label: "rows:duplicate-id", rows: duplicateRows() });
  const hole: unknown[] = cleanRows();
  delete hole[1];
  cases.push({ label: "rows:sparse-hole", rows: hole });
  return cases;
}

/** Named families, so a generator that silently stopped emitting a whole class
 *  reddens instead of quietly shrinking the sweep. A bare count cannot see that. */
const REQUIRED_LABELS: readonly string[] = [
  "missing:resourceId", "extra-beside:state", "epoch:-1", "epoch:NaN", "epoch:-0",
  "capacityUnits:Infinity", "resourceId:\"\"", "state:null", "external:true", "fenceable:1",
  "member:__proto__-own-key", "member:accessor-bearing", "member:revoked-proxy",
  "rows:revoked-proxy", "rows:empty", "rows:duplicate-id", "rows:sparse-hole",
];

/** The scheduler's own answer for a row list: its refusal code, "ACCEPTED", or
 *  `null` where reflection on a revoked proxy throws instead of returning. */
function reducerAnswer(rows: unknown): string | null {
  let outcome: ReturnType<typeof grantSuccessorCapacity>;
  try { outcome = grantSuccessorCapacity(rows, null); }
  catch { return null; }
  return outcome.ok ? "ACCEPTED" : outcome.issues[0]?.code ?? "REFUSED";
}

describe("attempt resource authority — generated hostile sweep", () => {
  it("generates a sized, uniquely labelled sweep the reducer does NOT answer uniformly", () => {
    const cases = sweepCases();
    const labels = cases.map((testCase) => testCase.label);
    // ASSERTED BEFORE ANY OUTCOME: a sweep that generated nothing would
    // otherwise pass while testing nothing at all. The count is a floor AND every
    // required family is checked by name, because a count alone cannot see a
    // whole class of mutations quietly stopping.
    expect(cases.length).toBeGreaterThan(60);
    expect(new Set(labels).size).toBe(cases.length);
    expect(REQUIRED_LABELS.filter((label) => !labels.includes(label))).toEqual([]);
    // THE DISCRIMINATOR for the uniform-triple assertion below. These rows are not
    // interchangeable to the code that actually reads them: the scheduler accepts
    // some, refuses others under distinct codes, and throws on at least one.
    const answers = cases.map((testCase) => reducerAnswer(testCase.rows));
    expect(new Set(answers).size).toBeGreaterThan(1);
    expect(answers).toContain("ACCEPTED");
    expect(answers).toContain("AUTHORITY_MALFORMED_INPUT");
    // MEASURED: the scheduler contains its own reflection hazards, so no generated
    // case escapes as a throw. A null here would be a real regression in that
    // containment, not an expected shape.
    expect(answers).not.toContain(null);
  });

  it("refuses every generated hostile bind on the ACTIVATION, never throws, writes nothing", () => {
    const cases = sweepCases();
    expect(cases.length).toBeGreaterThan(60);
    const fixture = openUnactivatedResourceFixture("sweep");
    const crashed: string[] = [];
    const offTriple: string[] = [];
    for (const testCase of cases) {
      let outcome: AttemptResourceOutcome;
      // A CRASH IS NOT A REFUSAL. A thrown case is recorded as a failure of this
      // sweep, never swallowed into "it did not succeed".
      try { outcome = bindAttemptResources(fixture.store, fixture.binding, testCase.rows); }
      catch { crashed.push(testCase.label); continue; }
      if (!isActivationAbsent(outcome)) offTriple.push(`${testCase.label}=${tripleOf(outcome)}`);
    }
    // Report by NAME so a regression says which case, not merely a count.
    expect({ crashed, offTriple }).toEqual({ crashed: [], offTriple: [] });
    // Zero residue across the WHOLE sweep: not one hostile case wrote a byte.
    expect(events(fixture.store)).toBe(0);
    expect(fixture.store.readEventHorizon()).toBe(0n);
  });
});

describe("attempt resource authority — opaque text survives verbatim", () => {
  it("carries a non-NFC resource id through the reducer without normalising it", () => {
    // NOT a refusal case, and deliberately so. A resource id is opaque, and
    // silently normalising one would make two DIFFERENT resources collide on the
    // same member. So the property asserted is byte-preservation, not rejection.
    //
    // ASSERTED AT THE SCHEDULER'S SURFACE, because the daemon binder can no longer
    // reach a member list: the activation gate answers first. `grantSuccessorCapacity`
    // is the production reducer whose returned rows the binder encodes verbatim, so
    // this is the same authority, one layer down — not a helper reimplementing it.
    // BUILT FROM ESCAPES, never from source literals: a combining mark can be
    // folded in transit, and a pair that arrived byte-identical would make this
    // case compare a value against itself and pass while proving nothing.
    const decomposed = "res-e\u0301";
    const composed = "res-\u00e9";
    expect(decomposed).not.toBe(composed);
    expect(decomposed.normalize("NFC")).toBe(composed);
    const rows = cleanRows();
    rows[1] = resourceRow(decomposed);
    const outcome = grantSuccessorCapacity(rows, null);
    if (!outcome.ok) throw new Error(`expected an admitted set, refused with ${
      outcome.issues[0]?.code ?? "UNKNOWN"}`);
    expect(outcome.value.rows.map((row) => row.resourceId))
      .toEqual(["res-1", decomposed, "res-3"]);
    expect(outcome.value.rows.some((row) => row.resourceId === composed)).toBe(false);
  });
});
