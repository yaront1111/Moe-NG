import type { SqliteEventStore } from "@moe/store";

import { readSessionLedger } from "../identity/session-read-model.js";
import type { AuthenticatedPrincipal } from "./http-contract.js";

interface EventResumeAuthorityInput {
  readonly operatorCapabilities: readonly string[];
  readonly operatorPrincipalId: string;
  readonly principal: AuthenticatedPrincipal;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

function sameCapabilities(
  actual: readonly string[], expected: readonly string[],
): boolean {
  if (actual.length !== expected.length) return false;
  const actualSet = new Set(actual);
  return actualSet.size === expected.length
    && expected.every((capability) => actualSet.has(capability));
}

/**
 * Authorizes recovery of the daemon's one shared control-room reader.
 *
 * A plain WORK session is deliberately insufficient: advancing this cursor can
 * change what the live control room observes. Authority belongs to the configured
 * operator itself or to a durable operator-opened session carrying the exact full
 * operator capability set used by the approved pairing flow. The session record is
 * re-read from daemon-owned storage; caller payload and target bytes choose nothing.
 */
export function hasEventResumeOperatorAuthority(
  input: EventResumeAuthorityInput,
): boolean {
  const {
    operatorCapabilities, operatorPrincipalId, principal, projectId, store,
  } = input;
  if (principal.projectId !== projectId
    || !sameCapabilities(principal.capabilities, operatorCapabilities)) {
    return false;
  }
  if (principal.principalId === operatorPrincipalId) return true;

  const ledger = readSessionLedger(store, projectId);
  if (ledger.unreadable) return false;
  const session = ledger.sessions.get(principal.principalId);
  return session !== undefined
    && session.status === "OPEN"
    && session.principalId === operatorPrincipalId
    && sameCapabilities(session.capabilities, operatorCapabilities);
}
