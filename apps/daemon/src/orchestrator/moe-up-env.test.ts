import { describe, expect, it } from "vitest";

import {
  MOE_UP_ENV_MISSING,
  describeLaunchVariables,
  resolveLaunchEnv,
} from "./moe-up-env.js";
import type { LaunchEnvResolution, LaunchVariable } from "./moe-up-env.js";

const REPO_ROOT = "D:/repo";
const FOUNDATION_SEAL_KEYS = [
  "MOE_FOUNDATION_WORKSPACE_CATALOG",
  "MOE_PROJECT_CONFIGURATION_DIGEST",
  "MOE_VERIFICATION_CATALOG",
] as const;

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

/** Disclosure lines are joined with this before every value sweep. */
const LINE_BREAK = String.fromCharCode(10);

/** Obviously-fake fixture credentials: never a realistic sk-ant/oauth shape. */
const OAUTH_TOKEN = "tok-fixture-oauth";
const AUTH_TOKEN = "tok-fixture-auth";
const API_KEY = "tok-fixture-api";

/** The documented acceptance order: subscription first, api key last. */
const ACCEPTED_VARIABLES =
  "CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY";
const REFUSAL_MESSAGE = `${MOE_UP_ENV_MISSING}: ${ACCEPTED_VARIABLES}`
  + " (set one; run `claude setup-token` for a subscription token)";

/** Obviously-fake codex fixtures; CODEX_HOME is a path, never a real profile. */
const CODEX_HOME = "D:/fixture/.codex";
const CODEX_ACCESS_TOKEN = "tok-fixture-codex-access";
const OPENAI_API_KEY = "tok-fixture-openai";
const CODEX_API_KEY = "tok-fixture-codex-api";

/** The documented codex order: subscription seat first, api key last. */
const CODEX_ACCEPTED_VARIABLES =
  "CODEX_HOME, CODEX_ACCESS_TOKEN, OPENAI_API_KEY, CODEX_API_KEY";
const CODEX_REFUSAL_MESSAGE = `${MOE_UP_ENV_MISSING}: ${CODEX_ACCEPTED_VARIABLES}`
  + " (set one; run `codex login` once, then export CODEX_HOME so the seat travels)";

const entryOf = (
  config: Extract<LaunchEnvResolution, { ok: true }>,
  name: string,
): LaunchVariable | undefined => config.variables.find((entry) => entry.name === name);

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

  it("serves the child overlay as the four variables it owns plus the credential it accepted", () => {
    const config = resolved({ ANTHROPIC_API_KEY: "sk-test" });
    expect(Object.keys(config.env).toSorted()).toEqual([
      "ANTHROPIC_API_KEY",
      "MOE_AGENT_COMMAND", "MOE_DAEMON_CREDENTIAL", "MOE_PROJECT_ID", "MOE_STORE_PATH",
    ]);
    expect(config.env["MOE_DAEMON_CREDENTIAL"]).toBe(config.credential);
    expect(config.env["MOE_STORE_PATH"]).toBe(config.storePath);
  });
});

