import { RECOVERY_BINDING_CODEC_VERSION, SqliteEventStore } from "@moe/store";
import type { HttpSessionPort } from "@moe/mcp";
import { afterEach, describe, expect, it } from "vitest";

import { createSessionAuthenticator } from "../identity/session-authenticator.js";
import {
  CAPABILITIES,
  CREDENTIAL,
  EXPIRES_AT_MS,
  PROJECT_ID,
  SESSION_ID,
  closeStores,
  envelope,
  openDefaultSession,
  openPayload,
  openStore,
  openUnboundStore,
  send,
} from "../identity/session-test-fixtures.js";
import { createMcpHttpSessionPort } from "./mcp-http-session-port.js";

/**
 * The daemon's `AuthenticationResult` has three arms; `@moe/mcp`'s `HttpAuthVerdict` has two.
 * That collapse is the only new authority decision in this task, so every arm is pinned here
 * against the REAL `createSessionAuthenticator` over a real store — never a fake authenticator,
 * which would only prove the shape of a mapping this file itself wrote.
 */

const OPERATOR_CREDENTIAL = "operator-bootstrap-credential";
const OPERATOR_PRINCIPAL = "principal-operator-1";
const encoder = new TextEncoder();

afterEach(closeStores);

/**
 * The four codes a session port may select, HAND-WRITTEN rather than imported.
 *
 * `HTTP_AUTH_REFUSAL_CODES` is a runtime value inside `@moe/mcp`'s http-session module and is
 * NOT published from the package root, so importing it would be the deep import task rail 1
 * forbids. Writing the set by hand is also the stronger test: a list derived from the producer
 * cannot notice the producer changing. `RefusalCodeSetIsExact` below makes TypeScript prove this
 * hand-written set is neither missing a member nor inventing one.
 */
const EXPECTED_REFUSAL_CODES = [
  "AUTHENTICATION_FAILED",
  "CAPABILITY_DENIED",
  "SESSION_EXPIRED",
  "SESSION_REPLAYED",
] as const;

type Verdict = Awaited<ReturnType<HttpSessionPort["validateBearer"]>>;
type PublishedRefusalCode = Extract<Verdict, { readonly ok: false }>["code"];
type HandWrittenRefusalCode = (typeof EXPECTED_REFUSAL_CODES)[number];

/**
 * Mutual assignability, so the check fails in BOTH directions: a code added to `@moe/mcp` that
 * this file does not list, and a code listed here that `@moe/mcp` does not define.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const RefusalCodeSetIsExact: Exact<PublishedRefusalCode, HandWrittenRefusalCode> = true;

/**
 * Committed decisions, counted through the store's real cursor page. There is no
 * `readDecisionCount()` on `SqliteEventStore`; `readCommandDecisionsAfter(0n)` is the idiom the
 * existing daemon suites use, and the page is drained so a count cannot silently cap at the
 * default page size.
 */
function decisionCount(store: SqliteEventStore): number {
  let cursor = 0n;
  let total = 0;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, 100);
    total += page.items.length;
    if (page.nextCursor === null || page.items.length === 0) return total;
    cursor = page.nextCursor;
  }
}

function authenticatorOver(store: SqliteEventStore, nowMs: number) {
  return createSessionAuthenticator(store, {
    clock: () => nowMs,
    operatorCapabilities: ["goal.write"],
    operatorCredential: OPERATOR_CREDENTIAL,
    operatorPrincipalId: OPERATOR_PRINCIPAL,
    projectId: PROJECT_ID,
  });
}

/** A store whose recovery binding names a DIFFERENT incarnation than the session was opened under. */
function installBinding(store: SqliteEventStore, incarnation: string, keyEpoch: string): void {
  const result = store.installRecoveryBinding({
    bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
    incarnationRef: incarnation,
    installedAt: "2026-08-12T00:00:00.000Z",
    keyEpochRef: keyEpoch,
    payload: encoder.encode("mcp-http-session-port-binding"),
    slot: "ACTIVE",
  });
  if (!result.ok) throw new Error(`binding install failed: ${result.code}`);
}

