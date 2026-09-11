import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { collectImportFaults } from "../../../tools/packaging/pack-imports.js";
import {
  collectClosure, pruneTestArtifacts, removeEmptyDirectories, walkFiles,
} from "../../../tools/packaging/pack-staging.js";

/**
 * `collectImportFaults` is the completeness proof behind the prune: whatever the
 * test-artifact rules decide to delete, the surviving tree must still resolve.
 * These cases run against a REAL directory, because the fault the gate exists to
 * catch — a `.js` bridge left pointing at a deleted `.ts` — only exists on disk.
 */

const ROOT = mkdtempSync(join(tmpdir(), "moe-pack-imports-"));

afterAll(() => {
  rmSync(ROOT, { force: true, recursive: true });
});

function tree(name: string, files: Readonly<Record<string, string>>): string {
  const root = join(ROOT, name);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  return root;
}

function faultsOf(root: string, devDependencies: readonly string[] = ["vitest"]): {
  readonly dangling: readonly string[];
  readonly devDependency: readonly string[];
} {
  return collectImportFaults(root, walkFiles(root), devDependencies);
}

describe("collectImportFaults over a staged tree", () => {
  it("admits actual controlled-profile template modules without reading generated code as imports", () => {
    const directory = "apps/daemon/src/repository/controlled-profile/";
    const root = tree("controlled-profile", {
      ...Object.fromEntries([
        "controlled-profile-package-templates.ts", "controlled-profile-root-templates.ts",
      ].map((file) => [directory + file,
        readFileSync(new URL(`../../../${directory}${file}`, import.meta.url), "utf8")])),
      // Its real source import remains required; only generated-file text is inert.
      "apps/daemon/src/environment/environment-required-variables.js": "export {};\n",
    });
    expect(faultsOf(root, ["@vitejs/plugin-react", "vite", "vitest", "@playwright/test"]))
      .toEqual({ dangling: [], devDependency: [] });
  });

  it("ignores inert quoted, template, comment, regex, and JSX content", () => {
    const root = tree("inert-source", {
      "packages/a/src/templates.tsx": [
        'const quoted = \'import { x } from "./quoted.js"\';',
        'const template = `import("./template.js")`;',
        '// import "./line-comment.js";',
        '/* export { x } from "./block-comment.js"; */',
        'const regex = /import("vitest")/u;',
        'if (true) /from "vitest"/u.test(quoted);',
        'const element = <div>import("./jsx-text.js")</div>;',
      ].join("\n"),
    });
    expect(faultsOf(root)).toEqual({ dangling: [], devDependency: [] });
  });

  it("keeps actual dynamic, require, template-expression, JSX-expression, and type import edges", () => {
    const root = tree("executed-imports", {
      "packages/a/src/caller.tsx": [
        'const dynamic = import /* comment */ ("./dynamic.js");',
        'const common = require("./common.cjs");',
        'const template = `inert import("./ignore.js") ${import("./expression.js")}`;',
        'const element = <div>{require("./jsx-expression.cjs")}</div>;',
        'type Shape = import("./types.js").Shape;',
        'const dev = require("vitest");',
        'const devSubpath = import("vitest/config");',
        'import "@vitejs/plugin-react";',
      ].join("\n"),
    });
    expect(faultsOf(root, ["vitest", "@vitejs/plugin-react"])).toEqual({
      dangling: ["./common.cjs", "./dynamic.js", "./expression.js", "./jsx-expression.cjs", "./types.js"]
        .map((specifier) => `packages/a/src/caller.tsx -> ${specifier}`),
      devDependency: ["packages/a/src/caller.tsx -> @vitejs/plugin-react", "packages/a/src/caller.tsx -> vitest"],
    });
  });

  it.each(["cjs", "cts"])("preserves legal CommonJS syntax while checking %s dependency edges", (extension) => {
    const file = `packages/a/src/caller.${extension}`;
    const root = tree(`commonjs-${extension}`, {
      [file]: 'if (!enabled) return; const target = new.target; require("./missing.cjs");',
    });
    expect(faultsOf(root)).toEqual({ dangling: [`${file} -> ./missing.cjs`], devDependency: [] });
  });

  it.each([
    'const broken = "PRIVATE-SOURCE-DIAGNOSTIC',
    'const broken = `PRIVATE-SOURCE-DIAGNOSTIC ${import("./real.js")}',
    'const broken = /PRIVATE-SOURCE-DIAGNOSTIC',
  ])("refuses malformed source without exposing parser diagnostics", (source) => {
    const root = tree(`malformed-${String(source.length)}`, { "packages/a/src/broken.ts": source });
    expect(() => faultsOf(root)).toThrow(/^PACK_SOURCE_SYNTAX_INVALID$/u);
  });

  it("loads the scanner through its Node bridge before the materialization has node_modules", () => {
    const root = tree("bootstrap-import", { "package.json": '{"type":"module"}' });
    for (const extension of ["ts", "js"]) {
      copyFileSync(new URL(`../../../tools/packaging/pack-imports.${extension}`, import.meta.url),
        join(root, `pack-imports.${extension}`));
    }
    const loaded = spawnSync(process.execPath, ["--input-type=module", "-e",
      `const imported = await import(${JSON.stringify(pathToFileURL(join(root, "pack-imports.js")).href)});`
        + 'process.stdout.write(typeof imported.collectImportFaults);'], {
      cwd: root, encoding: "utf8", shell: false, timeout: 10_000, windowsHide: true,
    });
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toBe("function");
  });

  it("admits a tree whose every relative import resolves", () => {
    const root = tree("clean", {
      "packages/a/src/index.ts": 'export { work } from "./work.js";\n',
      "packages/a/src/index.js": 'export * from "./index.ts";\n',
      "packages/a/src/work.ts": 'import { join } from "node:path";\nexport const work = join;\n',
    });
    expect(faultsOf(root)).toEqual({ dangling: [], devDependency: [] });
  });

  it("names the .js bridge left pointing at a .ts the prune deleted", () => {
    const root = tree("bridge", {
      "packages/a/src/admission-fixtures.ts": "export const SEED = 1;\n",
      "packages/a/src/admission-fixtures.js": 'export * from "./admission-fixtures.ts";\n',
      "packages/a/src/admission.ts": 'import { SEED } from "./admission-fixtures.js";\n'
        + "export const seed = SEED;\n",
    });
    expect(faultsOf(root).dangling).toEqual([]);

    // The real sequence, not a hand-planted hole: prune first, then re-scan.
    const pruned = pruneTestArtifacts(root);
    expect(pruned).toContain("packages/a/src/admission-fixtures.ts");
    expect(pruned).toContain("packages/a/src/admission-fixtures.js");
    expect(faultsOf(root).dangling).toEqual([
      "packages/a/src/admission.ts -> ./admission-fixtures.js",
    ]);
  });

  it("resolves a .js specifier onto its .ts module, the shape this repo ships", () => {
    const root = tree("bridged-specifier", {
      "packages/a/src/caller.ts": 'import { x } from "./module.js";\nexport const y = x;\n',
      "packages/a/src/module.ts": "export const x = 1;\n",
    });
    expect(faultsOf(root).dangling).toEqual([]);
  });

  it("resolves a directory specifier onto its index module", () => {
    const root = tree("index-specifier", {
      "packages/a/src/caller.ts": 'import { x } from "./nested/index.js";\nexport const y = x;\n',
      "packages/a/src/nested/index.ts": "export const x = 1;\n",
    });
    expect(faultsOf(root).dangling).toEqual([]);
  });

  it("sees the type-position import(\"./x.js\") form this repo writes", () => {
    const root = tree("type-position", {
      "packages/a/src/caller.ts":
        'export interface A { readonly p: import("./gone.js").Principal | null }\n',
    });
    expect(faultsOf(root).dangling).toEqual(["packages/a/src/caller.ts -> ./gone.js"]);
  });

  it("sees a side-effect import, which carries no `from` to match on", () => {
    const root = tree("side-effect", { "packages/a/src/caller.ts": 'import "./gone.js";\n' });
    expect(faultsOf(root).dangling).toEqual(["packages/a/src/caller.ts -> ./gone.js"]);
  });

  it("names a shipped source importing a dev-only package, which cannot resolve", () => {
    const root = tree("dev-import", {
      "packages/a/src/conformance.ts": 'import { expect } from "vitest";\nexport const e = expect;\n',
    });
    expect(faultsOf(root).devDependency).toEqual(["packages/a/src/conformance.ts -> vitest"]);
  });

  it("does not mistake a production dependency for a dev-only one", () => {
    const root = tree("prod-import", {
      "packages/a/src/server.ts":
        'import { Server } from "@modelcontextprotocol/sdk/server/index.js";\n'
        + "export const s = Server;\n",
    });
    expect(faultsOf(root, ["vitest", "@types/node"]).devDependency).toEqual([]);
  });

  it("reads vendored bytes as untouchable: their internals are the deploy closure", () => {
    const root = tree("vendored", {
      "node_modules/fast-uri/index.js": 'module.exports = require("./lib/missing.js");\n',
      "packages/a/src/index.ts": "export const x = 1;\n",
    });
    expect(faultsOf(root)).toEqual({ dangling: [], devDependency: [] });
  });

  it("reports each faulty edge once, however often the file repeats the import", () => {
    const root = tree("repeated", {
      "packages/a/src/caller.ts": 'import { a } from "./gone.js";\n'
        + 'export { b } from "./gone.js";\n',
    });
    expect(faultsOf(root).dangling).toEqual(["packages/a/src/caller.ts -> ./gone.js"]);
  });
});

