import { describe, expect, it } from "vitest";

import {
  DAEMON_POLICY_WAIVER,
  POLICY_WAIVER_EVENT_TYPES,
  POLICY_WAIVER_GRANTED_KEYS,
  POLICY_WAIVER_READER_CODES,
  POLICY_WAIVER_RECORD_CODES,
  POLICY_WAIVER_REVOKED_KEYS,
  POLICY_WAIVER_WRITER_CODES,
  buildPolicyWaiverGrant,
  buildPolicyWaiverRevoke,
  decodePolicyWaiverRecord,
  policyWaiverAggregateIdFor,
  policyWaiverRefusal,
  policyWaiverTupleKeyFor,
  samePolicyWaiverTuple,
  type PolicyWaiverGrantInput,
  type PolicyWaiverRevokeInput,
} from "./policy-waiver-record.js";

const APPROVED_AT = "2026-08-30T19:51:03.278Z";
const EXPIRES_AT = 1_788_123_063_278;
const BASE = Object.freeze({
  actionKind: "foundation.dispatch",
  approvedAt: APPROVED_AT,
  approvedBy: "human:operator-1",
  commandId: "cmd-waiver-1",
  decisionReason: "Allow one bounded soft exception",
  expiresAtEpochMs: EXPIRES_AT,
  namedObligationId: "soft.audit-note",
  policyRevisionRef: `policy-revision:sha256:${"a".repeat(64)}`,
  projectId: "project-1",
  scope: Object.freeze(["graph.read", "plan.preview"]),
  stepUpAuthRef: `step-up:sha256:${"b".repeat(64)}`,
  supersedesWaiverRef: null,
}) satisfies PolicyWaiverGrantInput;

const input = (overrides: Partial<PolicyWaiverGrantInput> = {}): PolicyWaiverGrantInput =>
  ({ ...BASE, ...overrides });

function grantOf(value: PolicyWaiverGrantInput = BASE) {
  const result = buildPolicyWaiverGrant(value);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result;
}

function revokeInput(revokedWaiverRef: string): PolicyWaiverRevokeInput {
  return {
    actionKind: BASE.actionKind,
    approvedAt: "2026-08-30T20:51:03.278Z",
    approvedBy: BASE.approvedBy,
    commandId: "cmd-waiver-revoke-1",
    decisionReason: "Revoke bounded soft exception",
    namedObligationId: BASE.namedObligationId,
    policyRevisionRef: BASE.policyRevisionRef,
    projectId: BASE.projectId,
    scope: BASE.scope,
    stepUpAuthRef: BASE.stepUpAuthRef,
    revokedWaiverRef,
  };
}

function expectRefusal(result: { readonly ok: boolean }, code: string): void {
  expect(result).toEqual({ code, layer: "DAEMON_POLICY_WAIVER", ok: false });
}

