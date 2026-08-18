import { describe, expect, it } from "vitest";

import {
  MOE_UP_ENV_MISSING,
  describeLaunchVariables,
  resolveLaunchEnv,
} from "./moe-up-env.js";
import type { LaunchEnvResolution } from "./moe-up-env.js";

const REPO_ROOT = "D:/repo";

/** A fixed randomness source: the resolver's only nondeterministic input. */
const fixedHex = (bytes: number): string => "ab".repeat(bytes);

function resolved(
  env: Readonly<Record<string, string | undefined>>,
): Extract<LaunchEnvResolution, { ok: true }> {
  const result = resolveLaunchEnv({ env, randomHex: fixedHex, repoRoot: REPO_ROOT });
  if (!result.ok) {
    throw new Error(`expected a launch config, got ${result.refusals.map((r) => r.variable).join(",")}`);
  }
  return result;
}

function refused(
  env: Readonly<Record<string, string | undefined>>,
): Extract<LaunchEnvResolution, { ok: false }> {
  const result = resolveLaunchEnv({ env, randomHex: fixedHex, repoRoot: REPO_ROOT });
  if (result.ok) throw new Error("expected a refusal, got a launch config");
  return result;
}

const sourceOf = (
  config: Extract<LaunchEnvResolution, { ok: true }>,
  name: string,
): string | undefined => config.variables.find((entry) => entry.name === name)?.source;

