import { describe, expect, it } from "vitest";

import { resolveLaunchEnv } from "../orchestrator/moe-up-env.js";
import type { LaunchVariable } from "../orchestrator/moe-up-env.js";
import { projectStackLaunchOverlay } from "./project-launch-overlay.js";

function variable(
  name: string, value: string, source: LaunchVariable["source"], secret = false,
): LaunchVariable {
  return Object.freeze({ name, secret, source, value });
}

describe("projectStackLaunchOverlay", () => {
  it("carries what the operator preset and what the launcher minted, in order", () => {
    expect(projectStackLaunchOverlay([
      variable("MOE_AGENT_COMMAND", "codex", "PRESET"),
      variable("MOE_DAEMON_CREDENTIAL", "ab".repeat(32), "MINTED", true),
      variable("OPENAI_API_KEY", "sk-test", "PRESET", true),
    ])).toEqual({
      MOE_AGENT_COMMAND: "codex",
      MOE_DAEMON_CREDENTIAL: "ab".repeat(32),
      OPENAI_API_KEY: "sk-test",
    });
  });

  it("drops every DEFAULTED variable: a fallback the child computes itself is not a preset", () => {
    const overlay = projectStackLaunchOverlay([
      variable("MOE_AGENT_COMMAND", "claude", "DEFAULTED"),
      variable("MOE_PROJECT_ID", "moe-next-dev", "DEFAULTED"),
      variable("ANTHROPIC_API_KEY", "sk-test", "PRESET", true),
    ]);
    expect(overlay).toEqual({ ANTHROPIC_API_KEY: "sk-test" });
    expect(Object.isFrozen(overlay)).toBe(true);
  });

  it("binds to the real launcher: an operator who set no agent command sends none into the stack", () => {
    const resolution = resolveLaunchEnv({
      env: { ANTHROPIC_API_KEY: "sk-test" },
      fileExists: () => false,
      randomHex: (bytes) => "5c".repeat(bytes),
      repoRoot: "C:\work\alpha",
    });
    if (!resolution.ok) throw new Error("expected a resolved launch");
    // The launcher's own overlay restates the default; the stack's must not.
    expect(resolution.env["MOE_AGENT_COMMAND"]).toBe("claude");
    const overlay = projectStackLaunchOverlay(resolution.variables);
    expect(overlay).not.toHaveProperty("MOE_AGENT_COMMAND");
    expect(overlay).toEqual({
      ANTHROPIC_API_KEY: "sk-test",
      MOE_DAEMON_CREDENTIAL: "5c".repeat(32),
    });
  });

  it("keeps an agent command the operator did set, so the env override still wins at spawn", () => {
    const resolution = resolveLaunchEnv({
      env: { MOE_AGENT_COMMAND: "codex", OPENAI_API_KEY: "sk-openai" },
      fileExists: () => false,
      randomHex: (bytes) => "5c".repeat(bytes),
      repoRoot: "C:\work\alpha",
    });
    if (!resolution.ok) throw new Error("expected a resolved launch");
    expect(projectStackLaunchOverlay(resolution.variables)).toMatchObject({
      MOE_AGENT_COMMAND: "codex", OPENAI_API_KEY: "sk-openai",
    });
  });
});
