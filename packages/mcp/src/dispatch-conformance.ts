import { RUNTIME_ERROR_CODES, createRuntimeError, lookupRuntimeError } from "@moe/contracts";
import type { RuntimeError, RuntimeErrorCode } from "@moe/contracts";
import { describe, expect, it } from "vitest";

/**
 * Transport-agnostic dispatch conformance. Every MCP transport this repository ships
 * (stdio today, Streamable HTTP next) imports this module and registers the same suite,
 * so parity is an executable gate rather than prose.
 *
 * This module must not import the MCP SDK or anything under `stdio/`. It declares the
 * port shape structurally; each transport's own port type is checked against it by
 * assignability at the call site, which is what catches drift.
 */

export type ConformanceAuthOutcome =
  | { readonly error: RuntimeError; readonly ok: false }
  | { readonly ok: true };

export interface ConformanceDispatchPort {
  authenticate(credential: string, toolKind: string): ConformanceAuthOutcome;
  dispatchCommandBytes(bytes: Uint8Array): Uint8Array;
  dispatchQueryBytes(bytes: Uint8Array): Uint8Array;
}

export interface RecordingDispatchPort extends ConformanceDispatchPort {
  /** Ordered call log: `authenticate:<verbatim kind>`, `dispatchCommandBytes`, ... */
  readonly calls: readonly string[];
  readonly dispatched: readonly Uint8Array[];
}

export interface RecordingPortOptions {
  readonly authError?: RuntimeError;
  readonly commandResponse?: Uint8Array;
  readonly queryResponse?: Uint8Array;
}

const encoder = new TextEncoder();

/**
 * Golden daemon bytes chosen so any parse-then-re-stringify is detectable: `1.50` and
 * `1e3` renormalise, `A` collapses to `A`, and the key order is not alphabetical.
 */
export const CONFORMANCE_COMMAND_RESPONSE_TEXT =
  '{"ok":true,"commandId":"cmd-conformance-1","truthClass":"DAEMON_VERIFIED",' +
  '"settledAmount":1.50,"attemptBudget":1e3,"note":"\\u0041 verbatim",' +
  '"nextAllowedCommands":["goal.close"]}';

export const CONFORMANCE_QUERY_RESPONSE_TEXT =
  '{"ok":true,"truthClass":"OBSERVED","cursor":"eyJvZmZzZXQiOjF9",' +
  '"page":{"total":2.0,"items":[]}}';

export const CONFORMANCE_COMMAND_RESPONSE_BYTES = encoder.encode(
  CONFORMANCE_COMMAND_RESPONSE_TEXT,
);
export const CONFORMANCE_QUERY_RESPONSE_BYTES = encoder.encode(CONFORMANCE_QUERY_RESPONSE_TEXT);

export const CONFORMANCE_COMMAND_LABEL = "goal_create";
export const CONFORMANCE_COMMAND_KIND = "goal.create";
export const CONFORMANCE_QUERY_LABEL = "goal_list";
export const CONFORMANCE_QUERY_KIND = "goal.list";

export const CONFORMANCE_COMMAND_ARGS: Readonly<Record<string, unknown>> = Object.freeze({
  commandId: "cmd-conformance-1",
  correlationId: "corr-conformance-1",
  expectedVersion: 0,
  payload: Object.freeze({ title: "conformance" }),
  targetAggregateId: "goal-conformance-1",
});

export const CONFORMANCE_QUERY_ARGS: Readonly<Record<string, unknown>> = Object.freeze({
  correlationId: "corr-conformance-2",
  payload: Object.freeze({}),
});

export function createRecordingPort(
  options: RecordingPortOptions = {},
): RecordingDispatchPort {
  const calls: string[] = [];
  const dispatched: Uint8Array[] = [];
  const authError = options.authError;
  return {
    authenticate(_credential: string, toolKind: string): ConformanceAuthOutcome {
      calls.push(`authenticate:${toolKind}`);
      return authError === undefined ? { ok: true } : { error: authError, ok: false };
    },
    calls,
    dispatchCommandBytes(bytes: Uint8Array): Uint8Array {
      calls.push("dispatchCommandBytes");
      dispatched.push(bytes);
      return options.commandResponse ?? CONFORMANCE_COMMAND_RESPONSE_BYTES;
    },
    dispatchQueryBytes(bytes: Uint8Array): Uint8Array {
      calls.push("dispatchQueryBytes");
      dispatched.push(bytes);
      return options.queryResponse ?? CONFORMANCE_QUERY_RESPONSE_BYTES;
    },
    dispatched,
  };
}