describe("immutable policy-waiver record", () => {
  it("pins every closed roster with an independent exact denominator", () => {
    expect(POLICY_WAIVER_EVENT_TYPES).toEqual([
      "PolicyWaiverGranted.v1", "PolicyWaiverRevoked.v1",
    ]);
    expect(POLICY_WAIVER_EVENT_TYPES).toHaveLength(2);
    expect(POLICY_WAIVER_GRANTED_KEYS).toEqual([
      "actionKind", "approvedAt", "approvedBy", "commandId", "decisionReason",
      "expiresAtEpochMs", "humanApprovalRef", "namedObligationId", "policyRevisionRef",
      "projectId", "scope", "stepUpAuthRef", "supersedesWaiverRef", "waiverRef",
    ]);
    expect(POLICY_WAIVER_GRANTED_KEYS).toHaveLength(14);
    expect(POLICY_WAIVER_REVOKED_KEYS).toEqual([
      "actionKind", "approvedAt", "approvedBy", "commandId", "decisionReason",
      "humanApprovalRef", "namedObligationId", "policyRevisionRef", "projectId",
      "scope", "stepUpAuthRef", "revokedWaiverRef",
    ]);
    expect(POLICY_WAIVER_REVOKED_KEYS).toHaveLength(12);
    expect(POLICY_WAIVER_RECORD_CODES).toEqual([
      "POLICY_WAIVER_RECORD_INVALID", "POLICY_WAIVER_RECORD_UNREADABLE",
      "POLICY_WAIVER_RECORD_CONFLICT",
    ]);
    expect(POLICY_WAIVER_RECORD_CODES).toHaveLength(3);
    expect(POLICY_WAIVER_READER_CODES).toEqual([
      "POLICY_WAIVER_RECORD_MISSING", "POLICY_WAIVER_RECORD_UNREADABLE",
      "POLICY_WAIVER_EXPIRED", "POLICY_WAIVER_REVOKED", "POLICY_WAIVER_SUPERSEDED",
      "POLICY_WAIVER_PROJECT_FOREIGN", "POLICY_WAIVER_PRINCIPAL_FOREIGN",
      "POLICY_WAIVER_ACTION_FOREIGN", "POLICY_WAIVER_POLICY_STALE",
      "POLICY_WAIVER_OBLIGATION_FOREIGN", "POLICY_WAIVER_SCOPE_FOREIGN",
      "POLICY_WAIVER_NOT_SOFT",
    ]);
    expect(POLICY_WAIVER_READER_CODES).toHaveLength(12);
    expect(POLICY_WAIVER_WRITER_CODES).toEqual(["POLICY_WAIVER_EXPECTED_VERSION_CONFLICT"]);
    expect(POLICY_WAIVER_WRITER_CODES).toHaveLength(1);
    for (const roster of [
      POLICY_WAIVER_EVENT_TYPES, POLICY_WAIVER_GRANTED_KEYS, POLICY_WAIVER_REVOKED_KEYS,
      POLICY_WAIVER_RECORD_CODES, POLICY_WAIVER_READER_CODES, POLICY_WAIVER_WRITER_CODES,
    ]) expect(Object.isFrozen(roster)).toBe(true);
  });

  it("derives the server-only refs and aggregate from pinned domain-separated exemplars", () => {
    const built = grantOf();
    expect(DAEMON_POLICY_WAIVER).toBe("DAEMON_POLICY_WAIVER");
    expect(built.record.humanApprovalRef).toBe(
      "approval:policy-waiver:sha256:8fbe344413b803826c323cfcd02e9bef751cdcef5f37a9b6b16251b047fb60dc",
    );
    expect(built.record.waiverRef).toBe(
      "policy-waiver:sha256:3d8b18efdae181669a65273311c34de18955a0128f397f92a29584eaea0f4eed",
    );
    expect(policyWaiverAggregateIdFor(BASE)).toBe(
      "policy-waiver:aggregate:v1:sha256:0b14a69c6de91f9b8ab42317d1db2577dcf1b3b9a58430e27fd4a53c63f07f97",
    );
    expect(policyWaiverRefusal("POLICY_WAIVER_EXPIRED")).toEqual({
      code: "POLICY_WAIVER_EXPIRED", layer: DAEMON_POLICY_WAIVER, ok: false,
    });
    if (false) {
      // @ts-expect-error the server, never a caller, derives humanApprovalRef
      buildPolicyWaiverGrant({ ...BASE, humanApprovalRef: "forged" });
      // @ts-expect-error the server, never a caller, derives waiverRef
      buildPolicyWaiverGrant({ ...BASE, waiverRef: "forged" });
    }
  });

  it("round-trips canonical grant and revoke bytes into frozen inert snapshots", () => {
    const mutableScope = [...BASE.scope];
    const granted = grantOf(input({ scope: mutableScope }));
    mutableScope[0] = "smuggled";
    const decodedGrant = decodePolicyWaiverRecord(granted.eventType, granted.bytes);
    expect(decodedGrant).toEqual(granted);
    if (!decodedGrant.ok) throw new Error(decodedGrant.code);
    const revoked = buildPolicyWaiverRevoke(revokeInput(decodedGrant.record.waiverRef));
    if (!revoked.ok) throw new Error(revoked.code);
    expect(decodePolicyWaiverRecord(revoked.eventType, revoked.bytes)).toEqual(revoked);
    for (const accepted of [decodedGrant, revoked]) {
      expect(Object.isFrozen(accepted)).toBe(true);
      expect(Object.isFrozen(accepted.record)).toBe(true);
      expect(Object.isFrozen(accepted.record.scope)).toBe(true);
    }
    expect(decodedGrant.record.scope).toEqual(["graph.read", "plan.preview"]);
  });

  it("accepts every exact upper boundary and rejects the next value", () => {
    const scope = Object.freeze(Array.from({ length: 64 }, (_, index) =>
      `scope-${String(index).padStart(2, "0")}`));
    const acceptedBoundary = buildPolicyWaiverGrant(input({
      actionKind: "x".repeat(512), commandId: "c".repeat(489), decisionReason: "r".repeat(2048),
      expiresAtEpochMs: Date.parse(APPROVED_AT) + 86_400_000, scope,
    }));
    expect(acceptedBoundary.ok).toBe(true);
    if (acceptedBoundary.ok) expect(new TextEncoder().encode(
      `${acceptedBoundary.record.commandId}-${acceptedBoundary.eventType}`).byteLength).toBe(512);
    const BOUNDARY_REJECTIONS = Object.freeze([
      input({ actionKind: "x".repeat(513) }),
      input({ commandId: "c".repeat(490) }),
      input({ decisionReason: "r".repeat(2049) }),
      input({ scope: Object.freeze([...scope, "scope-64"]) }),
      input({ expiresAtEpochMs: Date.parse(APPROVED_AT) }),
      input({ expiresAtEpochMs: Date.parse(APPROVED_AT) + 86_400_001 }),
    ]);
    expect(BOUNDARY_REJECTIONS).toHaveLength(6);
    for (const candidate of BOUNDARY_REJECTIONS) {
      expectRefusal(buildPolicyWaiverGrant(candidate), "POLICY_WAIVER_RECORD_INVALID");
    }
  });

  it("refuses every named semantic noncanonical value with the literal codec provenance", () => {
    const INVALID_VALUES = Object.freeze([
      ["empty ref", input({ actionKind: "" })],
      ["non-NFC", input({ namedObligationId: "e\u0301" })],
      ["noncanonical instant", input({ approvedAt: "2026-08-30T19:51:03Z" })],
      ["empty reason", input({ decisionReason: "" })],
      ["empty scope", input({ scope: Object.freeze([]) })],
      ["duplicate scope", input({ scope: Object.freeze(["graph.read", "graph.read"]) })],
      ["unsorted scope", input({ scope: Object.freeze(["plan.preview", "graph.read"]) })],
      ["reserved command namespace", input({ commandId: "moe-internal:forged" })],
      ["NUL", input({ projectId: "project\0one" })],
    ] as const);
    expect(INVALID_VALUES).toHaveLength(9);
    expect(new Set(INVALID_VALUES.map(([name]) => name)).size).toBe(9);
    for (const [, candidate] of INVALID_VALUES) {
      expectRefusal(buildPolicyWaiverGrant(candidate), "POLICY_WAIVER_RECORD_INVALID");
    }
  });

  it("refuses every named hostile object shape without invoking getters", () => {
    let getterReads = 0;
    const getter = { ...BASE };
    Object.defineProperty(getter, "actionKind", {
      enumerable: true, get: () => { getterReads += 1; return BASE.actionKind; },
    });
    const proxy = new Proxy(BASE, {
      ownKeys: () => { throw new Error("ownKeys trap"); },
    });
    const transparentProxy = new Proxy(BASE, {});
    const revokedProxy = Proxy.revocable(BASE, {});
    revokedProxy.revoke();
    const transparentScopeProxy = { ...BASE, scope: new Proxy([...BASE.scope], {}) };
    const symbol = { ...BASE, [Symbol("extra")]: "smuggled" };
    const exotic = Object.setPrototypeOf({ ...BASE }, { authority: true });
    const cycle = { ...BASE, scope: [] as unknown[] };
    cycle.scope.push(cycle);
    const accessorScope = [...BASE.scope];
    Object.defineProperty(accessorScope, "0", { enumerable: true, get: () => "graph.read" });
    const missing = { ...BASE } as Partial<PolicyWaiverGrantInput>;
    delete missing.actionKind;
    const HOSTILE_SHAPES = Object.freeze([
      getter, proxy, transparentProxy, revokedProxy.proxy, transparentScopeProxy, symbol, exotic, cycle,
      { ...BASE, scope: accessorScope },
      missing, { ...BASE, extra: "smuggled" },
    ]);
    expect(HOSTILE_SHAPES).toHaveLength(11);
    for (const candidate of HOSTILE_SHAPES) {
      expectRefusal(buildPolicyWaiverGrant(candidate as never), "POLICY_WAIVER_RECORD_INVALID");
    }
    expect(getterReads).toBe(0);
  });

  it("fatal-decodes only canonical bytes and recomputes both stored refs", () => {
    const granted = grantOf();
    const stored = JSON.parse(new TextDecoder().decode(granted.bytes)) as Record<string, unknown>;
    const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
    const HOSTILE_BYTES = Object.freeze([
      [granted.eventType, Uint8Array.from([0xff])],
      [granted.eventType, new TextEncoder().encode("{")],
      [granted.eventType, new Uint8Array([...granted.bytes, 0x20])],
      [granted.eventType, encode({ ...stored, humanApprovalRef: "forged" })],
      [granted.eventType, encode({ ...stored, waiverRef: "forged" })],
    ] as const);
    expect(HOSTILE_BYTES).toHaveLength(5);
    for (const [eventType, bytes] of HOSTILE_BYTES) {
      expectRefusal(
        decodePolicyWaiverRecord(eventType, bytes),
        "POLICY_WAIVER_RECORD_UNREADABLE",
      );
    }
    expectRefusal(
      decodePolicyWaiverRecord("PolicyWaiverUnknown.v1" as never, granted.bytes),
      "POLICY_WAIVER_RECORD_UNREADABLE",
    );
  });

  it("keys and compares the exact obligation and canonical-scope tuple", () => {
    const granted = grantOf().record;
    expect(samePolicyWaiverTuple(granted, granted)).toBe(true);
    expect(samePolicyWaiverTuple(granted, {
      ...granted, namedObligationId: "soft.other",
    })).toBe(false);
    expect(policyWaiverTupleKeyFor(granted)).toBe(policyWaiverTupleKeyFor({ ...granted }));
    expect(policyWaiverTupleKeyFor(granted)).not.toBe(policyWaiverTupleKeyFor({
      ...granted, scope: Object.freeze(["graph.read"]),
    }));
  });
});
