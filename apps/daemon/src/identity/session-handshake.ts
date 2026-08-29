import { randomBytes, randomUUID } from "node:crypto";

import type { SqliteEventStore } from "@moe/store";

import { credentialSha256Of } from "./session-authenticator.js";
import { createSessionAuthority } from "./session-authority.js";
import { SESSION_SCHEMA_VERSION } from "./session-contracts.js";
import { runSessionCommand } from "./session-services.js";

/**
 * The operator credential mint consumed only by an approved pairing claim.
 *
 * The handshake exists so no secret is ever baked into the hosted page: the page
 * creates a server-side request, the foreground operator confirms its bounded
 * label out of band, and only then may the claim receive a credential minted
 * HERE. This port does not invent a second credential store; it opens a real session through the same
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

/** Server-owned profile fact for principals minted only by the approved pairing seam. */
export const OPERATOR_PROFILE_REVISION_ID = "operator-pairing-profile:v1" as const;

export interface SessionHandshakeMinted {
  readonly capabilities: readonly string[];
  /** The plaintext bearer credential - returned ONCE, never stored here or logged. */
  readonly credential: string;
  readonly expiresAt: string;
  readonly ok: true;
}

/**
 * What a refused mint left behind, and therefore whether the approval that drove
 * it may be claimed again. RELEASE: nothing durable was written for this attempt.
 * BURN: a durable HUMAN principal already committed, so a retry would mint a
 * SECOND one under a fresh id and orphan the first.
 */
export type SessionHandshakeDisposition = "BURN" | "RELEASE";

export interface SessionHandshakeRefused {
  /** The session layer's own refusal code, carried verbatim so no oracle is minted here. */
  readonly code: string;
  /**
   * The retry disposition of this refusal. Optional ONLY so hand-written port
   * doubles stay valid: a refusal that omits it BURNS at the pairing seam, which
   * is the fail-closed default. Production sets it at every refusal site.
   */
  readonly disposition?: SessionHandshakeDisposition;
  /** The refusing layer, carried verbatim; optional only for hand-written port doubles. */
  readonly layer?: string;
  readonly ok: false;
}

export type SessionHandshakeResult = SessionHandshakeMinted | SessionHandshakeRefused;

/**
 * The mint the approved-claim handler consumes. `boundProjectId` is the server fact `/bootstrap`
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

/** Carries the refusing layer's own code and layer verbatim; only `disposition` is added here. */
function refuse(
  code: string,
  layer: string,
  disposition: SessionHandshakeDisposition,
): SessionHandshakeRefused {
  return Object.freeze({ code, disposition, layer, ok: false as const });
}

interface OpenRequestParts {
  readonly correlationId: string;
  readonly credentialSha256: string;
  readonly expiresAt: string;
  readonly nowMs: number;
  readonly sessionId: string;
}

/**
 * Assembles the `session.open` request from server facts alone: the principal is
 * the configured operator, the id is freshly minted, and the credential never
 * appears in the payload - only its sha256 does.
 */
function buildOpenRequest(
  config: OperatorSessionHandshakeConfig,
  parts: OpenRequestParts,
): Record<string, unknown> {
  return {
    commandId: randomUUID(),
    correlationId: parts.correlationId,
    decidedAt: new Date(parts.nowMs).toISOString(),
    expectedVersion: 0,
    kind: "session.open",
    payload: {
      capabilities: [...config.capabilities],
      credentialSha256: parts.credentialSha256,
      expiresAt: parts.expiresAt,
      sessionId: parts.sessionId,
    },
    principalId: config.operatorPrincipalId,
    projectId: config.projectId,
    schemaVersion: SESSION_SCHEMA_VERSION,
  };
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
  const sessions = createSessionAuthority(config.store, {
    clock: config.clock,
    projectId: config.projectId,
  });
  const mint = (): SessionHandshakeResult => {
    const sessionId = mintSessionId();
    const correlationId = `operator-pairing:${randomUUID()}`;
    // The principal write now precedes session.open, so mirror its reserved-id
    // fence before either durable authority can acquire the colliding identity.
    // Nothing durable has been written yet, so the approval is safe to retry.
    if (config.reservedPrincipalIds?.includes(sessionId) === true) {
      return refuse("SESSION_ID_RESERVED", "DAEMON_INGRESS", "RELEASE");
    }
    // HUMAN and the profile revision are server facts of this approved-pairing seam.
    const principal = sessions.createPrincipal({
      commandId: randomUUID(),
      correlationId,
      kind: "HUMAN",
      principalId: sessionId,
      profileRevisionId: OPERATOR_PROFILE_REVISION_ID,
    });
    // A refused mutation wrote nothing, so the approval is still safe to retry.
    if (!principal.ok) return refuse(principal.code, principal.layer, "RELEASE");
    const credential = mintCredential();
    const nowMs = config.clock();
    const expiresAt = new Date(nowMs + config.sessionTtlMs).toISOString();
    const outcome = runSessionCommand(
      config.store,
      encoder.encode(JSON.stringify(buildOpenRequest(config, {
        correlationId,
        credentialSha256: credentialSha256Of(credential),
        expiresAt,
        nowMs,
        sessionId,
      }))),
      undefined,
      config.reservedPrincipalIds,
    );
    // The HUMAN principal is ALREADY durable here. Releasing the approval would let
    // the next claim mint a second principal under a fresh id, so it must burn.
    if (!outcome.ok) return refuse(outcome.code, outcome.refusedBy, "BURN");
    return Object.freeze({
      capabilities: Object.freeze([...config.capabilities]),
      credential,
      expiresAt,
      ok: true as const,
    });
  };
  return Object.freeze({ boundProjectId: config.projectId, mint });
}
