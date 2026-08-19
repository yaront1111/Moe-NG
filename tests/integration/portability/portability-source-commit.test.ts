/**
 * The pin resolver's own suite.
 *
 * Every refusal here asserts the STABLE CODE, never "it threw" -- a bare
 * throw-assertion would stay green if a second guard started answering first.
 * The last describe block drives the PRODUCTION surface (real environment, real
 * committed receipt) rather than the injected-input function, because a suite
 * that only ever drives the pure resolver proves nothing about what production
 * actually feeds it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PORTABILITY_SOURCE_COMMIT, SOURCE_COMMIT_CODES, SOURCE_COMMIT_ENV, SOURCE_COMMIT_PIN_FILE,
  readPinBytes, readPortabilitySourceCommit, resolvePortabilitySourceCommit, resolveSourceCommit,
} from "./portability-source-commit.js";

const SHA_A = "a1f71a43c71cd03367a90baf52d99d814042dbe7";
const SHA_B = "d543f71ea380d46a3f801178b4821c4bc0abe9b7";
/** An UNSEALED receipt: no external run has been accepted at this commit yet. */
const pin = (sourceCommit: unknown): string => JSON.stringify({ externalRun: null, sourceCommit });
/** A SEALED receipt: exact-sha-evidence-gate.mjs accepted a push run here. */
const sealedPin = (sourceCommit: unknown): string =>
  JSON.stringify({ externalRun: { runId: 32312669884 }, sourceCommit });

describe("portability source-commit resolution — acceptance", () => {
  it("binds from the pin receipt alone and names PIN", () => {
    const outcome = resolveSourceCommit({ env: undefined, pinBytes: pin(SHA_A) });
    expect(outcome).toEqual({ boundBy: "PIN", ok: true, sourceCommit: SHA_A });
  });

  it("binds from the environment alone and names ENV", () => {
    const outcome = resolveSourceCommit({ env: SHA_B, pinBytes: undefined });
    expect(outcome).toEqual({ boundBy: "ENV", ok: true, sourceCommit: SHA_B });
  });

  it("binds when both agree and names PIN_AND_ENV", () => {
    const outcome = resolveSourceCommit({ env: SHA_A, pinBytes: pin(SHA_A) });
    expect(outcome).toEqual({ boundBy: "PIN_AND_ENV", ok: true, sourceCommit: SHA_A });
  });

  it("treats a blank environment value as unset rather than malformed", () => {
    expect(resolveSourceCommit({ env: "   ", pinBytes: pin(SHA_A) })).toEqual({
      boundBy: "PIN", ok: true, sourceCommit: SHA_A,
    });
  });

  it("treats a receipt whose sourceCommit is null as an absent pin", () => {
    expect(resolveSourceCommit({ env: SHA_B, pinBytes: pin(null) })).toEqual({
      boundBy: "ENV", ok: true, sourceCommit: SHA_B,
    });
  });
});

