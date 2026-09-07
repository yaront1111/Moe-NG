/**
 * THE AGENT-PROVIDER SETTING'S LEAF FACTS: the command kind, the aggregate it lives on, its
 * payload schema version and its two refusal codes.
 *
 * WHY A LEAF MODULE AND NOT `agent-provider-store.ts` (measured, task-96957529). The store
 * imports `KNOWN_PROVIDERS` from `../http/health-read.js`, and health-read pulls in the
 * command vocabulary, the ingress and the payload-key roster. Importing the store from
 * `http/affordance-agent-provider-offers.ts` therefore entered `daemon-command-payload-keys.ts`
 * from a NEW direction mid-cycle and left the registry's `payloadKeys` empty at module-init:
 * `daemon-foundation-command.test.ts` went red with `activationRequestBytesBase64` refused
 * INPUT_INVALID at PAYLOAD_SHAPE — an advertised key the gate should admit. Nothing in that
 * suite names this module; the red surfaced two hops away and was found only by re-running the
 * gate with this diff removed.
 *
 * `agent-provider-command.ts` already states the rule this module obeys — "importing the store
 * here creates a health/vocabulary cycle" — and answers it by injecting at composition. A
 * surface read cannot inject, so the facts a reader needs move DOWN to a module that imports
 * NOTHING instead. Keep it that way: one import here re-opens the cycle.
 */

/** The operator-only command kind. Re-exported by `agent-provider-command.ts`, which is where
 *  the registry, the vocabulary and the payload roster still import it from. */
export const AGENT_PROVIDER_COMMAND_KIND = "project.set_agent_provider";

/** The settings family's payload schema version: the event payload's `version` AND the
 *  `inputSchemaVersion` `/affordances/read` offers, so an offer can never advertise a schema
 *  the writer does not speak. */
export const AGENT_PROVIDER_SCHEMA_VERSION = "moe-agent-provider/1";

/** The store is bound to a different project than the caller named. */
export const AGENT_PROVIDER_SCOPE_INVALID = "AGENT_PROVIDER_SCOPE_INVALID";

/** A committed provider event did not decode back as provider facts. */
export const AGENT_PROVIDER_STORE_UNREADABLE = "AGENT_PROVIDER_STORE_UNREADABLE";

/** THE ONE AGGREGATE THIS SETTING LIVES ON. The affordance offer's `targetAggregateId` and the
 *  aggregate `setAgentProvider` fences are this same function, never two typed literals. */
export function agentProviderAggregateId(projectId: string): string {
  return `agent-provider/${encodeURIComponent(projectId)}`;
}
