/**
 * Hostile focused coverage for the durable policy-waiver reader.
 *
 * Supersession note (governor ruling comment-3179250312934a0ba29cf11e57fd2eb1, amending DoD 3):
 * a grant is superseded only by a LATER grant that itself satisfies every join and every
 * validity condition. The landed fold marks supersession by LINEAGE instead
 * (policy-waiver-leg.ts:138 "Revocation ends authority, not lineage"), so the first two arms
 * below exist to red any reader that trusts `candidate.superseded`.
 */
import type { PolicyObligation, PolicyObligationKind, PolicySlice } from "@moe/core";
import { EVENT_RECORD_VERSION, OPAQUE_PAYLOAD_CODEC_VERSION } from "@moe/store";
import type { StoredEvent } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  POLICY_WAIVER_EVENT_TYPES,
  POLICY_WAIVER_RECORD_CODES,
  buildPolicyWaiverGrant,
  buildPolicyWaiverRevoke,
  policyWaiverAggregateIdFor,
} from "./policy-waiver-record.js";
import type { PolicyWaiverGrantRecord, PolicyWaiverRecord } from "./policy-waiver-record.js";
import { POLICY_WAIVER_READER_CODES, readPolicyWaiver } from "./policy-waiver-reader.js";
import type {
  PolicyWaiverEventStoreReader,
  PolicyWaiverReadInput,
  PolicyWaiverReadResult,
} from "./policy-waiver-reader.js";

// Expected literals are test-owned; the production rosters above are imported only as SUBJECTS.
const EXPECTED_READER_CODES = Object.freeze([
  "POLICY_WAIVER_RECORD_MISSING", "POLICY_WAIVER_RECORD_UNREADABLE",
  "POLICY_WAIVER_EXPIRED", "POLICY_WAIVER_REVOKED", "POLICY_WAIVER_SUPERSEDED",
  "POLICY_WAIVER_PROJECT_FOREIGN", "POLICY_WAIVER_PRINCIPAL_FOREIGN",
  "POLICY_WAIVER_ACTION_FOREIGN", "POLICY_WAIVER_POLICY_STALE",
  "POLICY_WAIVER_OBLIGATION_FOREIGN", "POLICY_WAIVER_SCOPE_FOREIGN",
  "POLICY_WAIVER_NOT_SOFT",
] as const);
const EXPECTED_RECORD_CODES = Object.freeze([
  "POLICY_WAIVER_RECORD_INVALID", "POLICY_WAIVER_RECORD_UNREADABLE",
  "POLICY_WAIVER_RECORD_CONFLICT",
] as const);
const EXPECTED_EVENT_TYPES = Object.freeze([
  "PolicyWaiverGranted.v1", "PolicyWaiverRevoked.v1",
] as const);
const EXPECTED_LAYER = "DAEMON_POLICY_WAIVER";
const EXPECTED_CORE_WAIVER_KEYS = Object.freeze([
  "expiresAtEpochMs", "humanApprovalRef", "namedObligationId", "scope", "waiverRef",
] as const);

const PROJECT_ID = "project.waiver-reader";
const PRINCIPAL = "principal.waiver-reader";
const ACTION = "policy.validate";
const POLICY_REVISION = "7".repeat(64);
const OTHER_POLICY_REVISION = "9".repeat(64);
const OBLIGATION = "obligation.soft.waivable";
const OTHER_OBLIGATION = "obligation.soft.other";
const SCOPE = Object.freeze(["scope.alpha", "scope.beta"] as const);
const APPROVED_AT = "2026-09-01T00:00:00.000Z";
const APPROVED_MS = Date.parse(APPROVED_AT);
const EXPIRES_MS = APPROVED_MS + 3_600_000;
const EVALUATED_MS = EXPIRES_MS - 1;
const STEP_UP = "step-up:waiver-reader";
const REASON = "human approved waiver for the reader suite";
const AGGREGATE_PREFIX = "policy-waiver:aggregate:v1:sha256:";

interface Built {
  readonly bytes: Uint8Array;
  readonly eventType: string;
  readonly record: Readonly<PolicyWaiverRecord>;
}
interface GrantOver {
  readonly actionKind?: string;
  readonly approvedBy?: string;
  readonly commandId?: string;
  readonly expiresAtEpochMs?: number;
  readonly namedObligationId?: string;
  readonly policyRevisionRef?: string;
  readonly projectId?: string;
  readonly scope?: readonly string[];
  readonly supersedesWaiverRef?: string | null;
}