export type ConformanceOutcome =
  | { readonly data: unknown; readonly kind: "error"; readonly mcpCode: number }
  | { readonly kind: "ok"; readonly text: string };

export interface ConformanceSubject {
  /** Builds a transport bound to `port`, invokes one tool, and tears the transport down. */
  invoke(
    port: ConformanceDispatchPort,
    toolLabel: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<ConformanceOutcome>;
  readonly transportName: string;
}

/** Registry-fixed JSON-RPC codes. Duplicated here so a registry edit must be deliberate. */
export const EXPECTED_MCP_CODE_BY_ERROR_CODE: Readonly<Record<RuntimeErrorCode, number>> =
  Object.freeze({
    AUTHENTICATION_FAILED: -32001,
    CAPABILITY_DENIED: -32002,
    CONTEXT_TOO_LARGE: -32005,
    CUTOVER_STATE_INVALID: -32007,
    DEPENDENCY_REDUNDANT: -32007,
    DISTRIBUTION_MISMATCH: -32007,
    EXPECTED_VERSION_CONFLICT: -32003,
    FANOUT_BUDGET_REFUSED: -32007,
    FANOUT_FLOW_REFUSED: -32007,
    FANOUT_ORACLE_REFUSED: -32007,
    FANOUT_SCOPE_REFUSED: -32007,
    FRONTIER_STALLED: -32007,
    HARD_DEPENDENCY_UNPROVEN: -32007,
    IDEMPOTENCY_CONFLICT: -32003,
    ILLEGAL_TRANSITION: -32007,
    INPUT_INVALID: -32602,
    INPUT_LIMIT_EXCEEDED: -32005,
    INPUT_PROVENANCE_INVALID: -32007,
    INTEGRATION_PROVENANCE_INVALID: -32007,
    JOURNAL_LIMIT_REACHED: -32005,
    METERING_UNAVAILABLE: -32006,
    NEEDS_RECONCILIATION: -32007,
    OUT_OF_SCOPE_HOST_EFFECT_UNKNOWN: -32603,
    PLANNING_DISPOSITION_UNKNOWN: -32007,
    PLANNING_SUBMISSION_FINALIZING: -32003,
    PROVIDER_CAPABILITY_CHANGED: -32007,
    RESTORE_REQUIRED: -32006,
    REVISION_REBOUND: -32003,
    SCHEMA_VERSION_UNSUPPORTED: -32600,
    SESSION_EXPIRED: -32001,
    SESSION_REPLAYED: -32001,
    STALE_EPOCH: -32004,
    STALE_LEASE: -32004,
    STORAGE_DEGRADED: -32006,
    SUPERSEDED_AUTHORITY: -32004,
    SUPERSESSION_CONSEQUENCE_CHANGED: -32003,
    SUPERSESSION_PREPARED: -32003,
    UNKNOWN_ERROR: -32603,
  });

function registerErrorMappingTable(): void {
  it("maps every runtime error code to exactly the registry-bound JSON-RPC code", () => {
    const mismatches: string[] = [];
    for (const code of RUNTIME_ERROR_CODES) {
      const actual = lookupRuntimeError(code).transport.mcpCode;
      const expected = EXPECTED_MCP_CODE_BY_ERROR_CODE[code];
      if (actual !== expected) mismatches.push(`${code}: ${String(actual)} != ${String(expected)}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("keeps the expected mapping table exactly aligned with the error vocabulary", () => {
    expect(Object.keys(EXPECTED_MCP_CODE_BY_ERROR_CODE).slice().sort()).toEqual(
      RUNTIME_ERROR_CODES.slice().sort(),
    );
  });
}

function registerSequenceObligation(subject: ConformanceSubject): void {
  it("authenticates with the verbatim kind before dispatching a command exactly once", async () => {
    const port = createRecordingPort();
    const outcome = await subject.invoke(
      port,
      CONFORMANCE_COMMAND_LABEL,
      CONFORMANCE_COMMAND_ARGS,
    );
    expect(port.calls).toEqual([
      `authenticate:${CONFORMANCE_COMMAND_KIND}`,
      "dispatchCommandBytes",
    ]);
    expect(outcome.kind).toBe("ok");
  });

  it("routes a query to the query dispatch path and never to the command path", async () => {
    const port = createRecordingPort();
    await subject.invoke(port, CONFORMANCE_QUERY_LABEL, CONFORMANCE_QUERY_ARGS);
    expect(port.calls).toEqual([`authenticate:${CONFORMANCE_QUERY_KIND}`, "dispatchQueryBytes"]);
  });

  it("short-circuits an authentication refusal with zero dispatch calls", async () => {
    const port = createRecordingPort({
      authError: createRuntimeError({ code: "AUTHENTICATION_FAILED" }),
    });
    const outcome = await subject.invoke(
      port,
      CONFORMANCE_COMMAND_LABEL,
      CONFORMANCE_COMMAND_ARGS,
    );
    expect(port.calls).toEqual([`authenticate:${CONFORMANCE_COMMAND_KIND}`]);
    expect(port.dispatched).toEqual([]);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.mcpCode).toBe(EXPECTED_MCP_CODE_BY_ERROR_CODE.AUTHENTICATION_FAILED);
    }
  });

  it("contains a throwing authenticate as UNKNOWN_ERROR with zero dispatch calls", async () => {
    // A credential store that throws (busy, closed) has rendered no verdict. The containment
    // proof is the registry error in `data`: an uncontained throw reaches the client as the
    // SDK's own internal error, which carries the throw's message and NO data at all.
    const secret = "STORE_BUSY: credential store at /var/lib/moe/sessions.db is locked";
    const dispatched: string[] = [];
    const port: ConformanceDispatchPort = {
      authenticate(): never {
        throw new Error(secret);
      },
      dispatchCommandBytes(): Uint8Array {
        dispatched.push("dispatchCommandBytes");
        return CONFORMANCE_COMMAND_RESPONSE_BYTES;
      },
      dispatchQueryBytes(): Uint8Array {
        dispatched.push("dispatchQueryBytes");
        return CONFORMANCE_QUERY_RESPONSE_BYTES;
      },
    };
    const outcome = await subject.invoke(port, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS);
    expect(dispatched).toEqual([]);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.mcpCode).toBe(EXPECTED_MCP_CODE_BY_ERROR_CODE.UNKNOWN_ERROR);
      expect(outcome.data).toMatchObject({ code: "UNKNOWN_ERROR" });
      expect(JSON.stringify(outcome.data)).not.toContain(secret);
    }
  });
}

function registerByteFidelity(subject: ConformanceSubject): void {
  it("keeps the golden fixtures capable of detecting a re-serialisation", () => {
    for (const text of [CONFORMANCE_COMMAND_RESPONSE_TEXT, CONFORMANCE_QUERY_RESPONSE_TEXT]) {
      expect(JSON.stringify(JSON.parse(text))).not.toBe(text);
    }
  });

  it("returns golden daemon command bytes verbatim", async () => {
    const outcome = await subject.invoke(
      createRecordingPort(),
      CONFORMANCE_COMMAND_LABEL,
      CONFORMANCE_COMMAND_ARGS,
    );
    expect(outcome.kind === "ok" ? outcome.text : "").toBe(CONFORMANCE_COMMAND_RESPONSE_TEXT);
  });

  it("returns golden daemon query bytes verbatim, cursor unparsed", async () => {
    const outcome = await subject.invoke(
      createRecordingPort(),
      CONFORMANCE_QUERY_LABEL,
      CONFORMANCE_QUERY_ARGS,
    );
    expect(outcome.kind === "ok" ? outcome.text : "").toBe(CONFORMANCE_QUERY_RESPONSE_TEXT);
  });

  it("refuses an unmapped tool label without touching the port", async () => {
    const port = createRecordingPort();
    const outcome = await subject.invoke(port, "goal_create_not_a_tool", CONFORMANCE_COMMAND_ARGS);
    expect(port.calls).toEqual([]);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.mcpCode).toBe(EXPECTED_MCP_CODE_BY_ERROR_CODE.INPUT_INVALID);
    }
  });

  it("refuses oversized arguments at the decoder with the bounded limit error", async () => {
    const port = createRecordingPort();
    const outcome = await subject.invoke(port, CONFORMANCE_COMMAND_LABEL, {
      ...CONFORMANCE_COMMAND_ARGS,
      payload: { title: "x".repeat(300_000) },
    });
    expect(port.calls).toEqual([]);
    expect(port.dispatched).toEqual([]);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.mcpCode).toBe(EXPECTED_MCP_CODE_BY_ERROR_CODE.INPUT_LIMIT_EXCEEDED);
    }
  });
}

/** Registers the shared parity suite for one transport. */
export function registerDispatchConformanceSuite(subject: ConformanceSubject): void {
  describe(`dispatch conformance (${subject.transportName})`, () => {
    registerErrorMappingTable();
    registerSequenceObligation(subject);
    registerByteFidelity(subject);
  });
}