describe("removeEmptyDirectories, the other half of a prune", () => {
  it("removes the directory a prune emptied, which the zip would still list", () => {
    const root = tree("emptied", {
      "packages/a/src/keep.ts": "export const x = 1;\n",
      "packages/a/src/tests/job_sweep.rs": "#[test] fn t() {}\n",
    });
    expect(pruneTestArtifacts(root)).toEqual(["packages/a/src/tests/job_sweep.rs"]);
    expect(removeEmptyDirectories(root)).toEqual(["packages/a/src/tests"]);
    expect(walkFiles(root)).toEqual(["packages/a/src/keep.ts"]);
  });

  it("collapses a chain the prune emptied all the way up, not just the leaf", () => {
    const root = tree("chain", {
      "packages/a/src/keep.ts": "export const x = 1;\n",
      "packages/a/support/__tests__/deep/a.test.ts": "export const t = 1;\n",
    });
    pruneTestArtifacts(root);
    expect(removeEmptyDirectories(root)).toEqual([
      "packages/a/support", "packages/a/support/__tests__", "packages/a/support/__tests__/deep",
    ]);
  });

  it("leaves a directory that still holds a file, and never the root itself", () => {
    const root = tree("populated", { "packages/a/src/keep.ts": "export const x = 1;\n" });
    expect(removeEmptyDirectories(root)).toEqual([]);
    expect(walkFiles(root)).toEqual(["packages/a/src/keep.ts"]);
  });
});

