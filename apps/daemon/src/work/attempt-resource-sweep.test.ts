import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  PRINCIPAL_ID, PROJECT_ID, cleanupRestoreHarnesses,
} from "../recovery/restore-test-harness.js";
import {
  ATTEMPT_RESOURCE_CODES, ATTEMPT_RESOURCE_MEMBER_KEYS, DAEMON_ATTEMPT_RESOURCE,
  SCHEDULER_RESOURCE_AUTHORITY, deriveAttemptResourceAggregateId,
} from "./attempt-resource-authority-contracts.js";
import type { AttemptResourceOutcome } from "./attempt-resource-authority-contracts.js";
import { bindAttemptResources, readAttemptResources } from "./attempt-resource-authority.js";
import {
  ACTIVATION_AGGREGATE, activatedWith, cleanRows, duplicateRows, resourceRow,
} from "./attempt-resource-test-harness.js";
import type { ResourceFixture } from "./attempt-resource-test-harness.js";

/**
 * Idempotence, conflict, and the generated hostile sweep.
 *
 * IDEMPOTENCE IS PROVED BY RAW COUNTS, not by return values. A writer that
 * appended a second set and then answered from the reader would satisfy any
 * assertion phrased over the answer alone, so every case here reads
 * `store.readEvents(...).length` and the command-decision row directly.
 */

afterEach(cleanupRestoreHarnesses);

const RESOURCE_AGGREGATE = deriveAttemptResourceAggregateId(ACTIVATION_AGGREGATE);

const hostFixture = (label: string): ResourceFixture => activatedWith(label, duplicateRows());

const events = (store: SqliteEventStore): number => store.readEvents(RESOURCE_AGGREGATE).length;

const decisionOf = (fixture: ResourceFixture): unknown =>
  fixture.store.getCommandDecision({
    commandId: `${fixture.binding.commandId}:RESOURCES:0`, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
  });

const read = (fixture: ResourceFixture): AttemptResourceOutcome =>
  readAttemptResources(fixture.store, ACTIVATION_AGGREGATE, PROJECT_ID);

const digestOf = (outcome: AttemptResourceOutcome): string => {
  if (!outcome.ok) throw new Error(`expected a bound set, refused with ${outcome.code}`);
  return outcome.digest;
};

describe("attempt resource authority — idempotence and conflict", () => {
  it("replays a byte-identical bind without appending a second set", () => {
    const fixture = hostFixture("replay");
    const first = bindAttemptResources(fixture.store, fixture.binding, cleanRows());
    // RAW COUNTS, captured before the second call.
    expect(events(fixture.store)).toBe(1);
    const decision = decisionOf(fixture);
    expect(decision).not.toBeNull();

    const again = bindAttemptResources(fixture.store, fixture.binding, cleanRows());
    expect(events(fixture.store)).toBe(1);
    expect(decisionOf(fixture)).toEqual(decision);
    expect(digestOf(again)).toBe(digestOf(first));
    expect(again).toEqual(first);
  });

  it("refuses CONFLICTING bytes under the same key and keeps the ORIGINAL set", () => {
    const fixture = hostFixture("conflict");
    const original = bindAttemptResources(fixture.store, fixture.binding, cleanRows());
    const decision = decisionOf(fixture);

    // Same command key, DIFFERENT member set. The store's idempotency identity
    // covers requestBytes, so this is a conflict rather than a replay.
    const conflicting = bindAttemptResources(fixture.store, fixture.binding,
      [resourceRow("res-1"), resourceRow("res-9")]);
    if (conflicting.ok) throw new Error("a conflicting bind must not be accepted");
    expect({
      authority: conflicting.authority, code: conflicting.code, refusedBy: conflicting.refusedBy,
    }).toEqual({
      authority: "NONE", code: "ATTEMPT_RESOURCE_COMMIT_UNAVAILABLE",
      refusedBy: DAEMON_ATTEMPT_RESOURCE,
    });
    // The STORE refused, not this module's own judgement, so its code survives.
    expect(conflicting.upstreamCode).toBe("IDEMPOTENCY_CONFLICT");

    // A conflicting write must not overwrite the bound set.
    expect(events(fixture.store)).toBe(1);
    expect(decisionOf(fixture)).toEqual(decision);
    expect(read(fixture)).toEqual(original);
  });

  it("refuses a SECOND bind under a different command key on the expected version", () => {
    const fixture = hostFixture("second-key");
    const original = bindAttemptResources(fixture.store, fixture.binding, cleanRows());
    const other = { ...fixture.binding, commandId: "cmd-second-bind" };
    const second = bindAttemptResources(fixture.store, other, [resourceRow("res-9")]);
    if (second.ok) throw new Error("a second bind must not be accepted");
    expect(second.code).toBe("ATTEMPT_RESOURCE_COMMIT_UNAVAILABLE");
    expect(second.refusedBy).toBe(DAEMON_ATTEMPT_RESOURCE);
    // MEASURED, not assumed: the aggregate head answers FIRST. The bind commits
    // at expectedVersion 0, so a second bind observes version 1 and is rejected
    // before the reused grant-derived event id is ever reached. The copied event
    // id is the store-wide backstop behind that, not the first line of defence.
    expect(second.upstreamCode).toBe("EXPECTED_VERSION_CONFLICT");
    expect(events(fixture.store)).toBe(1);
    expect(read(fixture)).toEqual(original);
  });
});

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

