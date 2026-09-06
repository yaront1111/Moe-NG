import { OPERATOR_PRINCIPAL_KINDS, PAYLOAD_KEYS } from "./daemon-command-vocabulary.js";

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
 * TWO KINDS ARE SUBTRACTED, and the subtraction is NOT drift — see `MCP_EXCLUDED_COMMAND_KINDS`
 * below for why the derivation alone is not the whole rule.
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
  "product_contract.read",
  "events.read",
  "documents.source_read",
  // The seat's read of the design it (or a peer seat) authored. A QUERY, so it is served ONLY
  // through this roster plus a `QUERY_HANDLERS` entry -- it has no command family, no
  // PAYLOAD_KEYS row and no registry entry, exactly like `product_contract.read` above. Both
  // halves land together on purpose: an entry here without a handler advertises a capability
  // the port cannot serve, and `mcp-tool-allowlist.test.ts`'s arm Q1 reds on either alone.
  "design.read",
]);

/**
 * The command kinds this daemon wires but REFUSES TO ADVERTISE OVER MCP.
 *
 * `approval.decide` and `graph.approve` are HUMAN ACTS. `daemon-command-registry.ts:185` mints
 * the `humanReview` witness on OPERATOR PRINCIPAL IDENTITY ALONE — the transport fact
 * task-3b61860f added carries the authenticated principal id and the envelope's command id,
 * which an MCP caller holding that credential would present identically, so it still does not
 * DISTINGUISH the caller — and `mcp-dispatch-port.ts` authenticates with the operator bootstrap
 * credential supplied as `fallbackCredential` (`mcp-main.ts:112-127`). An MCP caller holding
 * that credential would therefore authenticate AS the operator and receive a witness
 * INDISTINGUISHABLE from a browser operator's. Excluding the two kinds here refuses them at
 * the transport with `CAPABILITY_DENIED` (`stdio-server.ts:168`, `http-tool-bridge.ts:195`)
 * BEFORE envelope construction, authentication or dispatch — which is precisely what makes
 * the downstream witness trustworthy as a human-act witness.
 *
 * SUBTRACTED HERE, NOT DELETED UPSTREAM. The kinds stay fully wired in `PAYLOAD_KEYS` and in
 * the command registry, so the browser/HTTP approval path is untouched. This removes them
 * from ONE transport's advertisement, not from the daemon.
 *
 * Ruling: comment-4d026de3fc24449d927f9eee28da6114 (task-4c9b1d85), path (b) of an either/or
 * pair whose alternative was a server-set transport-origin field. RE-ADMITTING EITHER KIND TO
 * THIS ROSTER INVALIDATES THAT CONTRACT and requires the origin field to land first.
 */
/**
 * The one operator-only kind that stays on the MCP roster: minting a scoped daemon session is
 * the operator's OWN act on the MCP HTTP bearer path (the host authorizes every command as the
 * request bearer, never as its bootstrap identity), it mints no human-review witness, and the
 * registry's principal fence already refuses it to any non-operator bearer.
 */
const MCP_REACHABLE_OPERATOR_KINDS: ReadonlySet<string> = new Set(["session.open"]);

export const MCP_EXCLUDED_COMMAND_KINDS: readonly string[] = Object.freeze([
  // DERIVED, NOT HAND-KEPT: every kind the vocabulary reserves for the operator principal,
  // less the one above. The hand list used to name six of them (the two approval kinds, the
  // intent wire, the clarification answer, the one-way activation, the remote publish) while
  // `graph.supersede`, `goal.close`, `integration.accept_output`, `resource.confirm_released`
  // and `preview.decide` — operator-only by the same table — stayed advertised. The stdio entry
  // authenticates with the operator secret as `fallbackCredential`, so an MCP caller reached
  // `graph.supersede` AS the operator and the registry minted the human-review witness for it:
  // exactly the scenario the contract above declares invalid. Deriving keeps
  // `daemon-command-vocabulary.ts` the single place the human-only class is stated: a kind that
  // becomes operator-only leaves the MCP roster with no edit here.
  ...[...OPERATOR_PRINCIPAL_KINDS].filter((kind) => !MCP_REACHABLE_OPERATOR_KINDS.has(kind)).sort(),
]);

const WIRED_KINDS: readonly string[] = Object.freeze([
  ...[...Object.keys(PAYLOAD_KEYS)]
    // Command half only. The query half below is NEVER filtered.
    .filter((kind) => !MCP_EXCLUDED_COMMAND_KINDS.includes(kind))
    .sort(),
  ...MCP_SERVED_QUERY_KINDS,
]);

/**
 * The allowlist both MCP entries pass to `@moe/mcp`. One frozen value, computed once, so two
 * reads are identical and neither transport can be handed a roster the other did not get.
 */
export function wiredMcpToolKinds(): readonly string[] {
  return WIRED_KINDS;
}
