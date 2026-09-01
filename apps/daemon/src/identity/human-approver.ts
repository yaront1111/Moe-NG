/**
 * Whether an authenticated principal id names a DURABLY MINTED HUMAN principal.
 *
 * The approved-pairing seam (`createOperatorSessionHandshakePort`) commits a
 * `SessionAuthorityPrincipalCreated` record with `kind: "HUMAN"` under the SAME id
 * the session later authenticates as (the mint sets `principalId = sessionId`), so
 * one durable read answers the question. Sessions opened any other way — the
 * wrapper's `session.open` for agents, scoped test sessions — leave no principal
 * record under their session id and answer false. Fail-closed on every unreadable
 * or ambiguous read: only a FOUND record spelling HUMAN admits.
 *
 * Consumed by the command registry's operator-principal fence and the approval
 * intent edge's human-review witness (operator ruling 2026-08-30: sessions minted
 * from an operator-approved pairing are the approver seat for
 * `approval.decide_intent`). The witness stays trustworthy on principal identity
 * alone ONLY while the kind is excluded from the MCP roster — see
 * `MCP_EXCLUDED_COMMAND_KINDS`.
 */
import type { SqliteEventStore } from "@moe/store";

import { readPrincipalRecord } from "./session-authority-store.js";

export function isDurableHumanPrincipal(
  store: SqliteEventStore,
  principalId: string,
): boolean {
  const read = readPrincipalRecord(store, principalId);
  return read.status === "FOUND" && read.principal.kind === "HUMAN";
}
