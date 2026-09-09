import { expect, it } from "vitest";
import {
  AGENT_PROVIDER_COMMAND_KIND, AGENT_PROVIDER_PAYLOAD_KEYS, runAgentProviderCommand,
} from "./agent-provider-command.js";

it("publishes only the exact provider-setting intent keys", () => {
  expect(AGENT_PROVIDER_COMMAND_KIND).toBe("project.set_agent_provider");
  expect(AGENT_PROVIDER_PAYLOAD_KEYS).toEqual(["base", "goalId", "provider"]);
  expect(Object.isFrozen(AGENT_PROVIDER_PAYLOAD_KEYS)).toBe(true);
});

it("refuses an unconfigured provider command at composition, not bootstrap", () => {
  expect(runAgentProviderCommand).toThrowError(expect.objectContaining({
    code: "AGENT_PROVIDER_UNCONFIGURED", layer: "DAEMON_COMPOSITION", httpStatus: 422,
  }));
});
