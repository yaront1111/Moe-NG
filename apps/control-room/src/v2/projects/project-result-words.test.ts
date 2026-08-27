import { describe, expect, it } from "vitest";

import { RESULT_WORDS, lifecycleWord, resultWords, safeResult } from "./project-result-words.js";

const STABLE_NAME = /^[A-Z][A-Z0-9_]*$/u;
const SENTENCE = /^[A-Z].*\.$/u;

describe("project-result-words result contract", () => {
  it("passes through exactly a stable code, layer and ok, and nothing else", () => {
    expect(safeResult({ code: "PROJECT_RUNTIME_STARTED", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: true, secret: "x" }))
      .toEqual({ code: "PROJECT_RUNTIME_STARTED", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: true });
  });

  it.each([
    undefined, null, "PROJECT_RUNTIME_STARTED", 42,
    { code: "PROJECT_RUNTIME_STARTED", layer: "PROJECT_RUNTIME_SUPERVISOR" },
    { code: "PROJECT_RUNTIME_STARTED", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: "yes" },
    { code: "not a code", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: true },
    { code: "PROJECT_RUNTIME_STARTED", layer: "lower", ok: true },
    { code: "", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: false },
  ])("fails closed to the local refusal for %o", (value) => {
    // The literal, not the exported constant: a drifted code or layer must red here.
    expect(safeResult(value)).toEqual({
      code: "PROJECT_HOME_REQUEST_FAILED", layer: "CONTROL_ROOM_PROJECT_HOME", ok: false,
    });
  });

  it("says a lifecycle token as one capitalised word and leaves an unknown token verbatim", () => {
    expect(lifecycleWord("RUNNING")).toBe("Running");
    expect(lifecycleWord("FAILED")).toBe("Failed");
    expect(lifecycleWord("STOPPING")).toBe("Stopping");
    expect(lifecycleWord("NEVER_SEEN")).toBe("NEVER_SEEN");
  });
});

describe("project-result-words", () => {
  it("says a mapped refusal in words with the daemon's own next step", () => {
    expect(resultWords({ code: "PROJECT_RUNTIME_NOT_RUNNING", ok: false }))
      .toEqual(["That project is not running.", "Press Start first."]);
    expect(resultWords({ code: "PROJECT_RUNTIME_STOPPED", ok: false }))
      .toEqual(["That project has stopped.", ""]);
  });

  it("falls back on ok alone for an unmapped code, never inventing a diagnosis", () => {
    expect(resultWords({ code: "PROJECT_RUNTIME_NEVER_SEEN_BEFORE", ok: false }))
      .toEqual(["Moe refused that.", "Open Details for the exact reason, then press Refresh."]);
    expect(resultWords({ code: "PROJECT_OPERATION_ACCEPTED", ok: true }))
      .toEqual(["Moe accepted that.", "The list updates as the project reports back."]);
  });

  // The daemon raises CONFIG_UNREADABLE from one catch around realpath, stat and
  // readFile of the folder and its moe.config.json, so it also fires when the
  // folder is missing or the file exists but cannot be read. The sentence may
  // say a read failed; it may not say the file is absent.
  it("says only what CONFIG_UNREADABLE means: a read failed, not that the file is absent", () => {
    const [said] = resultWords({ code: "PROJECT_MANAGER_CONFIG_UNREADABLE", ok: false });
    expect(said).toBe("Moe could not read a setup file in that folder.");
    expect(said).not.toMatch(/found no|no setup file|missing|does not exist|is not there/iu);
  });

  // CSRF_INVALID is a token mismatch; expiry is one of its causes, not its meaning.
  it("does not name expiry as the cause of a CSRF mismatch", () => {
    const [said, next] = resultWords({ code: "PROJECT_MANAGER_CSRF_INVALID", ok: false });
    expect(said).toBe("Moe Projects no longer accepts this page's session.");
    expect(said).not.toMatch(/expir/iu);
    expect(next).toBe("Reload this page to start a new one.");
  });

  it("keeps every entry a stable code, a full sentence, and a next step that is a sentence or nothing", () => {
    expect(Object.isFrozen(RESULT_WORDS)).toBe(true);
    expect(Object.keys(RESULT_WORDS).length).toBeGreaterThan(30);
    for (const [code, words] of Object.entries(RESULT_WORDS)) {
      expect(code).toMatch(STABLE_NAME);
      expect(words).toHaveLength(2);
      const [said, next] = words;
      expect(said).toMatch(SENTENCE);
      expect(next === "" || SENTENCE.test(next)).toBe(true);
      // The headline is words, never the daemon's token echoed back at the owner.
      expect(said).not.toContain(code);
      expect(said).not.toMatch(/[A-Z]{3,}_[A-Z_]+/u);
    }
  });
});
