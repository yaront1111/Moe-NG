import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PAYLOAD_HINTS_ABSENT, PAYLOAD_HINTS_UNAVAILABLE, loadPayloadHints,
} from "./wrapper-payload-hints.js";

/**
 * The three outcomes, each by name. Real files decide presence; the import itself is
 * injected, so the arms pin WHEN the loader imports and what it says, not vite's loader.
 */
describe("loadPayloadHints", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length > 0) {
      const root = roots.pop();
      if (root !== undefined) rmSync(root, { force: true, maxRetries: 5, recursive: true });
    }
  });
  const scratch = (label: string): string => {
    const root = mkdtempSync(join(tmpdir(), `moe-payload-hints-${label}-`));
    roots.push(root);
    return root;
  };

  it("states an absent module as absent, by path, and never imports it", async () => {
    // A checkout or pack that lost the table: its path does not exist. Before this module
    // that read as ERR_MODULE_NOT_FOUND.
    const root = scratch("absent");
    const moduleUrl = pathToFileURL(join(root, "control-room", "src", "live", "live-dispatch.ts"));
    const lines: string[] = [];
    const importModule = vi.fn(async () => ({ payloadFor: () => null }));

    const table = await loadPayloadHints({ importModule, log: (line) => { lines.push(line); }, moduleUrl });

    expect(table).toBeNull();
    expect(importModule).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith(`${PAYLOAD_HINTS_ABSENT} `)).toBe(true);
    expect(lines[0]).toContain("live-dispatch.ts");
    expect(lines[0]).toContain("missions carry no hint");
    expect(lines[0]).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(lines[0]).not.toContain("unavailable");
  });

  it("discloses a present module that fails to load, with the loader's own error", async () => {
    // The 2026-08-20 shape: the table is there and one of ITS imports has no bridge file.
    const root = scratch("broken");
    const path = join(root, "live-dispatch.ts");
    writeFileSync(path, 'import { x } from "./live-dispatch-payloads.js";\n', "utf8");
    const lines: string[] = [];
    const failure = new Error("Cannot find module './live-dispatch-payloads.js'");
    failure.name = "Error [ERR_MODULE_NOT_FOUND]";

    const table = await loadPayloadHints({
      importModule: async () => { throw failure; },
      log: (line) => { lines.push(line); },
      moduleUrl: pathToFileURL(path),
    });

    expect(table).toBeNull();
    expect(lines).toEqual([
      `${PAYLOAD_HINTS_UNAVAILABLE} Error [ERR_MODULE_NOT_FOUND]: Cannot find module './live-dispatch-payloads.js'`,
    ]);
  });

  it("returns the table when the present module exports payloadFor, and says nothing", async () => {
    const root = scratch("loaded");
    const path = join(root, "live-dispatch.ts");
    writeFileSync(path, "export const payloadFor = () => null;\n", "utf8");
    const lines: string[] = [];
    const hint = { subjectRef: "node-1" };
    const importModule = vi.fn(async (href: string) => {
      expect(href).toBe(pathToFileURL(path).href);
      return { payloadFor: (kind: string, target: string | null) => (kind === "review.submit" && target === "node-1" ? hint : null) };
    });

    const table = await loadPayloadHints({ importModule, log: (line) => { lines.push(line); }, moduleUrl: pathToFileURL(path) });

    expect(importModule).toHaveBeenCalledTimes(1);
    expect(table?.payloadFor("review.submit", "node-1")).toBe(hint);
    expect(table?.payloadFor("other", null)).toBeNull();
    expect(lines).toEqual([]);
  });

  it("discloses a present module that exports no payloadFor rather than shipping hintless silently", async () => {
    const root = scratch("shapeless");
    const path = join(root, "live-dispatch.ts");
    writeFileSync(path, "export const something = 1;\n", "utf8");
    const lines: string[] = [];

    const table = await loadPayloadHints({
      importModule: async () => ({ something: 1 }),
      log: (line) => { lines.push(line); },
      moduleUrl: pathToFileURL(path),
    });

    expect(table).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(PAYLOAD_HINTS_UNAVAILABLE);
    expect(lines[0]).toContain("exports no payloadFor function");
  });
});

/**
 * The installed wrapper loads the real table on its own (addendum 2026-09-15). The pack stages
 * only `live-dispatch-payloads.ts`, so it must load with nothing beside it: its imports are
 * type-only, which Node strips. Run under plain Node, as the artifact runs it, not vite.
 */
describe("the payload-hint table the pack ships", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, maxRetries: 5, recursive: true }); });

  it("loads standalone under plain Node and answers payloadFor", () => {
    const root = mkdtempSync(join(tmpdir(), "moe-payload-table-")); roots.push(root);
    const source = fileURLToPath(new URL("../../../control-room/src/live/live-dispatch-payloads.ts", import.meta.url));
    copyFileSync(source, join(root, "live-dispatch-payloads.ts"));
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n', "utf8");
    const probe = `const table = await import(${JSON.stringify(pathToFileURL(join(root, "live-dispatch-payloads.ts")).href)});`
      + " process.stdout.write(typeof table.payloadFor);";

    const answer = execFileSync(process.execPath,
      ["--experimental-transform-types", "--no-warnings", "--input-type=module", "-e", probe],
      { cwd: root, encoding: "utf8", windowsHide: true });

    expect(answer).toBe("function");
  });
});
