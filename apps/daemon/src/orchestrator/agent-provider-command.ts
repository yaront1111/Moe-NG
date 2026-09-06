import { DomainRefusal } from "../daemon-command-dispatch.js";

export const AGENT_PROVIDER_COMMAND_KIND = "project.set_agent_provider";
export const AGENT_PROVIDER_PAYLOAD_KEYS = Object.freeze(["base", "goalId", "provider"] as const);

/** Deliberately unconfigured until the durable provider-setting service is composed.
 * No store or request is accepted here, so this seam cannot manufacture a setting or receipt.
 */
export function runAgentProviderCommand(): never {
  throw new DomainRefusal(
    "AGENT_PROVIDER_UNCONFIGURED", "DAEMON_COMPOSITION",
    "no agent provider settings service is configured for this daemon",
  );
}
