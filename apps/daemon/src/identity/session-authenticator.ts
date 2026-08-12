import { createHash, timingSafeEqual } from "node:crypto";

import type { SqliteEventStore } from "@moe/store";

import type {
  AuthenticatedPrincipal,
  AuthenticationResult,
  Authenticator,
} from "../http/http-contract.js";
import { readCurrentRecoveryAuthenticationBinding } from "./recovery-authentication-binding.js";
import { readSessionLedger } from "./session-read-model.js";
import type { SessionRecord } from "./session-read-model.js";

/**
 * The credential authenticator for the HTTP seam: `http-contract.ts`'s `Authenticator`,
 * synchronous, judging only the transport-carried credential string.
 *
 * Two identities can authenticate. The OPERATOR presents the configured bootstrap credential and
 * receives the configured principal — this is what opens the first session when the ledger is
 * empty. Everyone else presents a session credential whose sha256 was durably bound by a
 * committed `session.open`; the plaintext is hashed here, compared against the ledger, and
 * discarded. No credential material is ever stored — the fold holds hashes only.
 *
 * FOLD COST — decided and documented: the durable decision log is re-folded on EVERY
 * `authenticate()` call, with no cache. Chosen over a `decisionCount`-keyed cache because the
 * seam is synchronous, the session log is small at this stage, and an invalidation bug here is
 * an authentication bug; when the log grows, the one function to wrap is `readSessionLedger`.
 */

export interface SessionAuthenticatorConfig {
  /**
   * Epoch MILLISECONDS (e.g. `Date.now`). Chosen over an ISO-string clock because expiry is
   * compared numerically against `Date.parse(expiresAt)` and a string clock would force a parse
   * of the clock on every call just to throw the string away.
   */
  readonly clock: () => number;
  readonly operatorCapabilities: readonly string[];
  readonly operatorCredential: string;
  readonly operatorPrincipalId: string;
  readonly projectId: string;
}

const UNAUTHENTICATED: AuthenticationResult = Object.freeze({
  verdict: "UNAUTHENTICATED" as const,
});

const RECOVERY_REPLAYED: AuthenticationResult = Object.freeze({
  refusal: Object.freeze({
    code: "SESSION_REPLAYED",
    detail: "The session belongs to a prior recovery incarnation or key epoch.",
    httpStatus: 401,
    layer: "IDENTITY",
  }),
  verdict: "REFUSED" as const,
});

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Lowercase 64-hex sha256 — the exact form `session.open` binds into the ledger. */
export function credentialSha256Of(credential: string): string {
  return sha256(credential).toString("hex");
}

/**
 * Constant-time equality via digest-then-compare: `timingSafeEqual` demands equal-length inputs,
 * and an early length check would leak the operator credential's length through timing. Both
 * sha256 digests are always 32 bytes, so the precondition holds with no length-dependent branch.
 */
function constantTimeEquals(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function authenticated(
  capabilities: readonly string[],
  principalId: string,
  projectId: string,
): AuthenticationResult {
  const principal: AuthenticatedPrincipal = Object.freeze({
    capabilities: Object.freeze([...capabilities]),
    principalId,
    projectId,
  });
  return Object.freeze({ principal, verdict: "AUTHENTICATED" as const });
}

/**
 * Builds the seam's `Authenticator` over the durable session ledger.
 *
 * Unknown, malformed, closed, expired, and unreadable credentials stay silent. Only a
 * structurally valid credential bound to an earlier recovery identity receives the fixed typed
 * replay refusal, allowing ingress to preserve that identity-layer fact without exposing input.
 */
export function createSessionAuthenticator(
  store: SqliteEventStore,
  config: SessionAuthenticatorConfig,
): Authenticator {
  const authenticate = (credential: string | null): AuthenticationResult => {
    if (credential === null || credential.length === 0) return UNAUTHENTICATED;
    if (constantTimeEquals(credential, config.operatorCredential)) {
      if (readCurrentRecoveryAuthenticationBinding(store) === null) return UNAUTHENTICATED;
      return authenticated(
        config.operatorCapabilities,
        config.operatorPrincipalId,
        config.projectId,
      );
    }
    const ledger = readSessionLedger(store, config.projectId);
    // Fail CLOSED on unreadable stored bytes: treating a corrupt open-record as "no session"
    // is safe for refusal but the same flag also means a close may not have folded, so no
    // session credential can be trusted until the ledger is repaired.
    if (ledger.unreadable) return UNAUTHENTICATED;
    const hash = credentialSha256Of(credential);
    let match: SessionRecord | null = null;
    for (const session of ledger.sessions.values()) {
      if (session.credentialSha256 !== hash) continue;
      // One credential, one session: two records sharing a hash make the identity ambiguous,
      // and an ambiguous identity fails closed rather than picking a winner.
      if (match !== null) return UNAUTHENTICATED;
      match = session;
    }
    if (match === null || match.status !== "OPEN") return UNAUTHENTICATED;
    const current = readCurrentRecoveryAuthenticationBinding(store);
    if (current === null) return UNAUTHENTICATED;
    if (
      match.recoveryIncarnationRef !== current.recoveryIncarnationRef
      || match.keyEpochRef !== current.keyEpochRef
    ) {
      return RECOVERY_REPLAYED;
    }
    const expiresAtMs = Date.parse(match.expiresAt);
    // Exclusive expiry, matching @moe/core's `isSessionUsableAt`: unusable at exactly expiresAt.
    if (!Number.isFinite(expiresAtMs) || config.clock() >= expiresAtMs) return UNAUTHENTICATED;
    // The WORKING principal is the session itself, not the principal that opened it: two
    // agents whose sessions share an opener must remain distinct identities, or per-agent
    // fences (work claims, decision keys) collapse into one. The opener stays durably
    // recorded on the session record for audit.
    return authenticated(match.capabilities, match.sessionId, config.projectId);
  };
  return Object.freeze({ authenticate });
}