function grant(over: GrantOver = {}): { readonly bytes: Uint8Array; readonly eventType: string;
  readonly record: PolicyWaiverGrantRecord; } {
  const built = buildPolicyWaiverGrant({
    actionKind: over.actionKind ?? ACTION,
    approvedAt: APPROVED_AT,
    approvedBy: over.approvedBy ?? PRINCIPAL,
    commandId: over.commandId ?? "command.waiver-1",
    decisionReason: REASON,
    expiresAtEpochMs: over.expiresAtEpochMs ?? EXPIRES_MS,
    namedObligationId: over.namedObligationId ?? OBLIGATION,
    policyRevisionRef: over.policyRevisionRef ?? POLICY_REVISION,
    projectId: over.projectId ?? PROJECT_ID,
    scope: [...(over.scope ?? SCOPE)],
    stepUpAuthRef: STEP_UP,
    supersedesWaiverRef: over.supersedesWaiverRef ?? null,
  });
  if (!built.ok) throw new Error(`grant fixture refused: ${built.code}`);
  return built;
}

function revoke(target: PolicyWaiverGrantRecord, commandId: string): Built {
  const built = buildPolicyWaiverRevoke({
    actionKind: target.actionKind,
    approvedAt: APPROVED_AT,
    approvedBy: target.approvedBy,
    commandId,
    decisionReason: REASON,
    namedObligationId: target.namedObligationId,
    policyRevisionRef: target.policyRevisionRef,
    projectId: target.projectId,
    revokedWaiverRef: target.waiverRef,
    scope: [...target.scope],
    stepUpAuthRef: STEP_UP,
  });
  if (!built.ok) throw new Error(`revoke fixture refused: ${built.code}`);
  return built;
}

function storedEvent(
  aggregateId: string, sequence: number, eventType: string, payload: Uint8Array,
): StoredEvent {
  return {
    aggregateId,
    aggregateSequence: sequence,
    commandId: `command-${aggregateId}-${sequence}`,
    committedAt: APPROVED_AT,
    domainSchemaVersion: "moe-domain/1",
    eventId: `${aggregateId}#${sequence}`,
    eventType,
    globalPosition: BigInt(sequence),
    metadata: new Uint8Array(),
    payload,
    payloadCodecVersion: OPAQUE_PAYLOAD_CODEC_VERSION,
    recordVersion: EVENT_RECORD_VERSION,
    requestSha256: "0".repeat(64),
  };
}

function fakeStore(
  aggregates: ReadonlyMap<string, readonly StoredEvent[]>,
): PolicyWaiverEventStoreReader {
  return {
    enumerateAggregateIdsByPrefix: (prefix: string) =>
      [...aggregates.keys()].filter((id) => id.startsWith(prefix)).sort(),
    readEvents: (aggregateId: string) => aggregates.get(aggregateId) ?? [],
  };
}

function aggregatesOf(entries: readonly Built[]): Map<string, StoredEvent[]> {
  const byAggregate = new Map<string, StoredEvent[]>();
  for (const entry of entries) {
    const aggregateId = policyWaiverAggregateIdFor(entry.record);
    const events = byAggregate.get(aggregateId) ?? [];
    events.push(storedEvent(aggregateId, events.length + 1, entry.eventType, entry.bytes));
    byAggregate.set(aggregateId, events);
  }
  return byAggregate;
}

const storeOf = (...entries: readonly Built[]): PolicyWaiverEventStoreReader =>
  fakeStore(aggregatesOf(entries));

function obligationSlice(sliceRef: string, obligations: readonly PolicyObligation[]): PolicySlice {
  return {
    autoApprovalOptIns: [],
    rules: [{ effect: "ALLOW", obligations, requiredFactIds: [], ruleId: `${sliceRef}.rule` }],
    sliceRef,
  };
}
const named = (kind: PolicyObligationKind, obligationId = OBLIGATION): PolicyObligation =>
  ({ kind, obligationId });
const softChain = (): readonly PolicySlice[] => [obligationSlice("slice.root", [named("SOFT")])];

function readerInput(over: Partial<PolicyWaiverReadInput> = {}): PolicyWaiverReadInput {
  return {
    authenticatedPrincipal: PRINCIPAL,
    evaluatedAction: ACTION,
    evaluatedAtEpochMs: EVALUATED_MS,
    installedPolicyRevisionRef: POLICY_REVISION,
    installedSliceChain: softChain(),
    namedObligationId: OBLIGATION,
    projectId: PROJECT_ID,
    scope: [...SCOPE],
    ...over,
  };
}

