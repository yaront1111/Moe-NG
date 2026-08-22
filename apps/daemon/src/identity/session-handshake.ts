import { randomBytes, randomUUID } from "node:crypto";

import type { SqliteEventStore } from "@moe/store";

import { credentialSha256Of } from "./session-authenticator.js";
import { SESSION_SCHEMA_VERSION } from "./session-contracts.js";
import { runSessionCommand } from "./session-services.js";

/**
 * The operator credential MINT behind `POST /session/pair`.
 *
 * The handshake exists so no secret is ever baked into the hosted page: the page
 * fetches `/bootstrap` for the CSRF token, presents the one-time pairing token,
 * and receives a session credential minted HERE. This port does not invent a
 * second credential store; it opens a real session through the same
 * `session.open` machinery every other session travels, so the credential it
 * returns is authenticated by the ordinary `createSessionAuthenticator` fold and
 * carries the capability set and expiry that session was bound with.
 *
 * The plaintext credential is generated, its sha256 is what the ledger binds, and
 * only the plaintext is returned to the caller once - the durable log holds the
 * hash alone, exactly as `session.open` requires. A refused open surfaces the
 * session layer's own code so the listener can fail closed rather than pretend a
 * credential exists.
 */

/** Twelve hours: long enough for one operator sitting, short enough to expire a stale tab. */
export const OPERATOR_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface SessionHandshakeMinted {
  readonly capabilities: readonly string[];
  /** The plaintext bearer credential - returned ONCE, never stored here or logged. */
  readonly credential: string;
  readonly expiresAt: string;
  readonly ok: true;
}

export interface SessionHandshakeRefused {
  /** The session layer's own refusal code, carried verbatim so no oracle is minted here. */
  readonly code: string;
  readonly ok: false;
}

export type SessionHandshakeResult = SessionHandshakeMinted | SessionHandshakeRefused;

/**
 * The mint the listener consumes. `boundProjectId` is the server fact `/bootstrap`
 * answers with; it is a bound rather than a hint because it is read from the
 * daemon's own configuration, never from a request.
 */
export interface SessionHandshakePort {
  readonly boundProjectId: string;
  mint(): SessionHandshakeResult;
}

export interface OperatorSessionHandshakeConfig {
  readonly capabilities: readonly string[];
  /** Epoch MILLISECONDS (e.g. `Date.now`), so the ISO expiry is derived numerically. */
  readonly clock: () => number;
  /** INJECTED for tests only; production draws credential bytes from the CSPRNG. */
  readonly mintCredential?: () => string;
  /** INJECTED for tests only; production mints a random session id. */
  readonly mintSessionId?: () => string;
  readonly operatorPrincipalId: string;
  readonly projectId: string;
  /** Principal-id namespaces a minted session id may NOT collide with. */
  readonly reservedPrincipalIds?: readonly string[];
  readonly sessionTtlMs: number;
  readonly store: SqliteEventStore;
}

const encoder = new TextEncoder();

/** A 256-bit bearer credential as lowercase hex: the plaintext the caller keeps. */
function defaultCredential(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Builds the operator handshake mint over one open store. Every mint opens a
 * fresh single-use session for the operator principal: a random credential whose
 * hash is bound, a random session id that cannot collide with a reserved
 * principal, the configured capabilities, and an expiry `sessionTtlMs` ahead of
 * the injected clock.
 */
export function createOperatorSessionHandshakePort(
  config: OperatorSessionHandshakeConfig,
): SessionHandshakePort {
  const mintCredential = config.mintCredential ?? defaultCredential;
  const mintSessionId = config.mintSessionId ?? randomUUID;
  const mint = (): SessionHandshakeResult => {
    const credential = mintCredential();
    const nowMs = config.clock();
    const expiresAt = new Date(nowMs + config.sessionTtlMs).toISOString();
    // Assembled here from server facts; nothing in it comes from a request. The
    // principal is the configured operator, the id is freshly minted, and the
    // credential never appears in the payload - only its sha256 does.
    const request = {
      commandId: randomUUID(),
      correlationId: `operator-pairing:${randomUUID()}`,
      decidedAt: new Date(nowMs).toISOString(),
      expectedVersion: 0,
      kind: "session.open",
      payload: {
        capabilities: [...config.capabilities],
        credentialSha256: credentialSha256Of(credential),
        expiresAt,
        sessionId: mintSessionId(),
      },
      principalId: config.operatorPrincipalId,
      projectId: config.projectId,
      schemaVersion: SESSION_SCHEMA_VERSION,
    };
    const outcome = runSessionCommand(
      config.store,
      encoder.encode(JSON.stringify(request)),
      undefined,
      config.reservedPrincipalIds,
    );
    if (!outcome.ok) return Object.freeze({ code: outcome.code, ok: false as const });
    return Object.freeze({
      capabilities: Object.freeze([...config.capabilities]),
      credential,
      expiresAt,
      ok: true as const,
    });
  };
  return Object.freeze({ boundProjectId: config.projectId, mint });
}