describe("resolveLaunchEnv dev defaults", () => {
  it("defaults the store path under the repo root and reports it as defaulted", () => {
    const config = resolved({ ANTHROPIC_API_KEY: "sk-test" });
    // Separator-normalized on BOTH sides so the assertion pins the location, not
    // the platform's path style. Pinned by segments rather than by re-running
    // join(): a test that rebuilds the path the way production does asserts
    // nothing about where the dev store actually lands.
    const path = config.storePath.replaceAll("\\", "/");
    expect(path.startsWith(REPO_ROOT)).toBe(true);
    expect(path.slice(REPO_ROOT.length)).toBe("/.moe-dev/store.sqlite");
    expect(sourceOf(config, "MOE_STORE_PATH")).toBe("DEFAULTED");
  });

  it("defaults the project id to moe-next-dev and reports it as defaulted", () => {
    const config = resolved({ ANTHROPIC_API_KEY: "sk-test" });
    expect(config.projectId).toBe("moe-next-dev");
    expect(sourceOf(config, "MOE_PROJECT_ID")).toBe("DEFAULTED");
  });

  it("mints a dev credential from the injected randomness and reports it as minted", () => {
    const config = resolved({ ANTHROPIC_API_KEY: "sk-test" });
    expect(config.credential).toBe(fixedHex(32));
    expect(sourceOf(config, "MOE_DAEMON_CREDENTIAL")).toBe("MINTED");
  });

  it("mints a different credential on each real run, so the dev secret is not a constant", () => {
    const first = resolveLaunchEnv({ env: { ANTHROPIC_API_KEY: "sk-test" }, repoRoot: REPO_ROOT });
    const second = resolveLaunchEnv({ env: { ANTHROPIC_API_KEY: "sk-test" }, repoRoot: REPO_ROOT });
    if (!first.ok || !second.ok) throw new Error("expected two launch configs");
    expect(first.credential).not.toBe(second.credential);
    expect(first.credential).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("keeps every preset value and reports each as preset", () => {
    const config = resolved({
      ANTHROPIC_API_KEY: "sk-test",
      MOE_DAEMON_CREDENTIAL: "preset-credential",
      MOE_PROJECT_ID: "preset-project",
      MOE_STORE_PATH: "D:/scratch/store.sqlite",
    });
    expect(config.storePath).toBe("D:/scratch/store.sqlite");
    expect(config.projectId).toBe("preset-project");
    expect(config.credential).toBe("preset-credential");
    for (const name of ["MOE_STORE_PATH", "MOE_PROJECT_ID", "MOE_DAEMON_CREDENTIAL"]) {
      expect(sourceOf(config, name)).toBe("PRESET");
    }
  });

  it("treats an empty preset as absent for every defaulted variable", () => {
    const config = resolved({
      ANTHROPIC_API_KEY: "sk-test",
      MOE_DAEMON_CREDENTIAL: "",
      MOE_PROJECT_ID: "",
      MOE_STORE_PATH: "",
    });
    expect(sourceOf(config, "MOE_STORE_PATH")).toBe("DEFAULTED");
    expect(sourceOf(config, "MOE_PROJECT_ID")).toBe("DEFAULTED");
    expect(sourceOf(config, "MOE_DAEMON_CREDENTIAL")).toBe("MINTED");
  });

  it("serves the child overlay as exactly the four variables it owns", () => {
    const config = resolved({ ANTHROPIC_API_KEY: "sk-test" });
    expect(Object.keys(config.env).toSorted()).toEqual([
      "MOE_AGENT_COMMAND", "MOE_DAEMON_CREDENTIAL", "MOE_PROJECT_ID", "MOE_STORE_PATH",
    ]);
    expect(config.env["MOE_DAEMON_CREDENTIAL"]).toBe(config.credential);
    expect(config.env["MOE_STORE_PATH"]).toBe(config.storePath);
  });
});

describe("resolveLaunchEnv refusals", () => {
  it("refuses by naming ANTHROPIC_API_KEY exactly when the agent command is claude", () => {
    const result = refused({});
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.variable).toBe("ANTHROPIC_API_KEY");
    expect(result.refusals[0]?.code).toBe(MOE_UP_ENV_MISSING);
    expect(result.refusals[0]?.message).toBe(`${MOE_UP_ENV_MISSING}: ANTHROPIC_API_KEY`);
  });

  it("treats an empty ANTHROPIC_API_KEY as absent rather than as an auth secret", () => {
    expect(refused({ ANTHROPIC_API_KEY: "" }).refusals[0]?.variable).toBe("ANTHROPIC_API_KEY");
  });

  it("still refuses when MOE_AGENT_COMMAND names claude by absolute path or launcher suffix", () => {
    for (const command of ["claude", "C:\\tools\\claude.cmd", "/usr/local/bin/claude", "CLAUDE.EXE"]) {
      const result = refused({ MOE_AGENT_COMMAND: command });
      expect(result.refusals.map((entry) => entry.variable)).toEqual(["ANTHROPIC_API_KEY"]);
    }
  });

  it("needs no api key once MOE_AGENT_COMMAND names a non-claude command", () => {
    const config = resolved({ MOE_AGENT_COMMAND: "node" });
    expect(config.agentCommand).toBe("node");
    expect(config.env["MOE_AGENT_COMMAND"]).toBe("node");
  });

  it("defaults the agent command to claude and reports it as defaulted", () => {
    const config = resolved({ ANTHROPIC_API_KEY: "sk-test" });
    expect(config.agentCommand).toBe("claude");
    expect(sourceOf(config, "MOE_AGENT_COMMAND")).toBe("DEFAULTED");
  });
});

describe("resolveLaunchEnv determinism and disclosure", () => {
  it("returns an identical config for identical inputs and an injected random source", () => {
    const env = { ANTHROPIC_API_KEY: "sk-test", MOE_PROJECT_ID: "p" };
    expect(resolved(env)).toEqual(resolved(env));
  });

  it("never discloses the credential in full, minted or preset", () => {
    const minted = resolved({ ANTHROPIC_API_KEY: "sk-test" });
    const mintedLines = describeLaunchVariables(minted.variables).join("\n");
    expect(mintedLines).not.toContain(minted.credential);
    expect(mintedLines).toContain("MOE_DAEMON_CREDENTIAL");
    expect(mintedLines).toContain("minted");

    const preset = resolved({
      ANTHROPIC_API_KEY: "sk-test", MOE_DAEMON_CREDENTIAL: "preset-credential-value",
    });
    expect(describeLaunchVariables(preset.variables).join("\n"))
      .not.toContain("preset-credential-value");
  });

  it("discloses the non-secret values so the operator can see the dev store it opened", () => {
    const config = resolved({ ANTHROPIC_API_KEY: "sk-test" });
    expect(describeLaunchVariables(config.variables).join("\n")).toContain(config.storePath);
  });
});
