import { describe, expect, it } from "vitest";

import { agentEnvironment } from "./agent-spawn-environment.js";

/**
 * The forwarded set is an ALLOWLIST, so the codex cases below are paired with
 * strip cases in the same file. A suite that proved only the additions would
 * stay green after an allowlist-to-passlist flip, which is the one regression
 * this surface cannot afford: `agentEnvironment` is the boundary that keeps the
 * operator's store authority out of every spawned agent process.
 *
 * Measured 2026-08-20 against codex-cli 0.147.0 — these are the four names the
 * cli reads for auth. `CODEX_HOME` carries the ChatGPT subscription seat (the
 * cli's own `codex exec --help` says "auth still uses `CODEX_HOME`"), the other
 * three are the token and api-key arms.
 */
const CODEX_FORWARDED = [
  ["CODEX_HOME", "D:/fixture/.codex"],
  ["CODEX_ACCESS_TOKEN", "tok-fixture-codex-access"],
  ["OPENAI_API_KEY", "tok-fixture-openai"],
  ["CODEX_API_KEY", "tok-fixture-codex-api"],
] as const;

describe("agentEnvironment codex credentials", () => {
  for (const [name, value] of CODEX_FORWARDED) {
    it(`forwards ${name} to the spawned agent process`, () => {
      expect(agentEnvironment({ [name]: value })[name]).toBe(value);
    });
  }

  it("forwards the whole codex set at once and nothing else it was not given", () => {
    const environment = agentEnvironment(Object.fromEntries(CODEX_FORWARDED));
    // Pinned as the exact key set rather than four presence checks: an added
    // pass-through key has to be declared here before this case goes green.
    expect(Object.keys(environment).toSorted()).toEqual([
      "CLAUDE_CODE_SKIP_PROMPT_HISTORY", "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
      "CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "CODEX_HOME",
      "NO_PROXY", "OPENAI_API_KEY", "no_proxy",
    ]);
  });

  it("still strips an unlisted variable while forwarding the codex set beside it", () => {
    const environment = agentEnvironment({
      CODEX_HOME: "D:/fixture/.codex",
      GITHUB_TOKEN: "unrelated-secret-must-not-reach-agent",
      OPENAI_API_KEY: "tok-fixture-openai",
      OPERATOR_CREDENTIAL: "second-unrelated-secret",
    });
    expect(environment["CODEX_HOME"]).toBe("D:/fixture/.codex");
    expect(environment["GITHUB_TOKEN"]).toBeUndefined();
    expect(environment["OPERATOR_CREDENTIAL"]).toBeUndefined();
  });

  it("still strips MOE_ authority in either case alongside the codex set", () => {
    const environment = agentEnvironment({
      CODEX_ACCESS_TOKEN: "tok-fixture-codex-access",
      MOE_DAEMON_CREDENTIAL: "operator-secret-must-not-reach-agent",
      MOE_STORE_PATH: "D:/tmp/store.sqlite",
      moe_daemon_credential: "mixed-case-secret-must-not-reach-agent",
    });
    expect(environment["CODEX_ACCESS_TOKEN"]).toBe("tok-fixture-codex-access");
    expect(environment["MOE_DAEMON_CREDENTIAL"]).toBeUndefined();
    expect(environment["MOE_STORE_PATH"]).toBeUndefined();
    expect(environment["moe_daemon_credential"]).toBeUndefined();
  });

  it("keeps forwarding the provider prefixes it already carried before codex", () => {
    const environment = agentEnvironment({
      ANTHROPIC_API_KEY: "tok-fixture-anthropic",
      AWS_SECRET_ACCESS_KEY: "tok-fixture-aws",
      AZURE_CLIENT_SECRET: "tok-fixture-azure",
      GOOGLE_APPLICATION_CREDENTIALS: "D:/fixture/gcp.json",
      VERTEX_REGION: "us-east5",
    });
    expect(environment["ANTHROPIC_API_KEY"]).toBe("tok-fixture-anthropic");
    expect(environment["AWS_SECRET_ACCESS_KEY"]).toBe("tok-fixture-aws");
    expect(environment["AZURE_CLIENT_SECRET"]).toBe("tok-fixture-azure");
    expect(environment["GOOGLE_APPLICATION_CREDENTIALS"]).toBe("D:/fixture/gcp.json");
    expect(environment["VERTEX_REGION"]).toBe("us-east5");
  });
});