function expectRefusal(result: PolicyWaiverReadResult, code: string): void {
  if (result.ok) throw new Error(`expected refusal ${code}, got an accepted waiver`);
  expect(result.code).toBe(code);
  expect(result.layer).toBe(EXPECTED_LAYER);
  expect(Object.keys(result).sort()).toEqual(["code", "layer", "ok"]);
}

function expectAccepted(result: PolicyWaiverReadResult, waiverRef: string): void {
  if (!result.ok) throw new Error(`expected an accepted waiver, got ${result.code}`);
  expect(result.waiver.waiverRef).toBe(waiverRef);
}

describe("policy-waiver reader rosters", () => {
  it("pins the exact 12-code reader roster and the literal refusing layer", () => {
    expect(POLICY_WAIVER_READER_CODES.length).toBe(12);
    expect(EXPECTED_READER_CODES.length).toBe(12);
    expect([...POLICY_WAIVER_READER_CODES]).toEqual([...EXPECTED_READER_CODES]);
    const refused = readPolicyWaiver(storeOf(), readerInput());
    if (refused.ok) throw new Error("empty history must refuse");
    expect(refused.layer).toBe(EXPECTED_LAYER);
  });

  it("pins the record and event roster denominators", () => {
    expect(POLICY_WAIVER_RECORD_CODES.length).toBe(3);
    expect([...POLICY_WAIVER_RECORD_CODES]).toEqual([...EXPECTED_RECORD_CODES]);
    expect(POLICY_WAIVER_EVENT_TYPES.length).toBe(2);
    expect([...POLICY_WAIVER_EVENT_TYPES]).toEqual([...EXPECTED_EVENT_TYPES]);
  });
});

describe("policy-waiver reader supersession", () => {
  it("does not treat a predecessor as displaced when the successor is itself EXPIRED", () => {
    const first = grant();
    const successor = grant({
      commandId: "command.waiver-2",
      expiresAtEpochMs: APPROVED_MS + 1,
      supersedesWaiverRef: first.record.waiverRef,
    });
    expectAccepted(readPolicyWaiver(storeOf(first, successor), readerInput()),
      first.record.waiverRef);
  });

  it("does not treat a predecessor as displaced when the successor is itself REVOKED", () => {
    const first = grant();
    const successor = grant({
      commandId: "command.waiver-2", supersedesWaiverRef: first.record.waiverRef,
    });
    const tombstone = revoke(successor.record, "command.revoke-2");
    expectAccepted(readPolicyWaiver(storeOf(first, successor, tombstone), readerInput()),
      first.record.waiverRef);
  });

  it("returns the later grant, never the displaced predecessor, when the successor is valid", () => {
    const first = grant();
    const successor = grant({
      commandId: "command.waiver-2", supersedesWaiverRef: first.record.waiverRef,
    });
    const result = readPolicyWaiver(storeOf(first, successor), readerInput());
    expectAccepted(result, successor.record.waiverRef);
    if (!result.ok) throw new Error("unreachable");
    expect(result.waiver.waiverRef).not.toBe(first.record.waiverRef);
    expect(result.waiver.humanApprovalRef).toBe(successor.record.humanApprovalRef);
  });

  it("never emits POLICY_WAIVER_SUPERSEDED from the ref-less discovery surface", () => {
    const first = grant();
    const successor = grant({
      commandId: "command.waiver-2", supersedesWaiverRef: first.record.waiverRef,
    });
    const expiredSuccessor = grant({
      commandId: "command.waiver-3", expiresAtEpochMs: APPROVED_MS + 1,
      supersedesWaiverRef: first.record.waiverRef,
    });
    const histories: readonly (readonly Built[])[] = Object.freeze([
      [first, successor],
      [first, expiredSuccessor],
      [first, successor, revoke(successor.record, "command.revoke-2")],
      [first, revoke(first.record, "command.revoke-1")],
    ]);
    expect(histories.length).toBe(4);
    for (const history of histories) {
      const result = readPolicyWaiver(storeOf(...history), readerInput());
      if (!result.ok) expect(result.code).not.toBe("POLICY_WAIVER_SUPERSEDED");
    }
  });
});

