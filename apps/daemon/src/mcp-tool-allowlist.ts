import { PAYLOAD_KEYS } from "./daemon-command-vocabulary.js";

/**
 * The tools this daemon may honestly advertise over MCP.
 *
 * DERIVED, NOT COPIED. The command half is read from `PAYLOAD_KEYS` — the same table the
 * registry composes its entries from — so a kind wired there appears here with no edit, and
 * a kind removed there disappears from the advertisement. A hand-kept roster would drift
 * silently, which is the whole defect this closes: the generated MCP surface advertises one
 * tool per closed-vocabulary kind, and every kind this daemon does not wire answers with a
 * refusal an agent had no way to anticipate.
 *
 * The QUERY half stays HAND-KEPT ON PURPOSE, and that is not drift. `createMcpDispatchPort`
 * now routes queries through a frozen handler table and exports the served set as
 * `servedMcpQueryKinds()`, so this list is the independent ADVERTISED oracle to compare it
 * against. Importing the served set here would collapse the two enumerations into one and
 * make the parity assertion tautological — the whole point is that
 * `mcp-tool-allowlist.test.ts` proves EXACT SET EQUALITY IN BOTH DIRECTIONS between this
 * roster and the port's table, so an entry added to either side alone reddens. The older
 * behavioural binding stays too: every kind named here must survive the production port, and
 * a kind not named here must hit the port's generic INPUT_INVALID refusal.
 */

export const MCP_SERVED_QUERY_KINDS: readonly string[] = Object.freeze([
  "work.get_context",
  "graph.get",
  "graph.preview",
  "events.read",
]);

const WIRED_KINDS: readonly string[] = Object.freeze([
  ...[...Object.keys(PAYLOAD_KEYS)].sort(),
  ...MCP_SERVED_QUERY_KINDS,
]);

/**
 * The allowlist both MCP entries pass to `@moe/mcp`. One frozen value, computed once, so two
 * reads are identical and neither transport can be handed a roster the other did not get.
 */
export function wiredMcpToolKinds(): readonly string[] {
  return WIRED_KINDS;
}
