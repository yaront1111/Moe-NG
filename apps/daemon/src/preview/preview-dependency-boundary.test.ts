import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { previewDependencyInputsContained, previewDependencyLinksContained } from "./preview-dependency-boundary.js";
import { cleanupFixtureWorkspaces, fixtureWorkspace } from "./preview-test-fixtures.js";
import type { PreviewSource } from "./preview-source.js";

afterEach(cleanupFixtureWorkspaces);
function source(files: Record<string, string>): PreviewSource {
  return { directory: fixtureWorkspace({ scripts: {}, files }), files: Object.keys(files),
    verify: () => true, dispose: () => undefined };
}

describe("default preview dependency boundary", () => {
  it("resolves pnpm workspace links relative to their importer", () => {
    const selected = source({ "packages/dep/package.json": "{}", "apps/web/package.json": "{}",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  apps/web:\n    dependencies:\n      dep:\n        specifier: workspace:*\n        version: link:../../packages/dep\n" });
    expect(previewDependencyInputsContained(selected)).toBe(true);
  });
  it.each([
    ["pnpm-lock.yaml", 'external: "\\x66ile:../external"\n'],
    ["pnpm-lock.yaml", 'resolution: {directory: ../external, type: directory}\n'],
    ["pnpm-workspace.yaml", 'packages: ["../external"]\n'],
    ["package.json", '{"dependencies":{"external":"file:"}}'],
    ["package.json", '{"dependencies":{"external":"../external"}}'],
    ["package.json", '{"workspaces":{"packages":["../external"]}}'],
    ["package-lock.json", '{"packages":{"../external":{"name":"external"}}}'],
  ])("rejects escaped dependency input in %s", (name, contents) => {
    expect(previewDependencyInputsContained(source({ [name]: contents }))).toBe(false);
  });
  it("rejects installed links into external mutable bytes but allows extracted packages", () => {
    const selected = source({ "vendor/package.json": "{}" });
    const external = source({ "index.js": "mutable bytes" });
    mkdirSync(join(selected.directory, "node_modules"));
    symlinkSync(join(selected.directory, "vendor"), join(selected.directory, "node_modules/internal"), "junction");
    expect(previewDependencyLinksContained(selected)).toBe(true);
    symlinkSync(external.directory, join(selected.directory, "node_modules/external"), "junction");
    expect(previewDependencyLinksContained(selected)).toBe(false);
  });
});
