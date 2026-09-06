import { DomainRefusal } from "../daemon-command-dispatch.js";
import type { DurableDecision } from "../http/http-contract.js";
import type { AgentProviderStoreConfig, setAgentProvider } from "./agent-provider-store.js";

export const AGENT_PROVIDER_COMMAND_KIND = "project.set_agent_provider";
export const AGENT_PROVIDER_PAYLOAD_KEYS = Object.freeze(["base", "goalId", "provider"] as const);

interface ProviderCommandContext extends AgentProviderStoreConfig {
  /** Inject at composition: importing the store here creates a health/vocabulary cycle. */
  readonly setProvider: typeof setAgentProvider;
  readonly envelope: {
    readonly commandId: string;
    readonly payload: Readonly<Record<string, unknown>>;
  };
}

/** The registry performs authority/operator checks before supplying this store-bound context.
 * A direct unconfigured invocation retains the original composition refusal. */
export function runAgentProviderCommand(context?: ProviderCommandContext): DurableDecision {
  if (context === undefined) {
    throw new DomainRefusal("AGENT_PROVIDER_UNCONFIGURED", "DAEMON_COMPOSITION",
      "no agent provider settings service is configured for this daemon");
  }
  const { base, goalId, provider } = context.envelope.payload;
  if (typeof base !== "string" || typeof goalId !== "string") {
    throw new DomainRefusal("AGENT_PROVIDER_PAYLOAD_INVALID", "DAEMON_COMPOSITION",
      "provider settings require string base and goalId fields");
  }
  const result = context.setProvider(context, { base, goalId, provider, commandId: context.envelope.commandId });
  if (!result.ok) throw new DomainRefusal(result.code, result.layer, result.code);
  return Object.freeze({ commandId: result.commandId, effectId: null,
    disposition: result.disposition === "REPLAYED" ? "REPLAYED" : "DECIDED", resultCode: "AGENT_PROVIDER_SET" });
}