describe("resolveLaunchEnv foundation seal passthrough", () => {
  it("carries preset seal inputs verbatim and reports their preset provenance", () => {
    const presets = {
      MOE_FOUNDATION_WORKSPACE_CATALOG: "workspace-catalog-fixture",
      MOE_PROJECT_CONFIGURATION_DIGEST: "not-a-hex64-digest",
      MOE_VERIFICATION_CATALOG: "verification-catalog-fixture",
    } as const;
    const config = resolved({ ANTHROPIC_API_KEY: "sk-test", ...presets });

    expect(FOUNDATION_SEAL_KEYS).toHaveLength(3);
    for (const name of FOUNDATION_SEAL_KEYS) {
      expect(config.env[name]).toBe(presets[name]);
      expect(sourceOf(config, name)).toBe("PRESET");
    }
  });

  it.each([undefined, ""])(
    "omits seal inputs whose preset value is %s",
    (value) => {
      const config = resolved({
        ANTHROPIC_API_KEY: "sk-test",
        MOE_FOUNDATION_WORKSPACE_CATALOG: value,
        MOE_PROJECT_CONFIGURATION_DIGEST: value,
        MOE_VERIFICATION_CATALOG: value,
      });
      const description = describeLaunchVariables(config.variables).join(LINE_BREAK);

      for (const name of FOUNDATION_SEAL_KEYS) {
        expect(config.env).not.toHaveProperty(name);
        expect(entryOf(config, name)).toBeUndefined();
        expect(description).not.toContain(name);
      }
    },
  );

  it("describes only the seal inputs that have non-empty presets", () => {
    const config = resolved({
      ANTHROPIC_API_KEY: "sk-test",
      MOE_FOUNDATION_WORKSPACE_CATALOG: "workspace-catalog-fixture",
      MOE_PROJECT_CONFIGURATION_DIGEST: "",
    });
    const sealLines = describeLaunchVariables(config.variables).filter((line) =>
      FOUNDATION_SEAL_KEYS.some((name) => line.includes(name)));

    expect(sealLines).toEqual([
      "  MOE_FOUNDATION_WORKSPACE_CATALOG=workspace-catalog-fixture (preset)",
    ]);
  });

  it("does not validate or hide a preset project configuration digest", () => {
    const digest = "operator-owned-non-hex-digest";
    const config = resolved({
      ANTHROPIC_API_KEY: "sk-test",
      MOE_PROJECT_CONFIGURATION_DIGEST: digest,
    });
    const entry = entryOf(config, "MOE_PROJECT_CONFIGURATION_DIGEST");

    expect(entry).toMatchObject({ secret: false, source: "PRESET", value: digest });
    expect(describeLaunchVariables(config.variables).join(LINE_BREAK)).toContain(digest);
  });
});

