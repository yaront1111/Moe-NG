import type { EventDraft, SqliteEventStore, StoredEvent } from "@moe/store";
import { types as nodeTypes } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { closeStores, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import {
  buildPolicyWaiverGrant, buildPolicyWaiverRevoke, decodePolicyWaiverRecord,
  policyWaiverAggregateIdFor, type PolicyWaiverGrantInput, type PolicyWaiverRevokeInput,
} from "../bootstrap/policy-waiver-record.js";
import {
  buildPolicyWaiverLeg, foldPolicyWaiverEvents,
  type PolicyWaiverLegResult,
} from "./policy-waiver-leg.js";

const BASE = Object.freeze({
  actionKind: "foundation.dispatch", approvedAt: "2026-08-30T19:51:03.278Z",
  approvedBy: "human:operator-1", commandId: "cmd-waiver-1",
  decisionReason: "Allow one bounded soft exception", expiresAtEpochMs: 1_788_123_063_278,
  namedObligationId: "soft.audit-note",
  policyRevisionRef: `policy-revision:sha256:${"a".repeat(64)}`, projectId: "project-1",
  scope: Object.freeze(["graph.read", "plan.preview"]),
  stepUpAuthRef: `step-up:sha256:${"b".repeat(64)}`, supersedesWaiverRef: null,
}) satisfies PolicyWaiverGrantInput;
type GrantSemantic = Omit<PolicyWaiverGrantInput, "supersedesWaiverRef">;
type RevokeSemantic = Omit<PolicyWaiverRevokeInput, "revokedWaiverRef">;
const grant = (overrides: Partial<GrantSemantic> = {}): GrantSemantic => {
  const { supersedesWaiverRef: _derived, ...semantic } = BASE;
  return { ...semantic, ...overrides };
};
const revoke = (overrides: Partial<RevokeSemantic> = {}): RevokeSemantic => ({
  actionKind: BASE.actionKind, approvedAt: "2026-08-30T20:51:03.278Z",
  approvedBy: BASE.approvedBy, commandId: "cmd-revoke-1",
  decisionReason: "Revoke bounded soft exception", namedObligationId: BASE.namedObligationId,
  policyRevisionRef: BASE.policyRevisionRef, projectId: BASE.projectId,
  scope: BASE.scope, stepUpAuthRef: BASE.stepUpAuthRef, ...overrides,
});
const aggregateId = policyWaiverAggregateIdFor(BASE);

function accepted(result: PolicyWaiverLegResult) {
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result;
}

function commit(store: SqliteEventStore, result: PolicyWaiverLegResult): void {
  const leg = accepted(result).leg;
  store.commit({ aggregateId: leg.aggregateId,
    commandBytes: new TextEncoder().encode(leg.events[0]!.eventId),
    commandId: `seed-${leg.events[0]!.eventId}`,
    committedAt: "2026-08-30T21:00:00.000Z", events: leg.events,
    expectedVersion: leg.expectedVersion });
}

function event(draft: EventDraft, sequence: number, overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    aggregateId, aggregateSequence: sequence, commandId: `stored-command-${sequence}`,
    committedAt: "2026-08-30T21:00:00.000Z", domainSchemaVersion: "test-domain/1",
    eventId: draft.eventId, eventType: draft.eventType, globalPosition: BigInt(sequence),
    metadata: new Uint8Array(), payloadCodecVersion: "moe-opaque-bytes/1",
    payload: draft.payload, recordVersion: "moe-event-record/1",
    requestSha256: "a".repeat(64), ...overrides,
  };
}

function grantDraft(value: PolicyWaiverGrantInput, eventId = value.commandId): EventDraft {
  const built = buildPolicyWaiverGrant(value);
  if (!built.ok) throw new Error(built.code);
  return Object.freeze({ eventId, eventType: built.eventType, payload: built.bytes });
}

function revokeDraft(value: PolicyWaiverRevokeInput, eventId = value.commandId): EventDraft {
  const built = buildPolicyWaiverRevoke(value);
  if (!built.ok) throw new Error(built.code);
  return Object.freeze({ eventId, eventType: built.eventType, payload: built.bytes });
}

function expectRefusal(result: { readonly ok: boolean }, code: string): void {
  expect(result).toEqual({ code, layer: "DAEMON_POLICY_WAIVER", ok: false });
}

