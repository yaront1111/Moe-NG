import { describe, expect, it } from "vitest";

import { REDACTED, credentialValues, scrubSecrets } from "./credential-scrub.js";

/**
 * The scrub list is the answer to "which credential VALUES does this process hold", which is
 * a different question from the launcher's "which ONE entry do the children get". Every arm
 * below sets MORE than the launcher would select, because that is exactly what the old list
 * missed (activation-read.test.ts pins the wire-level symptom).
 */
const CLAUDE_OAUTH = "sk-ant-oat-CANARY-oauth-1111111111";
const CLAUDE_AUTH = "sk-ant-aut-CANARY-auth-2222222222";
const CLAUDE_KEY = "sk-ant-api-CANARY-key-3333333333";
const CODEX_TOKEN = "codex-CANARY-token-4444444444";
const OPENAI_KEY = "sk-proj-CANARY-openai-5555555555";
const CODEX_KEY = "sk-codex-CANARY-key-6666666666";

describe("credentialValues", () => {
  it("unions every present roster name of EVERY provider, whatever command is configured", () => {
    const values = credentialValues({
      ANTHROPIC_API_KEY: CLAUDE_KEY, ANTHROPIC_AUTH_TOKEN: CLAUDE_AUTH,
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_OAUTH, CODEX_ACCESS_TOKEN: CODEX_TOKEN,
      CODEX_API_KEY: CODEX_KEY, CODEX_HOME: "D:/seats/.codex", OPENAI_API_KEY: OPENAI_KEY,
    });
    // Seven names, seven values: NOT the one entry `providerCredentials` stops at.
    expect([...values].sort()).toEqual([
      CLAUDE_AUTH, CLAUDE_KEY, CLAUDE_OAUTH, CODEX_KEY, CODEX_TOKEN, "D:/seats/.codex", OPENAI_KEY,
    ].sort());
  });

  it("lists a lone second-place claude name and the codex names beside it", () => {
    // The exact configuration the first-match list left unscrubbed: no CLAUDE_CODE_OAUTH_TOKEN,
    // so the launcher would select ANTHROPIC_AUTH_TOKEN and never look at the api key.
    expect([...credentialValues({ ANTHROPIC_API_KEY: CLAUDE_KEY, ANTHROPIC_AUTH_TOKEN: CLAUDE_AUTH })].sort())
      .toEqual([CLAUDE_AUTH, CLAUDE_KEY].sort());
    expect([...credentialValues({ ANTHROPIC_AUTH_TOKEN: CLAUDE_AUTH, OPENAI_API_KEY: OPENAI_KEY })].sort())
      .toEqual([CLAUDE_AUTH, OPENAI_KEY].sort());
  });

  it("drops absent and empty values and deduplicates one value set under two names", () => {
    expect(credentialValues({})).toEqual([]);
    expect(credentialValues({ ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: undefined })).toEqual([]);
    // The launcher MINTS ANTHROPIC_AUTH_TOKEN from the oauth alias, so both names hold one value.
    expect(credentialValues({ ANTHROPIC_AUTH_TOKEN: CLAUDE_OAUTH, CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_OAUTH }))
      .toEqual([CLAUDE_OAUTH]);
  });

  it("orders longest first, so a value contained in a longer one is never replaced first", () => {
    const short = "sk-ant-CANARY";
    const long = `${short}-with-a-longer-suffix`;
    expect(credentialValues({ ANTHROPIC_API_KEY: short, OPENAI_API_KEY: long })).toEqual([long, short]);
    expect(credentialValues({ ANTHROPIC_API_KEY: long, OPENAI_API_KEY: short })).toEqual([long, short]);
  });

  it("lists only the rosters' own names: the sign-in directory and daemon variables are not credentials here", () => {
    // CLAUDE_CONFIG_DIR is the launcher's NON-secret disclosure (`secret: false` in
    // `providerCredentials`), and MOE_* never reaches a seat's environment at all.
    expect(credentialValues({
      CLAUDE_CONFIG_DIR: "D:/seats/.claude", MOE_DAEMON_CREDENTIAL: "operator-secret", PATH: "C:/bin",
    })).toEqual([]);
  });
});

describe("scrubSecrets", () => {
  it("replaces every occurrence of every secret with the marker", () => {
    expect(scrubSecrets(`fatal: env A=${CLAUDE_AUTH} B=${OPENAI_KEY} again ${CLAUDE_AUTH}`, [CLAUDE_AUTH, OPENAI_KEY]))
      .toBe(`fatal: env A=${REDACTED} B=${REDACTED} again ${REDACTED}`);
    expect(REDACTED).toBe("[redacted]");
  });

  it("leaves text without a secret byte-identical, and an empty or blank list is a no-op", () => {
    const text = "Error: spawn claude ENOENT";
    expect(scrubSecrets(text, [CLAUDE_AUTH])).toBe(text);
    expect(scrubSecrets(text, [])).toBe(text);
    // An empty secret would match everywhere and turn the text into markers.
    expect(scrubSecrets(text, [""])).toBe(text);
  });

  it("scrubs the whole of an overlapping pair whatever order the caller lists them in", () => {
    const short = "sk-ant-CANARY";
    const long = `${short}-with-a-longer-suffix`;
    expect(scrubSecrets(`token ${long} end`, [short, long])).toBe(`token ${REDACTED} end`);
    expect(scrubSecrets(`token ${long} end`, [long, short])).toBe(`token ${REDACTED} end`);
  });
});
