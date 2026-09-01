import type { SqliteEventStore } from "@moe/store";

import type {
  SessionPrerequisiteRefusalCode,
  SessionRefusedBy,
} from "./session-contracts.js";
import { readSessionLedger } from "./session-read-model.js";
import type { SessionLedger } from "./session-read-model.js";

/**
 * The scoped read of a session's stored credential digest, for Foundation dispatch.
 *
 * PREIMAGE CHAIN, and the reason this is the only honest source: `agent-wrapper.ts` mints a
 * per-agent secret and delivers it to the spawned child as its scoped MCP bearer; the daemon
 * only ever sees SHA-256 of that secret, which `session.open` persists as
 * `SessionRecord.credentialSha256`. So the digest returned here is exactly the
 * `bootstrapCredentialDigest` a dispatch template needs, derived from durable state rather than
 * taken from the caller. The provider-profile aggregate is a DIFFERENT identity
 * (project/profile, not project/session), provider API environment tokens are a separate
 * credential axis, and activation/attempt records only relay the value after launch — none of
 * them may be substituted here.
 *
 * CONSUMER: task-fc9660b0a4f24891908a11e303a7c347 composes this reader in the dispatch handler,
 * calling it with server-derived identities (the authenticated principal's project/session and
 * the durable activation lease's `ownerSessionRef`) and passing `code`/`refusedBy` through
 * untranslated. It must call THIS function rather than growing a duplicate helper: a second
 * implementation is a second place for the scoping rules below to drift.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: it never hashes anything. No provider API token,
 * no `MOE_DAEMON_CREDENTIAL`, no profile data, no caller payload. Its only read is the session
 * fold, and it imports nothing from the provider-profile or activation lanes.
 */

const REFUSED_BY: SessionRefusedBy = "DAEMON_PREREQUISITE";

export interface SessionCredentialDigestOk {
  readonly credentialSha256: string;
  readonly ok: true;
}

export interface SessionCredentialDigestRefusal {
  readonly code: SessionPrerequisiteRefusalCode;
  readonly detail: string;
  readonly ok: false;
  readonly refusedBy: SessionRefusedBy;
}

export type SessionCredentialDigestResult =
  | SessionCredentialDigestOk
  | SessionCredentialDigestRefusal;

/**
 * Details are fixed prose, never interpolated. An interpolated detail is how a digest, a session
 * id, or a store error string escapes through the one field a refusal is allowed to carry.
 */
function refuse(
  code: SessionPrerequisiteRefusalCode,
  detail: string,
): SessionCredentialDigestRefusal {
  return Object.freeze({ code, detail, ok: false as const, refusedBy: REFUSED_BY });
}

const LEDGER_UNREADABLE = "the session ledger did not fold back as session facts";
const STORE_UNAVAILABLE = "the session ledger could not be read from the durable store";
const DIGEST_UNAVAILABLE = "no OPEN session with that id is readable for this project";

/**
 * Returns the stored `credentialSha256` for `sessionId`, and only when that session is OPEN in
 * `projectId`. Every other outcome is a refusal that carries no digest.
 *
 * The project filter is NOT applied here: `readSessionLedger` applies it inside its fold, so a
 * session belonging to another project is simply absent from `ledger.sessions`. That is why
 * absent, foreign-project and CLOSED share ONE code — differentiating them would let a caller in
 * project Q probe which session ids are live in project P. Re-implementing the project check
 * here would also duplicate the fold's rule and give it a second place to drift.
 */
export function readSessionCredentialDigest(
  store: SqliteEventStore,
  projectId: string,
  sessionId: string,
): SessionCredentialDigestResult {
  let ledger: SessionLedger;
  try {
    ledger = readSessionLedger(store, projectId);
  } catch {
    // CONTAINED: the fold does not wrap its own store call, so a dead handle would otherwise
    // reach this reader's caller as a throw. The caught error is discarded rather than echoed —
    // a detail built from it is one refactor away from carrying stored bytes out with it.
    return refuse("SESSION_LEDGER_UNREADABLE", STORE_UNAVAILABLE);
  }
  if (ledger.unreadable) {
    // Fail closed, and NOT as "unavailable": corrupt bytes must not read as a free session id.
    return refuse("SESSION_LEDGER_UNREADABLE", LEDGER_UNREADABLE);
  }
  const record = ledger.sessions.get(sessionId);
  if (record === undefined || record.status !== "OPEN") {
    return refuse("SESSION_CREDENTIAL_DIGEST_UNAVAILABLE", DIGEST_UNAVAILABLE);
  }
  // The stored hash's shape is re-checked by `parseOpened` on READ, so a malformed digest never
  // reaches a record — it folds to `unreadable` above. A shape guard here would be unreachable.
  return Object.freeze({ credentialSha256: record.credentialSha256, ok: true as const });
}