describe("mcp-http session port — daemon verdicts mapped onto the MCP two-arm vocabulary", () => {
  it("pins the published refusal vocabulary as exactly four codes", () => {
    expect(RefusalCodeSetIsExact).toBe(true);
    expect([...EXPECTED_REFUSAL_CODES]).toHaveLength(4);
  });

  it("accepts the operator credential and copies principalId verbatim into BOTH refs", () => {
    const store = openStore();
    try {
      const port = createMcpHttpSessionPort(authenticatorOver(store, EXPIRES_AT_MS - 1_000));
      const verdict = port.validateBearer(OPERATOR_CREDENTIAL);
      expect(verdict).toEqual({
        ok: true,
        principalRef: OPERATOR_PRINCIPAL,
        sessionRef: OPERATOR_PRINCIPAL,
      });
    } finally {
      store.close();
    }
  });

  it("accepts a SESSION credential whose principalRef is the SESSION id, not the opener", () => {
    const store = openStore();
    try {
      openDefaultSession(store);
      const port = createMcpHttpSessionPort(authenticatorOver(store, EXPIRES_AT_MS - 1_000));
      const verdict = port.validateBearer(CREDENTIAL);
      // session-authenticator.ts:139 returns `match.sessionId` as the working principal on
      // purpose: two agents sharing an opener must stay distinct identities.
      expect(verdict).toEqual({ ok: true, principalRef: SESSION_ID, sessionRef: SESSION_ID });
      expect(verdict).not.toMatchObject({ principalRef: "principal-opener-1" });
    } finally {
      store.close();
    }
  });

  it("refuses an unknown credential with AUTHENTICATION_FAILED", () => {
    const store = openStore();
    try {
      const port = createMcpHttpSessionPort(authenticatorOver(store, EXPIRES_AT_MS - 1_000));
      expect(port.validateBearer("no-such-credential")).toEqual({
        code: "AUTHENTICATION_FAILED",
        ok: false,
      });
    } finally {
      store.close();
    }
  });

  it("refuses an empty credential with AUTHENTICATION_FAILED", () => {
    const store = openStore();
    try {
      const port = createMcpHttpSessionPort(authenticatorOver(store, EXPIRES_AT_MS - 1_000));
      expect(port.validateBearer("")).toEqual({ code: "AUTHENTICATION_FAILED", ok: false });
    } finally {
      store.close();
    }
  });

  it("forwards SESSION_REPLAYED VERBATIM for a prior recovery incarnation", () => {
    const store = openUnboundStore();
    try {
      installBinding(store, "41".repeat(32), "51".repeat(32));
      openDefaultSession(store);
      // Rebind to a LATER incarnation: the open session now belongs to a prior one.
      installBinding(store, "42".repeat(32), "52".repeat(32));
      const port = createMcpHttpSessionPort(authenticatorOver(store, EXPIRES_AT_MS - 1_000));
      expect(port.validateBearer(CREDENTIAL)).toEqual({ code: "SESSION_REPLAYED", ok: false });
    } finally {
      store.close();
    }
  });

  it("maps an EXPIRED session to AUTHENTICATION_FAILED and explicitly NOT SESSION_EXPIRED", () => {
    const store = openStore();
    try {
      openDefaultSession(store);
      // Exclusive expiry: unusable at exactly expiresAt (session-authenticator.ts:134).
      const port = createMcpHttpSessionPort(authenticatorOver(store, EXPIRES_AT_MS));
      const verdict = port.validateBearer(CREDENTIAL);
      // BOTH halves asserted. SESSION_EXPIRED is a legal member of the MCP vocabulary, so
      // selecting it would compile and read naturally — and would hand a caller an oracle
      // distinguishing "expired" from "unknown" that the daemon authenticator deliberately
      // refuses to give by answering UNAUTHENTICATED for both.
      expect(verdict).toEqual({ code: "AUTHENTICATION_FAILED", ok: false });
      expect(verdict).not.toMatchObject({ code: "SESSION_EXPIRED" });
    } finally {
      store.close();
    }
  });

  it("fails CLOSED to AUTHENTICATION_FAILED on a REFUSED code outside the MCP vocabulary", () => {
    // The daemon's only REFUSED constant today carries SESSION_REPLAYED, so an out-of-vocabulary
    // code cannot be produced through the real authenticator. This is the one case that must use
    // a stand-in Authenticator — and it stands in only to emit a code the real one cannot yet
    // emit, which is precisely the future drift the fail-closed branch exists to survive.
    const port = createMcpHttpSessionPort({
      authenticate: () => ({
        refusal: {
          code: "PROJECT_QUARANTINED",
          detail: "a future daemon refusal the MCP vocabulary does not contain",
          httpStatus: 403,
          layer: "IDENTITY",
        },
        verdict: "REFUSED" as const,
      }),
    });
    const verdict = port.validateBearer("any-credential");
    expect(verdict).toEqual({ code: "AUTHENTICATION_FAILED", ok: false });
    expect(verdict).not.toMatchObject({ code: "PROJECT_QUARANTINED" });
  });

  it("re-validates on EVERY call so a closed session dies on the next request", () => {
    const store = openStore();
    try {
      openDefaultSession(store);
      const port = createMcpHttpSessionPort(authenticatorOver(store, EXPIRES_AT_MS - 1_000));
      expect(port.validateBearer(CREDENTIAL)).toMatchObject({ ok: true });

      const closed = send(store, envelope("session.close", 1, { sessionId: SESSION_ID }, "cmd-close-1"));
      expect(closed.ok).toBe(true);

      // No memoisation: the SAME port instance must now refuse the SAME credential.
      expect(port.validateBearer(CREDENTIAL)).toEqual({
        code: "AUTHENTICATION_FAILED",
        ok: false,
      });
    } finally {
      store.close();
    }
  });

  it("refuses an AMBIGUOUS credential bound to two sessions with AUTHENTICATION_FAILED", () => {
    const store = openStore();
    try {
      openDefaultSession(store);
      const second = send(store, envelope(
        "session.open",
        0,
        openPayload({ capabilities: [...CAPABILITIES], sessionId: "session-beta" }),
        "cmd-open-beta",
      ));
      expect(second.ok).toBe(true);
      const port = createMcpHttpSessionPort(authenticatorOver(store, EXPIRES_AT_MS - 1_000));
      // Two records share one credential hash: identity is ambiguous and fails closed.
      expect(port.validateBearer(CREDENTIAL)).toEqual({
        code: "AUTHENTICATION_FAILED",
        ok: false,
      });
    } finally {
      store.close();
    }
  });

  it("every refusal this port can produce is inside the four-code vocabulary", () => {
    const store = openStore();
    try {
      openDefaultSession(store);
      const port = createMcpHttpSessionPort(authenticatorOver(store, EXPIRES_AT_MS));
      const observed = ["", "no-such-credential", CREDENTIAL]
        .map((credential) => port.validateBearer(credential))
        .filter((verdict): verdict is Extract<Verdict, { readonly ok: false }> => !verdict.ok)
        .map((verdict) => verdict.code);
      // Assert the sweep actually produced cases: an empty sweep passes a subset check silently.
      expect(observed).toHaveLength(3);
      for (const code of observed) expect(EXPECTED_REFUSAL_CODES).toContain(code);
    } finally {
      store.close();
    }
  });

  it("binds and closes transport sessions idempotently without touching the store", () => {
    const store = openStore();
    try {
      openDefaultSession(store);
      const before = decisionCount(store);
      const port = createMcpHttpSessionPort(authenticatorOver(store, EXPIRES_AT_MS - 1_000));
      const verdict = port.validateBearer(CREDENTIAL);
      if (!verdict.ok) throw new Error("setup: credential should authenticate");

      port.bindSession("mcp-transport-1", verdict);
      port.bindSession("mcp-transport-1", verdict);
      expect(port.boundSessionIds()).toEqual(["mcp-transport-1"]);

      port.closeSession("mcp-transport-1");
      port.closeSession("mcp-transport-1");
      expect(port.boundSessionIds()).toEqual([]);

      // Binding a transport session must never mint a durable session: that is session.open's job.
      expect(decisionCount(store)).toBe(before);
    } finally {
      store.close();
    }
  });
});
