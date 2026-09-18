import { describe, expect, it } from "vitest";

import {
  RECIPE_VERDICT_LINE_CHARS, RECIPE_VERDICT_LINE_LIMIT, RECIPE_VERDICT_LINES_MAX_ENCODED_UNITS, recipeVerdictLines,
} from "./verifier-recipe-verdict-lines.js";

/**
 * What a failed recipe may say back to the seat and the operator: the runner's verdict lines,
 * never a delivered value. Every arm here is a negative the module header promises, plus the
 * one positive that made the module necessary — a failing test is NAMED. The window arms sweep
 * EVERY offset, because the first cut of this module scanned at 8-character steps and its one
 * arm happened to pick an aligned offset (review of ed62c143).
 */

const PASSWORD = "3f0c9a7b2e1d4c5b6a7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d2c3b4a5f6e7d8c9b";
const URL = `postgresql://postgres:${PASSWORD}@127.0.0.1:41234/postgres`;
const CA_PATH = "C:\\Users\\Yaron\\AppData\\Local\\Temp\\moe-verifier-ca-abc123\\ca.crt";
const SECRETS = [PASSWORD, URL, CA_PATH];

const VITEST_FAILURE = [
  "",
  " RUN  v4.1.10 D:/projexts/UnAI",
  "",
  " ✓ packages/api/src/evidence.test.ts (12 tests) 340ms",
  " ❯ packages/api/src/ops.test.ts (3 tests | 1 failed) 812ms",
  "   × publishes the current registry release 41ms",
  "     → expected 1 to be 2 // Object.is equality",
  "",
  "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
  "",
  " FAIL  packages/api/src/ops.test.ts > ops > publishes the current registry release",
  "AssertionError: expected 1 to be 2 // Object.is equality",
  "",
  "- Expected",
  "+ Received",
  "",
  "- 2",
  "+ 1",
  "",
  " ❯ packages/api/src/ops.test.ts:88:31",
  "",
  " Test Files  1 failed | 52 passed (53)",
  "      Tests  1 failed | 501 passed (502)",
  "   Start at  17:47:52",
  "   Duration  61.20s",
  "",
  " ELIFECYCLE  Test failed. See above for more details.",
].join("\n");

