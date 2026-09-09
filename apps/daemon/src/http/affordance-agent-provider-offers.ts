import type { SqliteEventStore } from "@moe/store";

import {
  AGENT_PROVIDER_COMMAND_KIND, AGENT_PROVIDER_SCHEMA_VERSION, AGENT_PROVIDER_SCOPE_INVALID,
  AGENT_PROVIDER_STORE_UNREADABLE, agentProviderAggregateId,
} from "../orchestrator/agent-provider-contracts.js";

/**
 * The `project.set_agent_provider` affordance, resolved once per project per surface read.
 *
 * WHY THIS MODULE EXISTS AT ALL (task-96957529, QA reject comment-be98d974 issue 1). The kind
 * was landed at every OTHER seam — kind constant, command module, durable store, registry row,
 * ADMIN + OPERATOR_PRINCIPAL_KINDS, `MCP_EXCLUDED_COMMAND_KINDS`, the generated client's
 * `commandBuilderFor`, a browser port, a payload roster entry and a rendered toggle — and at
 * none of them does the BROWSER learn the kind exists. It learns that from ONE place: an offer
 * on `/affordances/read`. `commandBuilderFor` (generated-client.ts:119) reads `commandId`,
 * `expectedVersion` and `targetAggregateId` off the affordance and refuses INPUT_INVALID
 * without one, so the toggle was a consumer with no producer: `live-ops.tsx:181` resolved null
 * on every poll and `agent-provider-toggle.tsx:79` greyed the control under NOT_OFFERED copy
 * that tells a CORRECTLY PAIRED operator to go and pair. Nine seams of ten is a dead control
 * that blames the operator for it.
 *
 * WHY IT IS A SIBLING OF `affordance-deploy-target-offers.ts` RATHER THAN A BRANCH INSIDE THE
 * READER. `affordance-read.ts` mints offers as explicit per-kind literals — there is no
 * registry to register into, so nothing threads by config — and the deploy-target row already
 * established the shape for a kind that is NOT a `BootstrapCommandKind`. Adding this kind to
 * `BOOTSTRAP_COMMAND_KINDS` instead would be a rebuild, not a fix: that roster is order-
 * asserted by existing suites and every consumer of the chain array would gain a `ChainStep`
 * for a project setting that has no place in the bootstrap ladder.
 *
 * AND WHY IT MINTS NO `ChainStep`. The chain is the bootstrap ORDER — what must happen before
 * what. A provider setting has no position in it: it is writable from the first read and
 * re-writable forever, and the Seats screen spends the offer directly. It also MUST NOT have
 * one: the wrapper staffs from `surface.steps` (agent-wrapper.ts:347,353), so a step here would
 * present an operator-only human decision as staffable work. `escalation.decide` and
 * `review.submit` already offer without a same-kind step, so this is the established shape.
 */
export interface AgentProviderOffer {
  /** The aggregate `setAgentProvider` commits to. Offered identity and written identity are
   *  ONE FUNCTION — `agentProviderAggregateId` — never two typed literals. */
  readonly aggregateId: string;
  /** The writer's own payload schema version, so an offer cannot advertise a schema the
   *  command does not speak. */
  readonly inputSchemaVersion: string;
  readonly kind: typeof AGENT_PROVIDER_COMMAND_KIND;
  /** READ off the store, never fabricated. 0 before the first write is the correct first
   *  `expectedVersion`, so the first set and every reset take one uniform rule. */
  readonly version: number;
}

export interface AgentProviderOfferInput {
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

export interface AgentProviderOfferResult {
  readonly offers: readonly AgentProviderOffer[];
  /** The refusing code when the setting is unreachable, so the surface can disclose WHY it
   *  offered nothing instead of looking identical to "not implemented". Null on success. */
  readonly refused: string | null;
}

function withheld(refused: string): AgentProviderOfferResult {
  return Object.freeze({ offers: Object.freeze([]), refused });
}

/**
 * ONE OFFER PER PROJECT PER POLL, at the aggregate the setter fences and the version read off
 * it. There is no set to de-duplicate because only one pass ever runs.
 *
 * THE SCOPE CHECK IS THE SETTER'S INVARIANT, RESTATED HERE RATHER THAN IMPORTED, AND THAT IS
 * DELIBERATE. `readAgentProvider` would be the natural gate — the deploy-target resolver
 * re-admits every durable suffix through `admitEnvironmentName` for exactly that reason — but
 * importing `agent-provider-store.js` from an `http/` module drags `http/health-read.js` and
 * with it the command vocabulary into this read's init path, which reorders a module-init cycle
 * and empties the registry's `payloadKeys` (measured: `daemon-foundation-command.test.ts` red at
 * PAYLOAD_SHAPE, two hops away and named nowhere near here). See `agent-provider-contracts.ts`.
 *
 * The trade is smaller than it looks. That resolver re-admits a name taken from a RAW PREFIX
 * SCAN over arbitrary durable ids; this one names a SINGLE FIXED aggregate, so there is no
 * untrusted input to launder — only the invariant that the store is bound to the project the
 * caller named, which is one call on the store handle this module already holds, and which the
 * setter refuses on with the same code from `agent-provider-contracts.ts`. The event-decode half
 * of the setter's gate is deliberately NOT restated: it guards a WRITE, and a corrupt ledger
 * surfaces here as an unreadable version below rather than as a fabricated offer.
 */
export function resolveAgentProviderOffers(
  input: AgentProviderOfferInput,
): AgentProviderOfferResult {
  const { projectId, store } = input;
  const aggregateId = agentProviderAggregateId(projectId);
  let version: number;
  try {
    if (typeof projectId !== "string" || projectId.length === 0
      || store.getHealth().projectId !== projectId) {
      return withheld(AGENT_PROVIDER_SCOPE_INVALID);
    }
    version = store.getAggregateVersion(aggregateId);
  } catch {
    // FAIL CLOSED on the store's own code. An invented version would refuse
    // EXPECTED_VERSION_CONFLICT at dispatch in front of an operator, which is strictly worse
    // than offering nothing.
    return withheld(AGENT_PROVIDER_STORE_UNREADABLE);
  }
  return Object.freeze({
    offers: Object.freeze([Object.freeze({
      aggregateId,
      inputSchemaVersion: AGENT_PROVIDER_SCHEMA_VERSION,
      kind: AGENT_PROVIDER_COMMAND_KIND,
      version,
    })]),
    refused: null,
  });
}