describe("portability source-commit resolution — refusals name their code", () => {
  it("refuses ABSENT when neither input supplies a commit", () => {
    expect(resolveSourceCommit({ env: undefined, pinBytes: undefined })).toEqual({
      code: SOURCE_COMMIT_CODES.absent, ok: false,
    });
    expect(SOURCE_COMMIT_CODES.absent).toBe("PORTABILITY_SOURCE_COMMIT_ABSENT");
  });

  it("refuses ABSENT when a receipt is present but carries no commit", () => {
    expect(resolveSourceCommit({ env: undefined, pinBytes: pin(null) })).toEqual({
      code: SOURCE_COMMIT_CODES.absent, ok: false,
    });
  });

  it.each([
    ["short", "a1f71a4"],
    ["uppercase", SHA_A.toUpperCase()],
    ["overlong", `${SHA_A}0`],
    ["non-hex", `${SHA_A.slice(0, 39)}z`],
    ["a git ref rather than an object name", "refs/heads/main"],
  ])("refuses MALFORMED for an environment value that is %s", (_label, value) => {
    expect(resolveSourceCommit({ env: value, pinBytes: undefined })).toEqual({
      code: SOURCE_COMMIT_CODES.malformed, ok: false,
    });
  });

  it("refuses MALFORMED for a receipt value that is not an object name", () => {
    expect(resolveSourceCommit({ env: undefined, pinBytes: pin("HEAD") })).toEqual({
      code: SOURCE_COMMIT_CODES.malformed, ok: false,
    });
    expect(SOURCE_COMMIT_CODES.malformed).toBe("PORTABILITY_SOURCE_COMMIT_MALFORMED");
  });

  it("refuses SEALED_CONFLICT when a sealed receipt names another tree", () => {
    expect(resolveSourceCommit({ env: SHA_B, pinBytes: sealedPin(SHA_A) })).toEqual({
      code: SOURCE_COMMIT_CODES.conflict, ok: false,
    });
    expect(SOURCE_COMMIT_CODES.conflict).toBe("PORTABILITY_SOURCE_COMMIT_SEALED_CONFLICT");
  });

  it("refuses rather than silently reusing sealed evidence for other bytes", () => {
    // This is the "do not reuse the old receipt" hazard in executable form: a
    // receipt sealed at SHA_A must never bless a run whose bytes are SHA_B.
    const outcome = resolveSourceCommit({ env: SHA_B, pinBytes: sealedPin(SHA_A) });
    expect(outcome.ok).toBe(false);
    expect(outcome).not.toMatchObject({ sourceCommit: SHA_B });
    expect(outcome).not.toMatchObject({ sourceCommit: SHA_A });
  });

  it("a sealed receipt AGREEING with the environment still binds", () => {
    expect(resolveSourceCommit({ env: SHA_A, pinBytes: sealedPin(SHA_A) })).toEqual({
      boundBy: "PIN_AND_ENV", ok: true, sourceCommit: SHA_A,
    });
  });

  it("an UNSEALED receipt yields to the running commit instead of refusing", () => {
    // The receipt answers "where was evidence taken"; the environment answers
    // "what is running". A run newer than an unsealed receipt is ordinary.
    expect(resolveSourceCommit({ env: SHA_B, pinBytes: pin(SHA_A) })).toEqual({
      boundBy: "ENV", ok: true, sourceCommit: SHA_B,
    });
  });

  it("SEALED_CONFLICT needs the seal, not merely a disagreement", () => {
    const unsealed = resolveSourceCommit({ env: SHA_B, pinBytes: pin(SHA_A) });
    const sealed = resolveSourceCommit({ env: SHA_B, pinBytes: sealedPin(SHA_A) });
    expect(unsealed.ok).toBe(true);
    expect(sealed.ok).toBe(false);
  });

  it.each([
    ["unparseable bytes", "{not json"],
    ["a JSON array", "[]"],
    ["a JSON scalar", '"a1f71a4"'],
    ["a non-string sourceCommit", JSON.stringify({ sourceCommit: 7 })],
  ])("refuses PIN_UNREADABLE for %s", (_label, bytes) => {
    expect(resolveSourceCommit({ env: SHA_A, pinBytes: bytes })).toEqual({
      code: SOURCE_COMMIT_CODES.pinUnreadable, ok: false,
    });
    expect(SOURCE_COMMIT_CODES.pinUnreadable).toBe("PORTABILITY_SOURCE_COMMIT_PIN_UNREADABLE");
  });

  it("refuses an unreadable receipt BEFORE consulting a valid environment value", () => {
    // Ordering matters: a corrupt receipt with a good environment value must not
    // read as bound, or a mangled pin would be invisible in CI forever.
    expect(resolveSourceCommit({ env: SHA_A, pinBytes: "{not json" })).toEqual({
      code: SOURCE_COMMIT_CODES.pinUnreadable, ok: false,
    });
  });

  it("never falls back to the moving head", () => {
    const source = readFileSync(join(import.meta.dirname, "portability-source-commit.ts"), "utf8");
    // Comments are stripped first: this guard is about what the module EXECUTES,
    // and the prose above deliberately names the hazard it closes. A guard that
    // reads comments would be satisfied by renaming a sentence.
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    expect(code).toContain("resolveSourceCommit");
    expect(code).not.toMatch(/rev-parse/u);
    expect(code).not.toMatch(/child_process/u);
    expect(code).not.toMatch(/\.git['"`]/u);
  });
});

describe("portability source-commit resolution — production surface", () => {
  it("resolves through the real environment and the real committed receipt", () => {
    const outcome = resolvePortabilitySourceCommit();
    expect(outcome.ok).toBe(true);
    expect(outcome).toMatchObject({ sourceCommit: expect.stringMatching(/^[0-9a-f]{40}$/u) });
  });

  it("exposes ONE captured constant that equals a fresh production read", () => {
    expect(PORTABILITY_SOURCE_COMMIT).toMatch(/^[0-9a-f]{40}$/u);
    expect(PORTABILITY_SOURCE_COMMIT).toBe(readPortabilitySourceCommit());
  });

  it("finds the committed receipt on disk and parses it as its contract", () => {
    const bytes = readPinBytes();
    expect(bytes, `${SOURCE_COMMIT_PIN_FILE} must be committed beside the resolver`).toBeTypeOf("string");
    const parsed = JSON.parse(bytes ?? "") as Record<string, unknown>;
    expect(parsed["sourceCommit"]).toMatch(/^[0-9a-f]{40}$/u);
    // UNKNOWN external evidence stays typed. `externalRun` is null until an
    // external push run at `sourceCommit` is accepted by the exact-SHA gate; a
    // null here is UNKNOWN, and this suite never reads it as a pass.
    expect(parsed).toHaveProperty("externalRun");
    expect(parsed).toHaveProperty("aggregateDigest");
    // A SEALED receipt must carry the digest that seals it. Sealed-without-digest
    // would be an evidence claim with nothing behind it.
    if (parsed["externalRun"] !== null) {
      expect(parsed["aggregateDigest"]).toMatch(/^sha256:[0-9a-f]{64}$/u);
    }
  });

  it("names the environment variable CI binds to the push run's github.sha", () => {
    expect(SOURCE_COMMIT_ENV).toBe("MOE_PORTABILITY_SOURCE_COMMIT");
  });

  it("returns undefined pin bytes for a directory holding no receipt", () => {
    expect(readPinBytes(join(import.meta.dirname, "no-such-directory"))).toBeUndefined();
  });
});