describe("recipeVerdictLines", () => {
  it("names the failing test and its assertion, and keeps the closing counts", () => {
    const lines = recipeVerdictLines(VITEST_FAILURE, SECRETS);
    expect(lines).toContain("× publishes the current registry release 41ms");
    expect(lines).toContain("FAIL  packages/api/src/ops.test.ts > ops > publishes the current registry release");
    expect(lines).toContain("AssertionError: expected 1 to be 2 // Object.is equality");
    expect(lines).toContain("- Expected");
    expect(lines).toContain("Test Files  1 failed | 52 passed (53)");
    expect(lines).toContain("Tests  1 failed | 501 passed (502)");
    expect(lines).toContain("ELIFECYCLE  Test failed. See above for more details.");
    // Passing files, the banner and timings are not verdicts.
    expect(lines.join("\n")).not.toContain("evidence.test.ts");
    expect(lines.join("\n")).not.toContain("Duration");
  });

  it("answers nothing for a run that printed no verdict line", () => {
    expect(recipeVerdictLines("", SECRETS)).toEqual([]);
    expect(recipeVerdictLines("all good\nmigration done\n", SECRETS)).toEqual([]);
  });

  it("refuses by SHAPE every line that could carry a delivered value, before reading its content", () => {
    const output = [
      "Error: connect ECONNREFUSED 127.0.0.1:41234",
      `Error: DATABASE_URL was ${URL}`,
      "Error: password authentication failed for user postgres",
      "AssertionError: expected UNAI_MIGRATION_DATABASE_URL to be defined",
      "Error: no pg_hba.conf entry, see ca.crt",
      "Error: -----BEGIN CERTIFICATE----- was not parseable",
      "Error: Bearer sk-live-000 rejected",
      "Error: the api_key header is missing",
      // A slash inside the userinfo used to slip past the URL shape (review of ed62c143).
      "Error: pg://po/st:hunter2@127.0.0.1:41234/app refused",
      "Error: PGCONNSTRING=jdbc:postgresql://x:y@h/db was rejected",
    ].join("\n");
    expect(recipeVerdictLines(output, SECRETS)).toEqual(["Error: connect ECONNREFUSED 127.0.0.1:41234"]);
  });

  it("redacts a delivered secret that reaches a verdict line whole, in any letter case", () => {
    expect(recipeVerdictLines(`AssertionError: expected "${PASSWORD}" to be a hash`, SECRETS))
      .toEqual(['AssertionError: expected "***" to be a hash']);
    expect(recipeVerdictLines(`Error: got ${PASSWORD.toUpperCase()} instead`, SECRETS)).toEqual(["Error: got *** instead"]);
    expect(recipeVerdictLines(`Error: cannot read ${CA_PATH.toLowerCase()}`, SECRETS)).toEqual([]);
    // A short secret (under the window floor) is still redacted whole.
    expect(recipeVerdictLines("Error: s3cr3t rejected", ["s3cr3t"])).toEqual(["Error: *** rejected"]);
  });

  it("drops a line holding ANY sixteen-character window of a long secret, at every offset", () => {
    // Every offset and every length from the window up to the whole secret: a truncated or
    // wrapped line shows an arbitrary offset, never a convenient aligned one.
    let probed = 0;
    for (let length = 16; length <= PASSWORD.length; length += 1) {
      for (let at = 0; at + length <= PASSWORD.length; at += 1) {
        const piece = PASSWORD.slice(at, at + length);
        const line = at % 2 === 0 ? `Error: cannot bind ${piece}` : `× keyed by ${piece.toUpperCase()} 3ms`;
        const out = recipeVerdictLines(line, SECRETS);
        // The whole secret is said as "***"; anything shorter must not be said at all.
        if (out.some((said) => said.toLowerCase().includes(piece.toLowerCase()))) throw new Error(`leaked ${String(length)} chars at offset ${String(at)}: ${out.join(" | ")}`);
        probed += 1;
      }
    }
    expect(probed).toBeGreaterThan(1_000);
    // Fifteen characters on ONE line are under the window and are said; the budget below is what
    // stops fifteen characters per line over five lines.
    expect(recipeVerdictLines(`Error: cannot bind ${PASSWORD.slice(5, 20)}`, SECRETS)).toEqual([`Error: cannot bind ${PASSWORD.slice(5, 20)}`]);
  });

  it("charges every kept line against one budget per secret, so a secret chunked across lines cannot be reconstructed", () => {
    // Review of aa60eb44: five verdict lines of thirteen characters each passed the per-line
    // window and concatenated to the password exactly.
    for (const chunk of [15, 13, 10, 8, 6, 4]) {
      const lines: string[] = [];
      for (let at = 0; at < PASSWORD.length; at += chunk) lines.push(`Error: ${PASSWORD.slice(at, at + chunk)}`);
      const out = recipeVerdictLines(lines.join("\n"), SECRETS);
      const together = out.join("").toLowerCase();
      // Fewer than sixteen characters of the password, in total, over every line said.
      let covered = 0;
      for (let at = 0; at + 4 <= PASSWORD.length; at += 1) if (together.includes(PASSWORD.slice(at, at + 4))) covered += 1;
      if (covered + 3 >= 16) throw new Error(`chunk ${String(chunk)}: ${String(covered + 3)} characters said across ${String(out.length)} lines: ${out.join(" | ")}`);
      expect(out.length).toBeLessThan(lines.length);
    }
    // The boundary, pinned rather than discovered: runs shorter than BUDGET_RUN (4) are charged
    // nothing, so three-character chunks are all said (twelve lines, thirty-four characters).
    // That is a deliberate exfiltration shape, outside reach by design (module header).
    const three: string[] = [];
    for (let at = 0; at < PASSWORD.length; at += 3) three.push(`Error: ${PASSWORD.slice(at, at + 3)}`);
    const said = recipeVerdictLines(three.join(String.fromCharCode(10)), SECRETS);
    expect(said).toHaveLength(RECIPE_VERDICT_LINE_LIMIT);
    expect(said.map((line) => line.slice("Error: ".length)).join("")).toBe(PASSWORD.slice(30));
    // Ordinary verdict lines that share no run with a secret are not charged and all survive.
    const plain = Array.from({ length: 12 }, (_, index) => `× case ${String(index)} failed 3ms`).join("\n");
    expect(recipeVerdictLines(plain, SECRETS)).toHaveLength(12);
  });

  it("matches a delivered value that carries a control byte, in both spellings", () => {
    const value = `AAAAAAAA${String.fromCharCode(27)}BBBBBBBB`;
    expect(recipeVerdictLines("Error: carries AAAAAAAABBBBBBBB here", [value])).toEqual(["Error: carries *** here"]);
    expect(recipeVerdictLines(`Error: carries ${value} here`, [value])).toEqual(["Error: carries *** here"]);
  });

  it("strips invisible format characters so they cannot split a window or reorder the operator's card", () => {
    const softHyphen = String.fromCharCode(0xad);
    expect(recipeVerdictLines(`Error: bind ${PASSWORD.slice(3, 13)}${softHyphen}${PASSWORD.slice(13, 23)}`, SECRETS)).toEqual([]);
    const rtl = String.fromCharCode(0x202e);
    expect(recipeVerdictLines(`Error: ${rtl}elif/a/ under test`, [])).toEqual(["Error: elif/a/ under test"]);
    const zwj = String.fromCharCode(0x200d);
    expect(recipeVerdictLines(`Error: ${PASSWORD.slice(0, 8)}${zwj}${PASSWORD.slice(8, 16)} bound`, SECRETS)).toEqual([]);
  });

  it("returns only well-formed lines, even when the cut lands inside a surrogate pair", () => {
    const astral = String.fromCodePoint(0x1f525);
    const line = `Error: ${astral.repeat(RECIPE_VERDICT_LINE_CHARS)}`;
    const out = recipeVerdictLines(line, []);
    expect(out).toHaveLength(1);
    expect(out[0]?.isWellFormed()).toBe(true);
    expect(out[0]?.length).toBeLessThanOrEqual(RECIPE_VERDICT_LINE_CHARS + 1);
  });

  it("scans a shorter delivered secret with a proportionate window, so an operator's key cannot leak by halves", () => {
    const key = "sk_live_abcd1234def0";                      // 20 chars: window 10
    for (let at = 0; at + 10 <= key.length; at += 1) {
      expect(recipeVerdictLines(`Error: key ${key.slice(at, at + 10)} rejected`, [key])).toEqual([]);
    }
    expect(recipeVerdictLines("Error: key sk_live_ab rejected", [key])).toEqual([]);
    expect(recipeVerdictLines("Error: key sk_live_a rejected", [key])).toEqual(["Error: key sk_live_a rejected"]);
    const tiny = "abcdefgh";                                  // 8 chars: window 8 = whole only
    expect(recipeVerdictLines("Error: abcdefgh", [tiny])).toEqual(["Error: ***"]);
    expect(recipeVerdictLines("Error: bcdefgh", [tiny])).toEqual(["Error: bcdefgh"]);
  });

  it("drops a line naming the CA path in any spelling, and a window of it", () => {
    expect(recipeVerdictLines(`Error: ENOENT ${CA_PATH}`, SECRETS)).toEqual([]);
    expect(recipeVerdictLines(`Error: ENOENT ${CA_PATH.replaceAll("\\", "/")}`, SECRETS).join("")).not.toContain("moe-verifier-ca-abc123");
    expect(recipeVerdictLines("Error: ENOENT Temp\\moe-verifier-ca-abc123", SECRETS)).toEqual([]);
  });

  it("strips CSI colour, OSC hyperlinks and every other control byte so a coloured × still counts and nothing escapes", () => {
    const coloured = "\u001b[31m   × \u001b[39mcanonicalises the frame \u001b[2m12ms\u001b[22m";
    expect(recipeVerdictLines(coloured, [])).toEqual(["× canonicalises the frame 12ms"]);
    const linked = "Error: see \u001b]8;;file:///d/x\u0007link\u001b]8;;\u0007 for detail";
    expect(recipeVerdictLines(linked, [])).toEqual(["Error: see link for detail"]);
    const noisy = "Error: \u0007\b\u001b[2Jcleared\tscreen";
    expect(recipeVerdictLines(noisy, [])).toEqual(["Error: cleared\tscreen"]);
    for (const line of recipeVerdictLines(`${coloured}\n${linked}\n${noisy}`, [])) {
      expect(line).not.toMatch(/[\u0000-\u0008\u000a-\u001f\u007f]/u);
    }
  });

  it("keeps at most the LAST twelve verdict lines, each cut at two hundred characters", () => {
    const many = Array.from({ length: 30 }, (_, index) => `× test ${String(index)} ${"x".repeat(300)}`).join("\n");
    const lines = recipeVerdictLines(many, []);
    expect(lines).toHaveLength(RECIPE_VERDICT_LINE_LIMIT);
    expect(lines[0]?.startsWith("× test 18 ")).toBe(true);
    expect(lines[RECIPE_VERDICT_LINE_LIMIT - 1]?.startsWith("× test 29 ")).toBe(true);
    for (const line of lines) expect(line.length).toBe(RECIPE_VERDICT_LINE_CHARS + 1);
    expect(RECIPE_VERDICT_LINE_LIMIT).toBe(12);
    expect(RECIPE_VERDICT_LINE_CHARS).toBe(200);
  });

  it("states an encoded-size bound that the worst JSON escaping cannot exceed", () => {
    // Twelve lines of 200 backslashes each double under JSON.stringify: the pathological case
    // the finding tail must still hold whole (review of ed62c143).
    const worst = Array.from({ length: RECIPE_VERDICT_LINE_LIMIT }, () => `Error: ${"\\".repeat(RECIPE_VERDICT_LINE_CHARS)}`).join("\n");
    const lines = recipeVerdictLines(worst, []);
    const encoded = JSON.stringify({ migrations: "PASSED", recipeExitCode: 1, recipeVerdictLines: lines });
    expect(lines).toHaveLength(RECIPE_VERDICT_LINE_LIMIT);
    expect(encoded.length).toBeLessThanOrEqual(RECIPE_VERDICT_LINES_MAX_ENCODED_UNITS);
    const quotes = Array.from({ length: RECIPE_VERDICT_LINE_LIMIT }, () => `Error: ${"\"".repeat(RECIPE_VERDICT_LINE_CHARS)}`).join("\n");
    expect(JSON.stringify({ migrations: "PASSED", recipeExitCode: 1, recipeVerdictLines: recipeVerdictLines(quotes, []) }).length)
      .toBeLessThanOrEqual(RECIPE_VERDICT_LINES_MAX_ENCODED_UNITS);
  });
});
