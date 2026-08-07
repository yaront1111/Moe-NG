import { describe, expect, it } from "vitest";

import {
  EMPTY_NEXT_ALLOWED_COMMANDS,
  MAX_JSON_BODY_BYTES,
  MAX_JSON_DEPTH,
  MAX_JSON_STRING_UTF8_BYTES,
  RUNTIME_AGGREGATES,
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  RUNTIME_COMMAND_KINDS,
  RUNTIME_ERROR_CODES,
  RUNTIME_ERROR_REGISTRY_VERSION,
  RUNTIME_LIFECYCLES,
  RUNTIME_QUERY_ENVELOPE_VERSION,
  RUNTIME_SAFE_DETAIL_KEYS,
  createRuntimeError,
  decodeRuntimeCommandEnvelopeBytes,
  decodeRuntimeQueryEnvelopeBytes,
  lookupRuntimeError,
} from "@moe/contracts";
import type { RuntimeErrorCode } from "@moe/contracts";

const encoder = new TextEncoder();
const HASH = "a1b2c3d4".repeat(8);
const LEASE = {
  attemptBindingVersion: 2, authorityHash: HASH, epoch: 4, graphEpoch: 3, leaseToken: "lease-1",
};
const COMMAND: Record<string, unknown> = {
  commandId: "cmd-1",
  commandKind: "goal.create",
  correlationId: "corr-1",
  expectedVersion: 0,
  payload: {},
  requestDigest: HASH,
  schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
  sessionCredential: "sess-1",
  targetAggregateId: "goal-1",
};
const QUERY: Record<string, unknown> = {
  correlationId: "corr-1",
  payload: {},
  queryKind: "goal.get",
  schemaVersion: RUNTIME_QUERY_ENVELOPE_VERSION,
  sessionCredential: "sess-1",
};

const RETRYABILITIES = ["NEVER", "AFTER_REFRESH", "AFTER_FACT_CHANGE", "AFTER_RECOVERY"];
const RECOVERY_CATEGORIES = ["NONE", "CORRECT_REQUEST", "REAUTHENTICATE", "REFRESH",
  "WAIT_OR_OBSERVE", "REPLAN", "RECONCILE", "HUMAN_DECISION", "INSPECT_OR_EXPORT", "CANCEL"];

function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function withCommand(patch: Record<string, unknown>): Uint8Array {
  return bytes({ ...COMMAND, ...patch });
}

function commandCode(patch: Record<string, unknown>): RuntimeErrorCode | "OK" {
  const result = decodeRuntimeCommandEnvelopeBytes(withCommand(patch));
  return result.ok ? "OK" : result.error.code;
}

function queryCode(patch: Record<string, unknown>): RuntimeErrorCode | "OK" {
  const result = decodeRuntimeQueryEnvelopeBytes(bytes({ ...QUERY, ...patch }));
  return result.ok ? "OK" : result.error.code;
}

function paddedCommandBytes(totalBytes: number): Uint8Array {
  const keys = ["a", "b", "c", "d", "e"] as const;
  const blank = Object.fromEntries(keys.map((key) => [key, ""]));
  const fill = totalBytes - withCommand({ payload: blank }).byteLength;
  const each = Math.floor(fill / keys.length);
  const payload = Object.fromEntries(
    keys.map((key, i) => [key, "x".repeat(i === 4 ? fill - each * 4 : each)]),
  );
  return withCommand({ payload });
}

function nest(depth: number): unknown {
  return depth === 0 ? 1 : { n: nest(depth - 1) };
}