const JOIN_MATRIX = Object.freeze([
  Object.freeze({ code: "POLICY_WAIVER_PROJECT_FOREIGN", label: "project",
    over: { projectId: "project.other" } as Partial<PolicyWaiverReadInput> }),
  Object.freeze({ code: "POLICY_WAIVER_PRINCIPAL_FOREIGN", label: "principal",
    over: { authenticatedPrincipal: "principal.other" } as Partial<PolicyWaiverReadInput> }),
  Object.freeze({ code: "POLICY_WAIVER_ACTION_FOREIGN", label: "action",
    over: { evaluatedAction: "policy.other" } as Partial<PolicyWaiverReadInput> }),
  Object.freeze({ code: "POLICY_WAIVER_POLICY_STALE", label: "policyRevisionRef",
    over: { installedPolicyRevisionRef: OTHER_POLICY_REVISION } as Partial<PolicyWaiverReadInput> }),
  Object.freeze({ code: "POLICY_WAIVER_OBLIGATION_FOREIGN", label: "obligation",
    over: {
      installedSliceChain: [obligationSlice("slice.root", [named("SOFT", OTHER_OBLIGATION)])],
      namedObligationId: OTHER_OBLIGATION,
    } as Partial<PolicyWaiverReadInput> }),
  Object.freeze({ code: "POLICY_WAIVER_SCOPE_FOREIGN", label: "scope",
    over: { scope: ["scope.gamma"] } as Partial<PolicyWaiverReadInput> }),
]);

const SOFT_MATRIX = Object.freeze([
  Object.freeze({ chain: [] as readonly PolicySlice[],
    code: "POLICY_WAIVER_OBLIGATION_FOREIGN", label: "obligation is absent from the slice chain" }),
  Object.freeze({
    chain: [obligationSlice("slice.a", [named("SOFT")]),
      obligationSlice("slice.b", [named("SOFT")])] as readonly PolicySlice[],
    code: "POLICY_WAIVER_NOT_SOFT", label: "obligation is ambiguous across two SOFT occurrences" }),
  Object.freeze({ chain: [obligationSlice("slice.root", [named("HARD")])] as readonly PolicySlice[],
    code: "POLICY_WAIVER_NOT_SOFT", label: "obligation occurs only as HARD" }),
  Object.freeze({
    chain: [obligationSlice("slice.a", [named("SOFT")]),
      obligationSlice("slice.b", [named("HARD")])] as readonly PolicySlice[],
    code: "POLICY_WAIVER_NOT_SOFT", label: "obligation occurs as both SOFT and HARD" }),
]);

describe("policy-waiver reader ordered joins", () => {
  it("pins the join matrix denominator", () => {
    expect(JOIN_MATRIX.length).toBe(6);
  });

  it.each(JOIN_MATRIX)("refuses a single $label divergence with $code", ({ code, over }) => {
    expectRefusal(readPolicyWaiver(storeOf(grant()), readerInput(over)), code);
  });

  it("accepts the fully joined grant that every divergence fixture starts from", () => {
    const only = grant();
    expectAccepted(readPolicyWaiver(storeOf(only), readerInput()), only.record.waiverRef);
  });

  it("pins the SOFT-uniqueness matrix denominator", () => {
    expect(SOFT_MATRIX.length).toBe(4);
  });

  it.each(SOFT_MATRIX)("refuses with $code when the $label", ({ chain, code }) => {
    expectRefusal(
      readPolicyWaiver(storeOf(grant()), readerInput({ installedSliceChain: chain })), code);
  });
});

const HOSTILE_INSTANTS = Object.freeze([
  Object.freeze({ instant: Number.NaN, label: "NaN" }),
  Object.freeze({ instant: Number.POSITIVE_INFINITY, label: "positive Infinity" }),
  Object.freeze({ instant: Number.NEGATIVE_INFINITY, label: "negative Infinity" }),
  Object.freeze({ instant: EVALUATED_MS + 0.5, label: "a fractional instant" }),
]);