const LAYERS: readonly string[] = [DAEMON_ATTEMPT_RESOURCE, SCHEDULER_RESOURCE_AUTHORITY];

describe("attempt resource authority — generated hostile sweep", () => {
  it("refuses every generated hostile bind with a listed code, and never throws", () => {
    const cases = sweepCases();
    const labels = cases.map((testCase) => testCase.label);
    // ASSERTED BEFORE ANY OUTCOME: a sweep that generated nothing would
    // otherwise pass while testing nothing at all. The count is a floor AND every
    // required family is checked by name, because a count alone cannot see a
    // whole class of mutations quietly stopping.
    expect(cases.length).toBeGreaterThan(60);
    expect(new Set(labels).size).toBe(cases.length);
    expect(REQUIRED_LABELS.filter((label) => !labels.includes(label))).toEqual([]);

    const fixture = hostFixture("sweep");
    const accepted: string[] = [];
    const crashed: string[] = [];
    const offLayer: string[] = [];
    const offCode: string[] = [];
    for (const testCase of cases) {
      let outcome: AttemptResourceOutcome;
      // A CRASH IS NOT A REFUSAL. A thrown case is recorded as a failure of this
      // sweep, never swallowed into "it did not succeed".
      try { outcome = bindAttemptResources(fixture.store, fixture.binding, testCase.rows); }
      catch { crashed.push(testCase.label); continue; }
      if (outcome.ok) { accepted.push(testCase.label); continue; }
      if (!LAYERS.includes(outcome.refusedBy)) offLayer.push(testCase.label);
      if (!(ATTEMPT_RESOURCE_CODES as readonly string[]).includes(outcome.code)) {
        offCode.push(testCase.label);
      }
    }
    // Report by NAME so a regression says which case, not merely a count.
    expect({ accepted, crashed, offCode, offLayer })
      .toEqual({ accepted: [], crashed: [], offCode: [], offLayer: [] });
    // Zero residue across the WHOLE sweep: not one hostile case wrote a byte.
    expect(events(fixture.store)).toBe(0);
  });

  it("still binds a clean set after the whole sweep has been refused", () => {
    // POSITIVE CONTROL. Without it the sweep above could pass because the binder
    // refuses everything, including what it should accept.
    const fixture = hostFixture("sweep-control");
    for (const testCase of sweepCases()) {
      // A throw here is already reported by name in the case above.
      try { bindAttemptResources(fixture.store, fixture.binding, testCase.rows); }
      catch { /* the sweep above is what judges a crash */ }
    }
    const outcome = bindAttemptResources(fixture.store, fixture.binding, cleanRows());
    expect(outcome.ok).toBe(true);
    expect(events(fixture.store)).toBe(1);
  });
});

describe("attempt resource authority — opaque text survives verbatim", () => {
  it("binds a non-NFC resource id without normalising it", () => {
    // NOT a refusal case, and deliberately so. A resource id is opaque, and
    // silently normalising one would make two DIFFERENT resources collide on the
    // same member. So the property asserted is byte-preservation, not rejection.
    const decomposed = "res-é";
    const composed = "res-é";
    expect(decomposed).not.toBe(composed);
    expect(decomposed.normalize("NFC")).toBe(composed);
    const fixture = hostFixture("non-nfc");
    const rows = cleanRows();
    rows[1] = resourceRow(decomposed);
    const outcome = bindAttemptResources(fixture.store, fixture.binding, rows);
    if (!outcome.ok) throw new Error(`expected a bound set, refused with ${outcome.code}`);
    expect(outcome.members.map((member) => member.resourceId))
      .toEqual(["res-1", decomposed, "res-3"]);
    expect(outcome.members.some((member) => member.resourceId === composed)).toBe(false);
  });
});
