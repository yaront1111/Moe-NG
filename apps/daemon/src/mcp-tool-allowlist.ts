import type { StdioPayloadPropertyOverlay, StdioPropertySchema } from "@moe/mcp";

import {
  OPERATOR_PRINCIPAL_KINDS, PAYLOAD_INTEGER_KEYS, PAYLOAD_KEYS,
} from "./daemon-command-vocabulary.js";

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
 * EVERY OPERATOR-ONLY KIND BUT `session.open` IS SUBTRACTED, and the subtraction is NOT drift —
 * see `MCP_EXCLUDED_COMMAND_KINDS` below for why the derivation alone is not the whole rule.
 * One entry hands a named part of it back: the owner's own `moe mcp --as-operator` session
 * (`MCP_DELEGABLE_OPERATOR_KINDS`). No seat and no default `moe mcp` session ever does.
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
 *
 * THE OWNER'S EXCEPTION (2026-09-18) does not touch THIS roster. `moe mcp --as-operator` serves
 * `operatorDelegateMcpToolKinds()` to one session the owner starts, and on that entry the
 * witness IS minted for a delegated caller, with no origin fact on it: the only record of how
 * the act arrived is the MCP_OPERATOR_ACT_DELEGATED diagnostics line `mcp-main.ts` writes when
 * the act is ATTEMPTED, joined to the command ledger by `commandId`.
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
  // `project.set_agent_provider` chooses which vendor receives the operator's source and
  // session credentials: it is never served to a seat or to default `moe mcp`; only the owner's
  // own `--as-operator` session gets it, by the hand-kept `MCP_DELEGABLE_OPERATOR_KINDS` below.
  // `deployment.rollback` REPLACES WHAT USERS ARE CURRENTLY RUNNING. It is not a repair and not
  // a retry: it takes a product that is live and serving real traffic and puts an EARLIER build
  // back in front of those users, discarding whatever the current one has been doing for them
  // since it shipped. Whether that trade is worth making is a judgement about the operator's own
  // product and its users, and only they can make it. The exclusion matters more here than
  // capability scoping would: the MCP port authenticates with the operator bootstrap credential,
  // so an advertised operator kind is an agent arriving AS the operator, and a capability gate
  // would pass. Keeping the kind off this roster is the fence.
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
 * The allowlist the seats' host (mcp-http) and default `moe mcp` pass to `@moe/mcp`. One frozen
 * value, computed once, so two reads are identical and neither can be handed a roster the other
 * did not get. `moe mcp --as-operator` alone takes `operatorDelegateMcpToolKinds()` instead.
 */
export function wiredMcpToolKinds(): readonly string[] {
  return WIRED_KINDS;
}

/**
 * THE OWNER'S DELEGATE ROSTER (owner decision 2026-09-18): the operator-only kinds
 * `moe mcp --as-operator` adds for ONE outside session the owner hands their own seat to.
 *
 * HAND-KEPT, NOT DERIVED, and that is the point. `MCP_EXCLUDED_COMMAND_KINDS` derives itself
 * from `OPERATOR_PRINCIPAL_KINDS` so a new human-only kind LEAVES the seats' roster with no
 * edit; deriving this list the same way would make the same new kind JOIN the delegate's
 * roster with no edit, and nobody would have decided that. `mcp-tool-allowlist.test.ts` proves
 * this list and `MCP_NEVER_DELEGATED_KINDS` PARTITION the exclusion exactly, so a kind that
 * becomes operator-only reds until somebody classifies it here by hand.
 *
 * What is on it: the DECISIONS a product waits on — approving a plan or a graph, answering an
 * exhausted review, answering a clarification, closing or cancelling a goal — and the
 * settings that are one durable write. Each is served by the synchronous registry, which admits
 * the operator principal this entry authenticates as, and each is WHOLE in that one write:
 * nothing about it lives in the memory of the `moe start` process (`preview.decide` fails
 * exactly that test, which is why it is on the other list).
 *
 * THIS IS THE ONLY FENCE for these kinds on that entry: the registry's operator check passes
 * (the credential IS the operator's), so nothing downstream refuses. It is reachable from
 * `composeStdioServer({ asOperator: true })` alone. The wrapper's seat host
 * (`mcp-http/mcp-http-host.ts`) takes `wiredMcpToolKinds()` and has no option that could name
 * this roster; `mcp-tool-allowlist.test.ts` reads that file's source to keep it so, and a seat
 * that somehow saw one of these tools would still be refused OPERATOR_PRINCIPAL_REQUIRED,
 * because its bearer is a scoped session and never the operator.
 */
export const MCP_DELEGABLE_OPERATOR_KINDS: readonly string[] = Object.freeze([
  "approval.decide",
  "approval.decide_intent",
  "deployment.set_target",
  "environment.unset_variable",
  "escalation.decide",
  "goal.cancel",
  "goal.close",
  "graph.approve",
  "graph.supersede",
  "integration.accept_output",
  "monitoring.retire_environment",
  "monitoring.set_probe_interval",
  "product_contract.answer_clarification",
  "project.set_agent_provider",
  "resource.confirm_released",
]);