describe("policy-waiver reader validity", () => {
  it("pins the hostile evaluation-instant denominator", () => {
    expect(HOSTILE_INSTANTS.length).toBe(4);
  });

  it.each(HOSTILE_INSTANTS)("expires rather than granting authority on $label", ({ instant }) => {
    expectRefusal(
      readPolicyWaiver(storeOf(grant()), readerInput({ evaluatedAtEpochMs: instant })),
      "POLICY_WAIVER_EXPIRED");
  });

  it("keeps a predecessor in force when the successor expires at the evaluation instant", () => {
    const first = grant({ expiresAtEpochMs: EXPIRES_MS });
    const successor = grant({
      commandId: "command.waiver-2",
      expiresAtEpochMs: EXPIRES_MS - 1,
      supersedesWaiverRef: first.record.waiverRef,
    });
    expectAccepted(
      readPolicyWaiver(storeOf(first, successor),
        readerInput({ evaluatedAtEpochMs: EXPIRES_MS - 1 })),
      first.record.waiverRef);
  });

  it("selects by durable event order, not by approval timestamp, for same-instant grants", () => {
    const first = grant();
    const successor = grant({
      commandId: "command.waiver-2", supersedesWaiverRef: first.record.waiverRef,
    });
    expect(successor.record.approvedAt).toBe(first.record.approvedAt);
    expectAccepted(readPolicyWaiver(storeOf(first, successor), readerInput()),
      successor.record.waiverRef);
  });

  it("refuses an empty requested scope rather than treating it as unscoped", () => {
    expectRefusal(readPolicyWaiver(storeOf(grant()), readerInput({ scope: [] })),
      "POLICY_WAIVER_SCOPE_FOREIGN");
  });

  it("treats a history that opens with a revoke as unreadable", () => {
    const only = grant();
    const aggregates = aggregatesOf([only, revoke(only.record, "command.revoke-1")]);
    const aggregateId = [...aggregates.keys()][0]!;
    const events = aggregates.get(aggregateId)!;
    events.splice(0, 1);
    events[0] = { ...events[0]!, aggregateSequence: 1 };
    expectRefusal(readPolicyWaiver(fakeStore(aggregates), readerInput()),
      "POLICY_WAIVER_RECORD_UNREADABLE");
  });

  it("treats a second revoke of an already-revoked grant as unreadable", () => {
    const only = grant();
    expectRefusal(
      readPolicyWaiver(
        storeOf(only, revoke(only.record, "command.revoke-1"),
          revoke(only.record, "command.revoke-2")),
        readerInput()),
      "POLICY_WAIVER_RECORD_UNREADABLE");
  });

  it("treats expiry as exclusive at exact equality", () => {
    const only = grant();
    expectRefusal(
      readPolicyWaiver(storeOf(only), readerInput({ evaluatedAtEpochMs: EXPIRES_MS })),
      "POLICY_WAIVER_EXPIRED");
    expectAccepted(
      readPolicyWaiver(storeOf(only), readerInput({ evaluatedAtEpochMs: EXPIRES_MS - 1 })),
      only.record.waiverRef);
  });

  it("reports a tombstoned current grant as revoked", () => {
    const only = grant();
    expectRefusal(
      readPolicyWaiver(storeOf(only, revoke(only.record, "command.revoke-1")), readerInput()),
      "POLICY_WAIVER_REVOKED");
  });

  it("accepts a scope that is the same set in a different order", () => {
    const only = grant();
    expectAccepted(
      readPolicyWaiver(storeOf(only), readerInput({ scope: ["scope.beta", "scope.alpha"] })),
      only.record.waiverRef);
  });

  it("refuses a scope that is a strict subset of the granted set", () => {
    expectRefusal(
      readPolicyWaiver(storeOf(grant()), readerInput({ scope: ["scope.alpha"] })),
      "POLICY_WAIVER_SCOPE_FOREIGN");
  });
});

const UNREADABLE_MATRIX = Object.freeze([
  Object.freeze({ label: "an enumerated aggregate with no events",
    mutate: (events: StoredEvent[]): void => { events.splice(0, events.length); } }),
  Object.freeze({ label: "an event whose type is outside the waiver roster",
    mutate: (events: StoredEvent[]): void => {
      events[0] = { ...events[0]!, eventType: "PolicyWaiverImagined.v1" };
    } }),
  Object.freeze({ label: "an out-of-order aggregate sequence",
    mutate: (events: StoredEvent[]): void => {
      events[0] = { ...events[0]!, aggregateSequence: 7 };
    } }),
  Object.freeze({ label: "a tampered payload byte",
    mutate: (events: StoredEvent[]): void => {
      const payload = Uint8Array.from(events[0]!.payload);
      payload[payload.length - 2] = payload[payload.length - 2]! ^ 0x01;
      events[0] = { ...events[0]!, payload };
    } }),
  Object.freeze({ label: "a payload committed under a foreign aggregate id",
    mutate: (events: StoredEvent[]): void => {
      events[0] = { ...events[0]!, payload: grant({ projectId: "project.other" }).bytes };
    } }),
]);