describe("policy-waiver history fold and same-read leg", () => {
  afterEach(closeStores);

  it("uses one exact event and the same empty snapshot version", () => {
    const store = openStore();
    const built = accepted(buildPolicyWaiverLeg(store, {
      expectedVersion: 0, kind: "GRANT", value: grant(),
    }));
    expect(built.leg.aggregateId).toBe(aggregateId);
    expect(built.leg.expectedVersion).toBe(0);
    expect(built.leg.events).toHaveLength(1);
    expect(built.leg.events[0]).toEqual({
      eventId: "cmd-waiver-1-PolicyWaiverGranted.v1",
      eventType: "PolicyWaiverGranted.v1", payload: expect.any(Uint8Array),
    });
    const decoded = decodePolicyWaiverRecord("PolicyWaiverGranted.v1", built.leg.events[0]!.payload);
    expect(decoded.ok && decoded.record.supersedesWaiverRef).toBe(null);
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.leg)).toBe(true);
    expect(Object.isFrozen(built.leg.events)).toBe(true);
  });

  it("materializes detached legs and preserves committed bytes after caller mutation", () => {
    const store = openStore();
    const result = accepted(buildPolicyWaiverLeg(store, {
      expectedVersion: 0, kind: "GRANT", value: grant(),
    }));
    const first = result.leg;
    const second = result.leg;
    const firstEvent = first.events[0]!;
    const secondEvent = second.events[0]!;
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.events).not.toBe(second.events);
    expect(firstEvent).not.toBe(secondEvent);
    expect(firstEvent.payload).not.toBe(secondEvent.payload);
    expect(firstEvent.payload.buffer).not.toBe(secondEvent.payload.buffer);
    for (const value of [result, first, first.events, firstEvent]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(nodeTypes.isProxy(firstEvent.payload)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(firstEvent, "payload")).toEqual({
      configurable: false, enumerable: true, value: firstEvent.payload, writable: false,
    });
    const canonicalBytes = Uint8Array.from(secondEvent.payload);
    firstEvent.payload[0] = 0xff;
    expectRefusal(decodePolicyWaiverRecord(firstEvent.eventType as "PolicyWaiverGranted.v1",
      firstEvent.payload), "POLICY_WAIVER_RECORD_UNREADABLE");
    const fresh = result.leg;
    expect(fresh.events[0]!.payload).toEqual(canonicalBytes);
    const decoded = decodePolicyWaiverRecord("PolicyWaiverGranted.v1", fresh.events[0]!.payload);
    if (!decoded.ok) throw new Error(`${decoded.code}@${decoded.layer}`);
    store.commit({ aggregateId: fresh.aggregateId, commandBytes: new Uint8Array(),
      commandId: "copy-owned-commit", committedAt: "2026-08-30T21:00:00.000Z",
      events: fresh.events, expectedVersion: fresh.expectedVersion });
    fresh.events[0]!.payload[0] = 0xff;
    const persisted = store.readEvents(fresh.aggregateId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.payload).toEqual(canonicalBytes);
    const persistedRecord = decodePolicyWaiverRecord("PolicyWaiverGranted.v1", persisted[0]!.payload);
    if (!persistedRecord.ok) throw new Error(`${persistedRecord.code}@${persistedRecord.layer}`);
    expect(persistedRecord.record).toEqual(decoded.record);
  });

  it("snapshots the envelope and semantic value before reading history", () => {
    const value = grant({ projectId: "project-before-read" });
    const input = { expectedVersion: 0, kind: "GRANT" as const, value };
    const originalAggregateId = policyWaiverAggregateIdFor(value);
    const store = {
      readEvents: (observedAggregateId: string) => {
        expect(observedAggregateId).toBe(originalAggregateId);
        value.projectId = "project-after-read";
        input.expectedVersion = 9;
        return [];
      },
    };

    const built = accepted(buildPolicyWaiverLeg(store, input));
    expect(built.leg.aggregateId).toBe(originalAggregateId);
    expect(built.leg.expectedVersion).toBe(0);
    const decoded = decodePolicyWaiverRecord("PolicyWaiverGranted.v1",
      built.leg.events[0]!.payload);
    if (!decoded.ok) throw new Error(`${decoded.code}@${decoded.layer}`);
    expect(decoded.record.projectId).toBe("project-before-read");
    expect(policyWaiverAggregateIdFor(decoded.record)).toBe(built.leg.aggregateId);
  });

  it("folds grant, superseding grant, revoke, and later grant through the real store", () => {
    const store = openStore();
    const first = buildPolicyWaiverLeg(store, { expectedVersion: 0, kind: "GRANT", value: grant() });
    commit(store, first);
    const firstRecord = decodePolicyWaiverRecord("PolicyWaiverGranted.v1",
      accepted(first).leg.events[0]!.payload);
    if (!firstRecord.ok) throw new Error(firstRecord.code);
    const second = buildPolicyWaiverLeg(store, { expectedVersion: 1, kind: "GRANT",
      value: grant({ approvedAt: "2026-08-30T20:01:03.278Z", commandId: "cmd-waiver-2" }) });
    const secondRecord = decodePolicyWaiverRecord("PolicyWaiverGranted.v1",
      accepted(second).leg.events[0]!.payload);
    if (!secondRecord.ok) throw new Error(secondRecord.code);
    expect(secondRecord.record.supersedesWaiverRef).toBe(firstRecord.record.waiverRef);
    commit(store, second);
    const revoked = buildPolicyWaiverLeg(store, { expectedVersion: 2, kind: "REVOKE", value: revoke() });
    const revokedRecord = decodePolicyWaiverRecord("PolicyWaiverRevoked.v1",
      accepted(revoked).leg.events[0]!.payload);
    if (!revokedRecord.ok) throw new Error(revokedRecord.code);
    expect(revokedRecord.record.revokedWaiverRef).toBe(secondRecord.record.waiverRef);
    commit(store, revoked);
    const later = buildPolicyWaiverLeg(store, { expectedVersion: 3, kind: "GRANT",
      value: grant({ approvedAt: "2026-08-30T21:01:03.278Z", commandId: "cmd-waiver-3",
        expiresAtEpochMs: 1_788_127_263_278 }) });
    const laterRecord = decodePolicyWaiverRecord("PolicyWaiverGranted.v1",
      accepted(later).leg.events[0]!.payload);
    if (!laterRecord.ok) throw new Error(laterRecord.code);
    expect(laterRecord.record.supersedesWaiverRef).toBe(secondRecord.record.waiverRef);
    commit(store, later);
    const folded = foldPolicyWaiverEvents(aggregateId, store.readEvents(aggregateId));
    expect(folded.ok && folded.observedVersion).toBe(4);
    expect(folded.ok && folded.grants.map(({ revoked, superseded }) =>
      [revoked, superseded])).toEqual([[false, true], [true, true], [false, false]]);
    if (folded.ok) for (const value of [folded, folded.grants, ...folded.grants]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("groups aggregate authority while selecting obligation and scope as exact tuples", () => {
    const store = openStore();
    const first = buildPolicyWaiverLeg(store, { expectedVersion: 0, kind: "GRANT", value: grant() });
    commit(store, first);
    const other = accepted(buildPolicyWaiverLeg(store, { expectedVersion: 1, kind: "GRANT",
      value: grant({ approvedAt: "2026-08-30T20:11:03.278Z", commandId: "cmd-other",
        namedObligationId: "soft.other", scope: Object.freeze(["graph.read"]) }) }));
    expect(other.leg.aggregateId).toBe(accepted(first).leg.aggregateId);
    const decoded = decodePolicyWaiverRecord("PolicyWaiverGranted.v1", other.leg.events[0]!.payload);
    expect(decoded.ok && decoded.record.supersedesWaiverRef).toBe(null);
  });

  it("reads exactly once, never probes a later version, and fences the caller envelope", () => {
    const seed = grantDraft(BASE, "seed-grant");
    let reads = 0;
    let probes = 0;
    const observable = {
      readEvents: (id: string) => { reads += 1; expect(id).toBe(aggregateId); return [event(seed, 1)]; },
      getAggregateVersion: () => { probes += 1; throw new Error("forbidden second read"); },
    };
    const mismatch = buildPolicyWaiverLeg(observable, { expectedVersion: 0, kind: "GRANT",
      value: grant({ approvedAt: "2026-08-30T20:01:03.278Z", commandId: "cmd-next" }) });
    expectRefusal(mismatch, "POLICY_WAIVER_EXPECTED_VERSION_CONFLICT");
    expect({ reads, probes }).toEqual({ reads: 1, probes: 0 });
    if (false) {
      buildPolicyWaiverLeg(observable, { expectedVersion: 1, kind: "GRANT",
        // @ts-expect-error supersedesWaiverRef is derived from the observed stream
        value: { ...grant(), supersedesWaiverRef: "forged" } });
      buildPolicyWaiverLeg(observable, { expectedVersion: 1, kind: "REVOKE",
        // @ts-expect-error revokedWaiverRef is derived from the observed stream
        value: { ...revoke(), revokedWaiverRef: "forged" } });
    }
  });

  const firstGrant = grantDraft(BASE, "event-1");
  const decodedFirst = decodePolicyWaiverRecord("PolicyWaiverGranted.v1", firstGrant.payload);
  if (!decodedFirst.ok) throw new Error(decodedFirst.code);
  const secondGrant = grantDraft({ ...BASE, approvedAt: "2026-08-30T20:01:03.278Z",
    commandId: "cmd-2", supersedesWaiverRef: decodedFirst.record.waiverRef }, "event-2");
  const standalone = grantDraft({ ...BASE, approvedAt: "2026-08-30T20:01:03.278Z",
    commandId: "cmd-standalone", supersedesWaiverRef: null }, "event-standalone");
  const missingRevoke = revokeDraft({ ...revoke(), revokedWaiverRef: `policy-waiver:sha256:${"f".repeat(64)}` });
  const validRevoke = revokeDraft({ ...revoke(), revokedWaiverRef: decodedFirst.record.waiverRef }, "revoke-1");

  const MALFORMED_CASES = Object.freeze([
    ["unknown event", [event({ ...firstGrant, eventType: "PolicyWaiverUnknown.v1" }, 1)]],
    ["foreign aggregate", [event(firstGrant, 1, { aggregateId: "foreign" })]],
    ["noncontiguous", [event(firstGrant, 2)]],
    ["duplicate event id", [event(firstGrant, 1), event(secondGrant, 2, { eventId: "event-1" })]],
    ["duplicate authority refs", [event(firstGrant, 1), event({ ...firstGrant, eventId: "event-copy" }, 2)]],
    ["invalid bytes", [event({ ...firstGrant, payload: Uint8Array.from([0xff]) }, 1)]],
  ] as const);
  it("refuses every named malformed stream as unreadable at the ledger layer", () => {
    expect(MALFORMED_CASES).toHaveLength(6);
    expect(new Set(MALFORMED_CASES.map(([name]) => name)).size).toBe(6);
    for (const [, events] of MALFORMED_CASES) {
      expectRefusal(foldPolicyWaiverEvents(aggregateId, events), "POLICY_WAIVER_RECORD_UNREADABLE");
    }
  });

  const staleRevoke = revokeDraft({ ...revoke({ approvedAt: "2026-08-30T20:21:03.278Z",
    commandId: "cmd-stale" }), revokedWaiverRef: decodedFirst.record.waiverRef }, "revoke-stale");
  const repeatedRevoke = revokeDraft({ ...revoke({ approvedAt: "2026-08-30T20:31:03.278Z",
    commandId: "cmd-repeat" }), revokedWaiverRef: decodedFirst.record.waiverRef }, "revoke-repeat");
  const CONFLICT_CASES = Object.freeze([
    ["broken immediate supersedes", [event(firstGrant, 1), event(standalone, 2)]],
    ["stale revoke", [event(firstGrant, 1), event(secondGrant, 2), event(staleRevoke, 3)]],
    ["repeated revoke", [event(firstGrant, 1), event(validRevoke, 2), event(repeatedRevoke, 3)]],
  ] as const);
  it("refuses every named hash-valid lineage contradiction as conflict", () => {
    expect(CONFLICT_CASES).toHaveLength(3);
    expect(new Set(CONFLICT_CASES.map(([name]) => name)).size).toBe(3);
    for (const [, events] of CONFLICT_CASES) {
      expectRefusal(foldPolicyWaiverEvents(aggregateId, events), "POLICY_WAIVER_RECORD_CONFLICT");
    }
  });

  it("distinguishes a missing revoke target from malformed and conflicting history", () => {
    expectRefusal(foldPolicyWaiverEvents(aggregateId, [event(missingRevoke, 1)]),
      "POLICY_WAIVER_RECORD_MISSING");
  });
});
