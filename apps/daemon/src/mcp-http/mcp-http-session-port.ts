import type { HttpSessionPort } from "@moe/mcp";

import type { Authenticator } from "../http/http-contract.js";

/**
 * Adapts the daemon's `Authenticator` to `@moe/mcp`'s `HttpSessionPort`.
 *
 * THE ONE DECISION THIS MODULE OWNS is a collapse: the daemon answers with three arms
 * (AUTHENTICATED / REFUSED / UNAUTHENTICATED) and the MCP session port accepts two
 * (accepted / refused-with-code). Everything else here is copying.
 *
 * It is NOT a second authentication policy. No credential is hashed, compared, minted or
 * stored in this file; the single call to `authenticator.authenticate` is the whole decision,
 * and proof-of-possession stays daemon-side behind the dispatch port where BOTH transports
 * funnel into the same check. This module also never writes a durable session record —
 * minting sessions belongs to the `session.open` command, and doing it at the transport
 * would be exactly the duplicate authority the task rails forbid.
 *
 * TYPES ARE DERIVED, NOT DEEP-IMPORTED. `@moe/mcp` publishes `HttpSessionPort` from its root
 * but not `HttpAuthAccepted`, `HttpAuthVerdict` or the `HTTP_AUTH_REFUSAL_CODES` array, which
 * live in its http-session module. Reaching for those directly would be a deep import across a
 * package boundary, so the shapes below are recovered structurally from the published interface.
 * A change to the published contract therefore fails this file's typecheck rather than drifting.
 */

type Verdict = Awaited<ReturnType<HttpSessionPort["validateBearer"]>>;
type Accepted = Parameters<HttpSessionPort["bindSession"]>[1];
type RefusalCode = Extract<Verdict, { readonly ok: false }>["code"];

/**
 * The two codes this daemon deliberately NEVER selects, recorded so their absence reads as a
 * decision rather than an oversight:
 *
 * - SESSION_EXPIRED. The authenticator answers UNAUTHENTICATED for expired, unknown, closed,
 *   malformed, ambiguous and unreadable credentials alike. Selecting SESSION_EXPIRED here would
 *   compile and would read naturally, but it would hand a caller an oracle separating "your
 *   session expired" from "no such session" — precisely the distinction the daemon refuses to
 *   give. Expiry maps to AUTHENTICATION_FAILED with the rest.
 * - CAPABILITY_DENIED. Capability checks are authorization, not authentication, and they happen
 *   behind the dispatch port against the command being run. This port screens a credential and
 *   knows nothing about the request, so it is never in a position to select it.
 */
const AUTHENTICATION_FAILED = Object.freeze({
  code: "AUTHENTICATION_FAILED" as const,
  ok: false as const,
});

/** Codes the daemon may forward verbatim, as a runtime set, so an unknown code fails closed. */
const FORWARDABLE_CODES: ReadonlySet<string> = new Set<RefusalCode>([
  "AUTHENTICATION_FAILED",
  "CAPABILITY_DENIED",
  "SESSION_EXPIRED",
  "SESSION_REPLAYED",
]);

function isForwardable(code: string): code is RefusalCode {
  return FORWARDABLE_CODES.has(code);
}

export interface McpHttpSessionPort extends HttpSessionPort {
  /**
   * Transport session ids currently bound, in bind order. Real production surface: the host
   * closes outstanding sessions on shutdown and cannot do that without asking.
   */
  boundSessionIds(): readonly string[];
  validateBearer(credential: string): Verdict;
}

export function createMcpHttpSessionPort(authenticator: Authenticator): McpHttpSessionPort {
  // Transport-level ids only. This map is in-process routing state, never durable identity.
  const bound = new Map<string, Accepted>();

  const validateBearer = (credential: string): Verdict => {
    // Re-run on EVERY call. No memoisation, by contract: revalidating each time is what makes a
    // rotated, closed or revoked credential die on the very next request rather than at some
    // cache boundary. The authenticator re-folds the durable log itself.
    const result = authenticator.authenticate(credential);

    if (result.verdict === "AUTHENTICATED") {
      // COPIED from the principal, never minted and never derived from request bytes. For a
      // session credential the daemon reports the session id as the working principal, so both
      // refs coincide; that is the daemon's decision, faithfully carried, not a shortcut here.
      const principalRef = result.principal.principalId;
      return Object.freeze({ ok: true as const, principalRef, sessionRef: principalRef });
    }

    if (result.verdict === "REFUSED") {
      // The seam holds no translation table: a port's own stable code travels verbatim when the
      // MCP vocabulary can express it, and fails closed when it cannot. A daemon code added
      // later that MCP does not define must never reach a client as an invented member.
      const code = result.refusal.code;
      return isForwardable(code) ? Object.freeze({ code, ok: false as const }) : AUTHENTICATION_FAILED;
    }

    // UNAUTHENTICATED: silent by design, and that silence is preserved here.
    return AUTHENTICATION_FAILED;
  };

  return Object.freeze({
    bindSession(mcpSessionId: string, verdict: Accepted): void {
      // Idempotent: re-binding the same transport id replaces one map entry, never appends.
      bound.set(mcpSessionId, verdict);
    },
    boundSessionIds(): readonly string[] {
      return Object.freeze([...bound.keys()]);
    },
    closeSession(mcpSessionId: string): void {
      // Exactly-once by construction: Map.delete on an absent key is a no-op, so a second close
      // is harmless and no counter can drift.
      bound.delete(mcpSessionId);
    },
    validateBearer,
  });
}