describe("collectClosure over a hoisted deploy that nested on a version conflict", () => {
  const manifest = (name: string, version: string): string =>
    `${JSON.stringify({ name, version })}\n`;

  it("discloses the nested version, once, beside the hoisted one", () => {
    const root = tree("nested-closure", {
      "node_modules/body-parser/node_modules/content-type/package.json":
        manifest("content-type", "2.0.0"),
      "node_modules/body-parser/package.json": manifest("body-parser", "2.3.0"),
      "node_modules/content-type/package.json": manifest("content-type", "1.0.5"),
      "node_modules/express/node_modules/content-type/package.json":
        manifest("content-type", "2.0.0"),
      "node_modules/express/package.json": manifest("express", "5.1.0"),
    });
    expect(collectClosure(join(root, "node_modules"))).toEqual([
      { name: "body-parser", version: "2.3.0" },
      { name: "content-type", version: "1.0.5" },
      { name: "content-type", version: "2.0.0" },
      { name: "express", version: "5.1.0" },
    ]);
  });

  it("follows a nesting under a scoped package, and one nested two levels deep", () => {
    const root = tree("deep-closure", {
      "node_modules/@scope/sdk/node_modules/inner/node_modules/leaf/package.json":
        manifest("leaf", "3.0.0"),
      "node_modules/@scope/sdk/node_modules/inner/package.json": manifest("inner", "0.2.0"),
      "node_modules/@scope/sdk/package.json": manifest("@scope/sdk", "1.4.0"),
    });
    expect(collectClosure(join(root, "node_modules"))).toEqual([
      { name: "@scope/sdk", version: "1.4.0" },
      { name: "inner", version: "0.2.0" },
      { name: "leaf", version: "3.0.0" },
    ]);
  });

  it("skips a nested .bin and a nested directory that is not a package", () => {
    const root = tree("junk-closure", {
      "node_modules/a/node_modules/.bin/tool.cmd": "@echo off\n",
      "node_modules/a/node_modules/not-a-package/index.js": "module.exports = 1;\n",
      "node_modules/a/package.json": manifest("a", "1.0.0"),
    });
    expect(collectClosure(join(root, "node_modules"))).toEqual([
      { name: "a", version: "1.0.0" },
    ]);
  });
});