describe("policy-waiver reader fails closed without authority", () => {
  it("pins the unreadable matrix denominator", () => {
    expect(UNREADABLE_MATRIX.length).toBe(5);
  });

  it.each(UNREADABLE_MATRIX)("refuses $label as unreadable", ({ mutate }) => {
    const aggregates = aggregatesOf([grant()]);
    const aggregateId = [...aggregates.keys()][0]!;
    mutate(aggregates.get(aggregateId)!);
    expectRefusal(readPolicyWaiver(fakeStore(aggregates), readerInput()),
      "POLICY_WAIVER_RECORD_UNREADABLE");
  });

  it("refuses without authority when enumeration throws", () => {
    const store: PolicyWaiverEventStoreReader = {
      enumerateAggregateIdsByPrefix: (): readonly string[] => { throw new Error("store down"); },
      readEvents: (): readonly StoredEvent[] => [],
    };
    expectRefusal(readPolicyWaiver(store, readerInput()), "POLICY_WAIVER_RECORD_UNREADABLE");
  });

  it("refuses without authority when the event tail read throws", () => {
    const aggregates = aggregatesOf([grant()]);
    const store: PolicyWaiverEventStoreReader = {
      enumerateAggregateIdsByPrefix: (prefix: string) =>
        [...aggregates.keys()].filter((id) => id.startsWith(prefix)),
      readEvents: (): readonly StoredEvent[] => { throw new Error("tail unreadable"); },
    };
    expectRefusal(readPolicyWaiver(store, readerInput()), "POLICY_WAIVER_RECORD_UNREADABLE");
  });

  it("reports missing history when no waiver aggregate exists", () => {
    expectRefusal(readPolicyWaiver(storeOf(), readerInput()), "POLICY_WAIVER_RECORD_MISSING");
  });

  it("enumerates only the versioned policy-waiver aggregate prefix", () => {
    const seen: string[] = [];
    const aggregates = aggregatesOf([grant()]);
    const store: PolicyWaiverEventStoreReader = {
      enumerateAggregateIdsByPrefix: (prefix: string) => {
        seen.push(prefix);
        return [...aggregates.keys()].filter((id) => id.startsWith(prefix));
      },
      readEvents: (aggregateId: string) => aggregates.get(aggregateId) ?? [],
    };
    const result = readPolicyWaiver(store, readerInput());
    expect(result.ok).toBe(true);
    expect(seen).toEqual([AGGREGATE_PREFIX]);
  });
});

describe("policy-waiver reader accepted shape", () => {
  it("returns only the canonical core waiver fields plus the observed aggregate fence", () => {
    const only = grant();
    const aggregates = aggregatesOf([only]);
    const aggregateId = [...aggregates.keys()][0]!;
    const result = readPolicyWaiver(fakeStore(aggregates), readerInput());
    if (!result.ok) throw new Error(`expected an accepted waiver, got ${result.code}`);
    expect(Object.keys(result).sort()).toEqual(["aggregateId", "observedVersion", "ok", "waiver"]);
    expect(Object.keys(result.waiver).sort()).toEqual([...EXPECTED_CORE_WAIVER_KEYS]);
    expect(result.aggregateId).toBe(aggregateId);
    expect(result.aggregateId.startsWith(AGGREGATE_PREFIX)).toBe(true);
    expect(result.observedVersion).toBe(1);
    expect(result.waiver.expiresAtEpochMs).toBe(only.record.expiresAtEpochMs);
    expect(result.waiver.humanApprovalRef).toBe(only.record.humanApprovalRef);
    expect(result.waiver.namedObligationId).toBe(OBLIGATION);
    expect([...result.waiver.scope]).toEqual([...SCOPE]);
    expect(result.waiver.waiverRef).toBe(only.record.waiverRef);
  });

  it("reports the version observed from the same read that produced the bytes", () => {
    const first = grant();
    const successor = grant({
      commandId: "command.waiver-2", supersedesWaiverRef: first.record.waiverRef,
    });
    const result = readPolicyWaiver(storeOf(first, successor), readerInput());
    if (!result.ok) throw new Error(`expected an accepted waiver, got ${result.code}`);
    expect(result.observedVersion).toBe(2);
  });
});