describe("resolveLaunchEnv refusals", () => {
  it("refuses by naming every accepted credential exactly when the agent command is claude", () => {
    const result = refused({});
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.code).toBe(MOE_UP_ENV_MISSING);
    expect(result.refusals[0]?.variable).toBe(ACCEPTED_VARIABLES);
    // Hand-written here rather than rebuilt from the roster: an operator reads
    // this one line and nothing else, so all three names plus the subscription
    // hint ARE the contract, not an implementation detail of the message.
    expect(result.refusals[0]?.message).toBe(REFUSAL_MESSAGE);
  });

  it("treats an empty value as absent for every accepted credential", () => {
    const result = refused({
      ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "",
    });
    expect(result.refusals[0]?.message).toBe(REFUSAL_MESSAGE);
  });

  it("still refuses when MOE_AGENT_COMMAND names claude by absolute path or launcher suffix", () => {
    for (const command of ["claude", "C:\\tools\\claude.cmd", "/usr/local/bin/claude", "CLAUDE.EXE"]) {
      const result = refused({ MOE_AGENT_COMMAND: command });
      expect(result.refusals.map((entry) => entry.variable)).toEqual([ACCEPTED_VARIABLES]);
    }
  });

  it("needs no credential at all once MOE_AGENT_COMMAND names a non-claude command", () => {
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

describe("resolveLaunchEnv credential acceptance", () => {
  const acceptedAlone = [
    ["CLAUDE_CODE_OAUTH_TOKEN", OAUTH_TOKEN],
    ["ANTHROPIC_AUTH_TOKEN", AUTH_TOKEN],
    ["ANTHROPIC_API_KEY", API_KEY],
  ] as const;

  for (const [name, value] of acceptedAlone) {
    it(`accepts ${name} alone and reports it by name as a hidden preset`, () => {
      const config = resolved({ [name]: value });
      const entry = entryOf(config, name);
      expect(entry?.source).toBe("PRESET");
      expect(entry?.secret).toBe(true);
      expect(describeLaunchVariables(config.variables).join(LINE_BREAK))
        .toContain(`${name}=<preset, hidden>`);
    });
  }

  it("delivers a subscription token to the children under the name the cli honors", () => {
    // claude 2.1.235 IGNORES CLAUDE_CODE_OAUTH_TOKEN under --bare (measured
    // twice, comments 0e000104 / c32ccd4d), so accepting it without mapping it
    // would spawn children that cannot authenticate — a false acceptance is
    // worse than the false refusal this task removes.
    const config = resolved({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN });
    expect(config.env["ANTHROPIC_AUTH_TOKEN"]).toBe(OAUTH_TOKEN);
    const minted = entryOf(config, "ANTHROPIC_AUTH_TOKEN");
    expect(minted?.source).toBe("MINTED");
    expect(minted?.secret).toBe(true);
    const lines = describeLaunchVariables(config.variables).join(LINE_BREAK);
    expect(lines).toContain("ANTHROPIC_AUTH_TOKEN=<minted, hidden>");
    expect(lines).not.toContain(OAUTH_TOKEN);
  });

  it("never shadows an operator-supplied ANTHROPIC_AUTH_TOKEN with the alias value", () => {
    const config = resolved({
      ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
    });
    // The overlay WINS over the parent env where moe-up-main merges the two, so
    // the operator's own token survives exactly while the launcher contributes
    // nothing under that name. Absence here IS the no-overwrite guarantee.
    expect(config.env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
    expect(entryOf(config, "ANTHROPIC_AUTH_TOKEN")).toBeUndefined();
  });

  it("reports the first variable in the documented presence order when all three are set", () => {
    const config = resolved({
      ANTHROPIC_API_KEY: API_KEY,
      ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN,
      CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
    });
    // PRESENCE order at the gate. This is NOT a claim about how claude itself
    // resolves auth between several credentials it can see.
    expect(entryOf(config, "CLAUDE_CODE_OAUTH_TOKEN")?.source).toBe("PRESET");
    expect(entryOf(config, "ANTHROPIC_AUTH_TOKEN")).toBeUndefined();
    expect(entryOf(config, "ANTHROPIC_API_KEY")).toBeUndefined();
  });

  it("prints no credential value on any disclosure or refusal line", () => {
    const all = resolved({
      ANTHROPIC_API_KEY: API_KEY,
      ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN,
      CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
    });
    const mapped = resolved({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN });
    const lines = [
      ...describeLaunchVariables(all.variables),
      ...describeLaunchVariables(mapped.variables),
      ...refused({}).refusals.map((entry) => entry.message),
    ];
    // A sweep over zero lines passes without asserting anything, so the line
    // count is pinned before the values are looked for.
    expect(lines.length).toBeGreaterThan(8);
    const joined = lines.join(LINE_BREAK);
    for (const value of [API_KEY, AUTH_TOKEN, OAUTH_TOKEN]) {
      expect(joined).not.toContain(value);
    }
  });
});

describe("resolveLaunchEnv codex credential acceptance", () => {
  const acceptedAlone = [
    ["CODEX_HOME", CODEX_HOME],
    ["CODEX_ACCESS_TOKEN", CODEX_ACCESS_TOKEN],
    ["OPENAI_API_KEY", OPENAI_API_KEY],
    ["CODEX_API_KEY", CODEX_API_KEY],
  ] as const;

  for (const [name, value] of acceptedAlone) {
    it(`accepts ${name} alone under a codex agent command and reports it as a hidden preset`, () => {
      const config = resolved({ MOE_AGENT_COMMAND: "codex", [name]: value });
      const entry = entryOf(config, name);
      expect(entry?.source).toBe("PRESET");
      expect(entry?.secret).toBe(true);
      // The overlay carries it to the children: the gate entry IS the delivery.
      expect(config.env[name]).toBe(value);
      expect(describeLaunchVariables(config.variables).join(LINE_BREAK))
        .toContain(`${name}=<preset, hidden>`);
    });
  }

  it("refuses by naming every accepted codex credential exactly when the agent command is codex", () => {
    const result = refused({ MOE_AGENT_COMMAND: "codex" });
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.code).toBe(MOE_UP_ENV_MISSING);
    expect(result.refusals[0]?.variable).toBe(CODEX_ACCEPTED_VARIABLES);
    // Hand-written, like the claude line above: all four names plus the seat
    // hint ARE the contract an operator reads, not a detail of the roster.
    expect(result.refusals[0]?.message).toBe(CODEX_REFUSAL_MESSAGE);
  });

  it("treats an empty value as absent for every accepted codex credential", () => {
    const result = refused({
      CODEX_ACCESS_TOKEN: "", CODEX_API_KEY: "", CODEX_HOME: "",
      MOE_AGENT_COMMAND: "codex", OPENAI_API_KEY: "",
    });
    expect(result.refusals[0]?.message).toBe(CODEX_REFUSAL_MESSAGE);
  });

  it("still refuses when MOE_AGENT_COMMAND names codex by absolute path or launcher suffix", () => {
    for (const command of ["codex", "C:\\tools\\codex.cmd", "/usr/local/bin/codex", "CODEX.EXE"]) {
      const result = refused({ MOE_AGENT_COMMAND: command });
      expect(result.refusals.map((entry) => entry.variable)).toEqual([CODEX_ACCEPTED_VARIABLES]);
    }
  });

  it("reports the first variable in the documented presence order when all four are set", () => {
    const config = resolved({
      CODEX_ACCESS_TOKEN, CODEX_API_KEY, CODEX_HOME,
      MOE_AGENT_COMMAND: "codex", OPENAI_API_KEY,
    });
    // PRESENCE order at the gate, NOT a claim about how codex itself resolves
    // auth when it can see several credentials at once.
    expect(entryOf(config, "CODEX_HOME")?.source).toBe("PRESET");
    for (const name of ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"]) {
      expect(entryOf(config, name)).toBeUndefined();
    }
  });

  it("prints no codex credential value on any disclosure or refusal line", () => {
    const all = resolved({
      CODEX_ACCESS_TOKEN, CODEX_API_KEY, CODEX_HOME,
      MOE_AGENT_COMMAND: "codex", OPENAI_API_KEY,
    });
    const lines = [
      ...describeLaunchVariables(all.variables),
      ...describeLaunchVariables(resolved({ MOE_AGENT_COMMAND: "codex", OPENAI_API_KEY }).variables),
      ...refused({ MOE_AGENT_COMMAND: "codex" }).refusals.map((entry) => entry.message),
    ];
    // A sweep over zero lines passes without asserting anything, so the line
    // count is pinned before the values are looked for.
    expect(lines.length).toBeGreaterThan(8);
    const joined = lines.join(LINE_BREAK);
    for (const value of [CODEX_ACCESS_TOKEN, CODEX_API_KEY, CODEX_HOME, OPENAI_API_KEY]) {
      expect(joined).not.toContain(value);
    }
  });
});

describe("resolveLaunchEnv keeps the two provider gates apart", () => {
  it("refuses a codex command holding only claude credentials, naming the codex set", () => {
    const result = refused({
      ANTHROPIC_API_KEY: API_KEY, ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN,
      CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN, MOE_AGENT_COMMAND: "codex",
    });
    expect(result.refusals[0]?.variable).toBe(CODEX_ACCEPTED_VARIABLES);
  });

  it("refuses a claude command holding only codex credentials, naming the claude set", () => {
    const result = refused({
      CODEX_ACCESS_TOKEN, CODEX_API_KEY, CODEX_HOME, OPENAI_API_KEY,
    });
    expect(result.refusals[0]?.variable).toBe(ACCEPTED_VARIABLES);
  });

  it("hands a codex seat no claude variable and a claude token no codex variable", () => {
    const codex = resolved({ CODEX_HOME, MOE_AGENT_COMMAND: "codex" });
    expect(Object.keys(codex.env).toSorted()).toEqual([
      "CODEX_HOME",
      "MOE_AGENT_COMMAND", "MOE_DAEMON_CREDENTIAL", "MOE_PROJECT_ID", "MOE_STORE_PATH",
    ]);
    const claude = resolved({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN });
    expect(Object.keys(claude.env).toSorted()).toEqual([
      "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
      "MOE_AGENT_COMMAND", "MOE_DAEMON_CREDENTIAL", "MOE_PROJECT_ID", "MOE_STORE_PATH",
    ]);
  });

  it("leaves a command that is neither claude nor codex ungated", () => {
    const config = resolved({ MOE_AGENT_COMMAND: "node" });
    expect(config.agentCommand).toBe("node");
    expect(Object.keys(config.env).toSorted()).toEqual([
      "MOE_AGENT_COMMAND", "MOE_DAEMON_CREDENTIAL", "MOE_PROJECT_ID", "MOE_STORE_PATH",
    ]);
  });
});