describe("command and query envelopes fail closed", () => {
  it("accepts the exact root and nested lease key sets", () => {
    const result = decodeRuntimeCommandEnvelopeBytes(withCommand({
      graphRevisionHash: HASH, leaseAuthority: { ...LEASE }, policyRevisionHash: HASH,
      payload: { nested: { deep: [1] } },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.envelope.leaseAuthority?.epoch).toBe(4);
    expect(result.envelope.commandKind).toBe("goal.create");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.envelope)).toBe(true);
    expect(Object.isFrozen(result.envelope.payload)).toBe(true);
    expect(Object.isFrozen(result.envelope.leaseAuthority)).toBe(true);
    expect(queryCode({ cursor: "c", targetAggregateId: "goal-1" })).toBe("OK");
  });

  it.each(["moe-runtime-command/0", "moe-runtime-command/2", RUNTIME_QUERY_ENVELOPE_VERSION, 1])(
    "rejects schema version %s before inspecting keys",
    (schemaVersion) => {
      expect(commandCode({ schemaVersion, unknownKey: 1 })).toBe("SCHEMA_VERSION_UNSUPPORTED");
    },
  );

  it.each([
    [{ unknownKey: 1 }], [{ commandKind: "goal.get" }], [{ commandKind: "presence.ping" }],
    [{ commandKind: 7 }], [{ commandKind: "nope" }], [{ commandId: "" }],
    [{ requestDigest: HASH.toUpperCase() }], [{ requestDigest: "abc" }], [{ expectedVersion: -1 }],
    [{ expectedVersion: 1.5 }], [{ expectedVersion: "0" }], [{ payload: [] }], [{ payload: null }],
    [{ payload: "x" }], [{ sessionCredential: 1 }], [{ correlationId: "" }],
    [{ leaseAuthority: { ...LEASE, leaseToken: 1 } }], [{ leaseAuthority: { ...LEASE, extra: 1 } }],
    [{ leaseAuthority: { ...LEASE, epoch: -1 } }], [{ leaseAuthority: {} }],
    [{ leaseAuthority: { ...LEASE, authorityHash: "zz" } }], [{ leaseAuthority: null }],
    [{ graphRevisionHash: "zz" }], [{ policyRevisionHash: 1 }], [{ targetAggregateId: "" }],
  ])("rejects malformed command field %#", (patch) => {
    expect(commandCode(patch)).toBe("INPUT_INVALID");
  });

  it.each([
    [{ queryKind: "goal.create" }], [{ queryKind: "presence.ping" }], [{ queryKind: "nope" }],
    [{ expectedVersion: 1 }], [{ leaseAuthority: { ...LEASE } }], [{ graphRevisionHash: HASH }],
    [{ commandKind: "goal.get" }], [{ commandId: "c" }], [{ requestDigest: HASH }],
    [{ policyRevisionHash: HASH }], [{ cursor: 1 }], [{ cursor: "" }], [{ correlationId: "" }],
    [{ targetAggregateId: 1 }], [{ payload: [] }],
  ])("rejects mutation-only or malformed query field %#", (patch) => {
    expect(queryCode(patch)).toBe("INPUT_INVALID");
  });

  it("preserves the bounded JSON limits at N and N+1", () => {
    const exact = paddedCommandBytes(MAX_JSON_BODY_BYTES);
    expect(exact.byteLength).toBe(MAX_JSON_BODY_BYTES);
    expect(decodeRuntimeCommandEnvelopeBytes(exact).ok).toBe(true);
    const over = paddedCommandBytes(MAX_JSON_BODY_BYTES + 1);
    expect(over.byteLength).toBe(MAX_JSON_BODY_BYTES + 1);
    const overResult = decodeRuntimeCommandEnvelopeBytes(over);
    expect(overResult.ok).toBe(false);
    if (!overResult.ok) expect(overResult.error.code).toBe("INPUT_LIMIT_EXCEEDED");
    expect(commandCode({ payload: { pad: "y".repeat(MAX_JSON_STRING_UTF8_BYTES) } })).toBe("OK");
    expect(commandCode({ payload: { pad: "y".repeat(MAX_JSON_STRING_UTF8_BYTES + 1) } }))
      .toBe("INPUT_LIMIT_EXCEEDED");
    expect(commandCode({ payload: { n: nest(MAX_JSON_DEPTH - 2) } })).toBe("OK");
    expect(commandCode({ payload: { n: nest(MAX_JSON_DEPTH - 1) } }))
      .toBe("INPUT_LIMIT_EXCEEDED");
  });

  it.each([[null], [undefined], ["{}"], [new Uint8Array(0)], [bytes([])], [bytes("x")], [bytes(1)]])(
    "rejects non-envelope input %#",
    (input) => {
      const result = decodeRuntimeCommandEnvelopeBytes(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INPUT_INVALID");
        expect(result.error.details).toEqual({});
        expect(result.error.nextAllowedCommands).toBe(EMPTY_NEXT_ALLOWED_COMMANDS);
      }
    },
  );
});

