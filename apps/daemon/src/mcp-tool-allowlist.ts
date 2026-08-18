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
 * The QUERY half cannot be read the same way. `createMcpDispatchPort` decides queries in
 * three literal branches (`work.get_context`, `graph.get`, `events.read`) and exports no
 * roster, so this list is stated here and BOUND BEHAVIOURALLY by
 * `mcp-tool-allowlist.test.ts`: every kind named here must survive the production port, and
 * a kind not named here must hit the port's generic INPUT_INVALID refusal. Adding a fourth
 * served query means adding it here; the test is what keeps the claim honest.
 */

export const MCP_SERVED_QUERY_KINDS: readonly string[] = Object.freeze([
  "work.get_context",
  "graph.get",
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
