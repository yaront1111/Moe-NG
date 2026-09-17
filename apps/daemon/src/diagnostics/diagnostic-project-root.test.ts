import { describe, expect, it } from "vitest";

import { diagnosticProjectRoot } from "./diagnostic-project-root.js";

const normalise = (path: string): string => path.replaceAll("\\", "/");

/** Built rather than written literally, so no layer between here and the file eats an escape. */
const BACKSLASH = String.fromCharCode(92);
const windowsPath = (...segments: readonly string[]): string => segments.join(BACKSLASH);

describe("diagnosticProjectRoot", () => {
  it("takes the project root from a store path inside .moe", () => {
    expect(normalise(diagnosticProjectRoot("/work/demo/.moe/store.db", "/elsewhere")))
      .toBe("/work/demo");
  });

  it("handles a store nested deeper under .moe", () => {
    expect(normalise(diagnosticProjectRoot("/work/demo/.moe/store/events.db", "/elsewhere")))
      .toBe("/work/demo");
  });

  it("accepts Windows separators, which is the platform this daemon ships on", () => {
    const store = windowsPath("D:", "projexts", "demo", ".moe", "store.db");

    expect(normalise(diagnosticProjectRoot(store, windowsPath("C:", "x"))))
      .toBe("D:/projexts/demo");
  });

  it("falls back to the working directory when the store lives outside .moe", () => {
    expect(normalise(diagnosticProjectRoot("/tmp/scratch/store.db", "/work/demo")))
      .toBe("/work/demo");
  });

  it("falls back for an empty store path rather than resolving to the filesystem root", () => {
    expect(normalise(diagnosticProjectRoot("", "/work/demo"))).toBe("/work/demo");
  });

  it("does not mistake a directory merely containing the text .moe", () => {
    expect(normalise(diagnosticProjectRoot("/work/.moetest/store.db", "/work/demo")))
      .toBe("/work/demo");
  });

  it("falls back when .moe IS the root, which names no project to log against", () => {
    expect(normalise(diagnosticProjectRoot("/.moe/store.db", "/work/demo"))).toBe("/work/demo");
  });
});