describe("the error registry is closed and cannot echo input", () => {
  it("maps every code to an exhaustive frozen descriptor", () => {
    const commands = new Set<string>(RUNTIME_COMMAND_KINDS);
    const aggregates = new Set<string>(RUNTIME_AGGREGATES);
    const safeKeys = new Set<string>(RUNTIME_SAFE_DETAIL_KEYS);
    expect(RUNTIME_ERROR_CODES).toContain("UNKNOWN_ERROR");
    expect(Object.isFrozen(RUNTIME_ERROR_CODES)).toBe(true);
    for (const code of RUNTIME_ERROR_CODES) {
      const descriptor = lookupRuntimeError(code);
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(descriptor.code).toBe(code);
      expect(RUNTIME_LIFECYCLES.TRUTH_CLASS).toContain(descriptor.truthClass);
      expect(RETRYABILITIES).toContain(descriptor.retryability);
      expect(RECOVERY_CATEGORIES).toContain(descriptor.recoveryCategory);
      expect(descriptor.transport.httpStatus).toBeGreaterThanOrEqual(400);
      expect(descriptor.transport.mcpCode).toBeLessThan(0);
      for (const command of descriptor.recoveryCommands) expect(commands.has(command)).toBe(true);
      for (const source of descriptor.validSources) expect(aggregates.has(source)).toBe(true);
      for (const key of descriptor.requiredDetailKeys) expect(safeKeys.has(key)).toBe(true);
    }
    expect(lookupRuntimeError("NOT_A_CODE").code).toBe("UNKNOWN_ERROR");
    expect(lookupRuntimeError(null).recoveryCommands).toEqual([]);
    expect(new Set<string>(RUNTIME_ERROR_CODES).size).toBe(RUNTIME_ERROR_CODES.length);
  });

  it("fails closed on revoked proxies instead of throwing", () => {
    const input = Proxy.revocable({}, {});
    const details = Proxy.revocable({}, {});
    input.revoke();
    details.revoke();
    expect(() => createRuntimeError(input.proxy)).not.toThrow();
    expect(createRuntimeError(input.proxy).code).toBe("UNKNOWN_ERROR");
    const withDetails = createRuntimeError({
      code: "STALE_LEASE",
      correlationId: "corr-1",
      details: details.proxy,
      source: { aggregate: "LEASE", state: "ACTIVE" },
    });
    expect(withDetails.code).toBe("STALE_LEASE");
    expect(withDetails.details).toEqual({});
  });

  it("copies only allowlisted safe scalars into a null-prototype record", () => {
    const error = createRuntimeError({
      code: "EXPECTED_VERSION_CONFLICT",
      correlationId: "corr-1",
      details: {
        actualVersion: 9, expectedVersion: 8, leaseToken: "lease-1", payload: { a: 1 },
        requestDigest: HASH, sessionCredential: "sess-1", sql: "SELECT 1", stack: "at x",
        sourceState: "'; DROP TABLE goals; --",
      },
      source: { aggregate: "GOAL", state: "EXECUTION_ENABLED" },
    });
    expect(error.details).toEqual({ actualVersion: 9, expectedVersion: 8 });
    expect(Object.getPrototypeOf(error.details)).toBeNull();
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(JSON.stringify(error)).not.toMatch(/lease-1|sess-1|DROP TABLE|SELECT|a1b2c3d4/);
    expect(error.registryVersion).toBe(RUNTIME_ERROR_REGISTRY_VERSION);
    expect(error.code).toBe("EXPECTED_VERSION_CONFLICT");
  });

  it("degrades unknown code or source to UNKNOWN_ERROR with no affordance", () => {
    for (const input of [
      { code: "NOT_A_CODE", correlationId: "corr-1", source: { aggregate: "GOAL", state: "DRAFT" } },
      { code: "STALE_LEASE", correlationId: "corr-1", source: { aggregate: "X", state: "Y" } },
      { code: "STALE_LEASE", correlationId: "corr-1", source: { aggregate: "GOAL", state: "DRAFT" } },
      { code: "STALE_LEASE", correlationId: " bad", source: null },
    ]) {
      const error = createRuntimeError(input);
      expect(error.code).toBe("UNKNOWN_ERROR");
      expect(error.truthClass).toBe("UNKNOWN");
      expect(error.details).toEqual({});
      expect(error.recoveryCommands).toEqual([]);
      expect(error.nextAllowedCommands).toBe(EMPTY_NEXT_ALLOWED_COMMANDS);
      expect(Object.isFrozen(error)).toBe(true);
    }
    expect(createRuntimeError({ code: "NOT_A_CODE", correlationId: "ok-1" }).correlationId)
      .toBe("ok-1");
    expect(createRuntimeError({ code: "NOT_A_CODE", correlationId: 7 }).correlationId).toBeNull();
  });

  it("never reflects attacker bytes through the decoders", () => {
    const hostile = encoder.encode('{"schemaVersion":"x","secret-password":"hunter2"');
    const result = decodeRuntimeCommandEnvelopeBytes(hostile);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/hunter2|secret-password/);
  });
});