/**
 * Operator-only kinds NO MCP session gets, delegate included, each for a reason a flag cannot
 * change. Advertising any of them would be the defect this module exists to close: a tool that
 * can only ever refuse, or one whose arguments must never reach a client's log.
 */
export const MCP_NEVER_DELEGATED_KINDS: readonly string[] = Object.freeze([
  // Refuse every MCP transport origin BY NAME at the handler (criterion-command-edge.ts,
  // repository-recovery-command.ts): evidence about the physical product, judged by a person.
  "criterion_check.approve",
  "criterion_check.verify",
  "repository.recover",
  // The operator asserting what their own remote holds: recover's class of evidence, but served
  // from an ASYNC entry that fences on the operator principal, not on the transport origin.
  "repository.publish_resolve",
  // Requires a durable paired HUMAN principal, which the operator credential is not.
  "repository.publish",
  // Its payload carries the variable's VALUE, and MCP clients log tool arguments
  // (`@moe/mcp` stdio-tool-schemas.ts): a production secret would land in a transcript.
  "environment.set_variable",
  // Commits synchronously, but its EFFECT — stopping the dev server — lives in the in-memory
  // supervisor of the process that served `preview.start`. `moe mcp` composes a second, empty
  // supervisor, so from here the verdict would land and the preview would never stop: a stated
  // `preview port:` then refuses every later preview until `moe start` is restarted.
  "preview.decide",
  // A synchronous handler, but the one-way GA activation reads MOE_CUTOVER_EVIDENCE_ROOT, which
  // only the daemon host carries.
  "cutover.activate",
  // Served from ASYNC entries that run their effect IN THE SERVING PROCESS — a `gh` push, a dev
  // server and a browser, a deploy, a migration — against host configuration `moe mcp` does not
  // carry (MOE_NODE_WORKSPACE, MOE_DEPLOY_BUILD_CONTEXT, MOE_FOUNDATION_WORKSPACE_CATALOG).
  // They belong to the daemon host and the control room.
  "deployment.deploy",
  "deployment.migrate_down",
  "deployment.rollback",
  "preview.start",
  "product_contract.sync_env_example",
  "release.decide",
  "repository.bootstrap",
]);

const OPERATOR_DELEGATE_KINDS: readonly string[] = Object.freeze([
  ...[...Object.keys(PAYLOAD_KEYS)]
    .filter((kind) => !MCP_EXCLUDED_COMMAND_KINDS.includes(kind)
      || MCP_DELEGABLE_OPERATOR_KINDS.includes(kind))
    .sort(),
  ...MCP_SERVED_QUERY_KINDS,
]);

/** The roster `moe mcp --as-operator` serves, and nothing else ever does. */
export function operatorDelegateMcpToolKinds(): readonly string[] {
  return OPERATOR_DELEGATE_KINDS;
}

/**
 * The typed payload members an MCP entry advertises, DERIVED from `PAYLOAD_INTEGER_KEYS` for
 * the kinds ITS roster carries and nothing else. Filtering by the roster is what keeps
 * `@moe/mcp`'s overlay check strict: `graph.supersede` is typed in the table and operator-only,
 * so an overlay naming it beside the seats' roster would refuse at construction
 * (MCP_PAYLOAD_OVERLAY_UNKNOWN_KIND) rather than quietly advertising a member of a tool that is
 * not there — and the delegate's roster, which does carry it, gets its integers typed.
 */
function payloadPropertiesFor(roster: readonly string[]): StdioPayloadPropertyOverlay {
  return Object.freeze(Object.fromEntries(
    Object.entries(PAYLOAD_INTEGER_KEYS)
      .filter(([kind]) => roster.includes(kind))
      .map(([kind, members]) => [kind, Object.freeze(Object.fromEntries(
        Object.entries(members).map(([key, spec]): [string, StdioPropertySchema] => [key, Object.freeze({
          description: spec.description,
          maximum: Number.MAX_SAFE_INTEGER,
          minimum: spec.minimum,
          type: "integer" as const,
        })]),
      ))]),
  ));
}

const WIRED_PAYLOAD_PROPERTIES = payloadPropertiesFor(WIRED_KINDS);
const OPERATOR_DELEGATE_PAYLOAD_PROPERTIES = payloadPropertiesFor(OPERATOR_DELEGATE_KINDS);

export function wiredMcpPayloadProperties(): StdioPayloadPropertyOverlay {
  return WIRED_PAYLOAD_PROPERTIES;
}

export function operatorDelegateMcpPayloadProperties(): StdioPayloadPropertyOverlay {
  return OPERATOR_DELEGATE_PAYLOAD_PROPERTIES;
}
