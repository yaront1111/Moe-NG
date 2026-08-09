import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

import { expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const schedulerRoot = join(repositoryRoot, "packages", "scheduler");
const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx|astro|mdx|svelte|vue)$/u;
const forbiddenInternalPath = /(?:@moe\/scheduler\/|scheduler[\\/]src[\\/])/u;

interface SourceToken {
  readonly kind: "identifier" | "punctuation" | "string";
  readonly value: string;
}

interface QuotedValue {
  readonly nextIndex: number;
  readonly value: string;
}

interface TemplateValue {
  readonly expressions: readonly string[];
  readonly nextIndex: number;
}

const identifierStart = /[A-Za-z_$]/u;
const identifierPart = /[\w$]/u;

function readQuoted(contents: string, startIndex: number): QuotedValue {
  const quote = contents[startIndex];
  let value = "";
  let index = startIndex + 1;
  while (index < contents.length) {
    const character = contents[index];
    if (character === quote) return { nextIndex: index + 1, value };
    if (character === "\\" && index + 1 < contents.length) {
      value += contents[index + 1];
      index += 2;
      continue;
    }
    value += character;
    index += 1;
  }
  return { nextIndex: contents.length, value };
}

function templateExpressionEnd(contents: string, startIndex: number): number {
  let depth = 1;
  let index = startIndex;
  while (index < contents.length) {
    const character = contents[index];
    const next = contents[index + 1];
    if (character === "'" || character === '"') {
      index = readQuoted(contents, index).nextIndex;
    } else if (character === "\u0060") {
      index = readTemplate(contents, index).nextIndex;
    } else if (character === "/" && next === "/") {
      index = contents.indexOf("\n", index + 2);
      if (index < 0) return contents.length;
    } else if (character === "/" && next === "*") {
      const end = contents.indexOf("*/", index + 2);
      index = end < 0 ? contents.length : end + 2;
    } else if (character === "{") {
      depth += 1;
      index += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
      index += 1;
    } else {
      index += 1;
    }
  }
  return contents.length;
}

function readTemplate(contents: string, startIndex: number): TemplateValue {
  const expressions: string[] = [];
  let index = startIndex + 1;
  while (index < contents.length) {
    const character = contents[index];
    if (character === "\\") {
      index += 2;
    } else if (character === "\u0060") {
      return { expressions, nextIndex: index + 1 };
    } else if (character === "$" && contents[index + 1] === "{") {
      const expressionStart = index + 2;
      const expressionEnd = templateExpressionEnd(contents, expressionStart);
      expressions.push(contents.slice(expressionStart, expressionEnd));
      index = expressionEnd < contents.length ? expressionEnd + 1 : expressionEnd;
    } else {
      index += 1;
    }
  }
  return { expressions, nextIndex: contents.length };
}

function sourceTokens(contents: string): SourceToken[] {
  const tokens: SourceToken[] = [];
  let index = 0;
  while (index < contents.length) {
    const character = contents[index] ?? "";
    const next = contents[index + 1];
    if (/\s/u.test(character)) {
      index += 1;
    } else if (character === "/" && next === "/") {
      index = contents.indexOf("\n", index + 2);
      if (index < 0) index = contents.length;
    } else if (character === "/" && next === "*") {
      const end = contents.indexOf("*/", index + 2);
      index = end < 0 ? contents.length : end + 2;
    } else if (character === "'" || character === '"') {
      const quoted = readQuoted(contents, index);
      tokens.push({ kind: "string", value: quoted.value });
      index = quoted.nextIndex;
    } else if (character === "\u0060") {
      const template = readTemplate(contents, index);
      for (const expression of template.expressions) tokens.push(...sourceTokens(expression));
      index = template.nextIndex;
    } else if (identifierStart.test(character)) {
      let end = index + 1;
      while (end < contents.length && identifierPart.test(contents[end] ?? "")) end += 1;
      tokens.push({ kind: "identifier", value: contents.slice(index, end) });
      index = end;
    } else {
      tokens.push({ kind: "punctuation", value: character });
      index += 1;
    }
  }
  return tokens;
}

function specifierAfterFrom(tokens: readonly SourceToken[], startIndex: number): string | null {
  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.value === ";") return null;
    if (index > startIndex && token?.kind === "identifier"
      && ["export", "import"].includes(token.value)) return null;
    if (token?.kind === "identifier" && token.value === "from") {
      const specifier = tokens[index + 1];
      return specifier?.kind === "string" ? specifier.value : null;
    }
  }
  return null;
}

function moduleSpecifiers(contents: string): string[] {
  const tokens = sourceTokens(contents);
  const specifiers: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "identifier") continue;
    const next = tokens[index + 1];
    const afterNext = tokens[index + 2];
    if ((token.value === "import" || token.value === "require")
      && next?.value === "(" && afterNext?.kind === "string") {
      specifiers.push(afterNext.value);
    } else if (token.value === "import" && next?.kind === "string") {
      specifiers.push(next.value);
    } else if (token.value === "import") {
      const specifier = specifierAfterFrom(tokens, index + 1);
      if (specifier !== null) specifiers.push(specifier);
    } else if (token.value === "export" && ["*", "{", "type"].includes(next?.value ?? "")) {
      const specifier = specifierAfterFrom(tokens, index + 1);
      if (specifier !== null) specifiers.push(specifier);
    }
  }
  return specifiers;
}

function containsForbiddenSchedulerImport(contents: string): boolean {
  return moduleSpecifiers(contents).some((specifier) => forbiddenInternalPath.test(specifier));
}

const forbiddenImportCases: ReadonlyArray<readonly [string, string]> = [
  ["static value import-from", 'import { fence } from "@moe/scheduler/authority/private.js";'],
  ["import type-from", 'import type { Lease } from "../../scheduler/src/authority/lease.js";'],
  ["side-effect import", 'import "@moe/scheduler/authority/private.js";'],
  ["export-from", 'export { fence } from "../../scheduler/src/authority/private.js";'],
  ["dynamic import", 'const scheduler = await import("@moe/scheduler/authority/private.js");'],
  ["dynamic import inside a template expression", 'const value = \x60${import("@moe/scheduler/authority/private.js")}\x60;'],
  ["CommonJS require", 'const scheduler = require("..\\\\scheduler\\\\src\\\\authority\\\\private.js");'],
  ["comment before a genuine import", '// explanation\nimport { fence } from "@moe/scheduler/authority/private.js";'],
  ["multiline single-quoted import-from", "/* explanation */\nimport {\n  fence,\n} from\n  '@moe/scheduler/authority/private.js';"],
  ["an imported binding named require", 'import { require as run } from "@moe/scheduler/authority/private.js";'],
];

const allowedContentCases: ReadonlyArray<readonly [string, string]> = [
  ["the former fixture prose", "/** Mirrors packages/scheduler/src/authority/test-fixtures.ts. */"],
  ["an ordinary string", 'const note = "@moe/scheduler/authority/private.js";'],
  ["a commented-out import", '// import { fence } from "@moe/scheduler/authority/private.js";'],
  ["a block comment containing import syntax", '/** import { fence } from "@moe/scheduler/authority/private.js"; */'],
  ["a string containing import syntax", "const example = 'import { fence } from \\\"@moe/scheduler/authority/private.js\\\"';"],
  ["template-literal prose", 'const prose = \x60import { fence } from "@moe/scheduler/authority/private.js"\x60;'],
  ["an empty file", ""],
  ["the scheduler package root", 'import { fenceAuthority } from "@moe/scheduler";'],
  ["an unrelated import", 'import { decode } from "@moe/contracts";'],
];

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return files;
    }
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (path === schedulerRoot || path.includes(`${sep}node_modules${sep}`)) {
        continue;
      }
      files.push(...await sourceFiles(path));
    } else if (entry.isFile() && sourceExtension.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

const scannedWitness = join("packages", "runner", "src", "supervisor", "effect-test-fixtures.ts");

it("keeps scheduler registrars behind the package-root import boundary", async () => {
  const scanned: string[] = [];
  const violations: string[] = [];
  for (const root of ["adapters", "apps", "packages"]) {
    const files = await sourceFiles(join(repositoryRoot, root));
    for (const file of files) {
      const contents = await readFile(file, "utf8");
      scanned.push(relative(repositoryRoot, file));
      if (containsForbiddenSchedulerImport(contents)) {
        violations.push(relative(repositoryRoot, file));
      }
    }
  }
  expect(scanned.length).toBeGreaterThan(0);
  expect(scanned).toContain(scannedWitness);
  expect(violations).toEqual([]);
});

it("covers forbidden and allowed boundary cases", () => {
  expect(forbiddenImportCases.length).toBeGreaterThan(0);
  expect(allowedContentCases.length).toBeGreaterThan(0);
});

it.each(forbiddenImportCases)("detects %s", (_label, contents) => {
  expect(containsForbiddenSchedulerImport(contents)).toBe(true);
});

it.each(allowedContentCases)("allows %s", (_label, contents) => {
  expect(containsForbiddenSchedulerImport(contents)).toBe(false);
});

it.each([
  "source.js",
  "source.jsx",
  "source.mjs",
  "source.cjs",
  "source.ts",
  "source.tsx",
  "source.mts",
  "source.cts",
  "source.astro",
  "source.mdx",
  "source.svelte",
  "source.vue",
])("scans package-capable source extension in %s", (fileName) => {
  expect(sourceExtension.test(fileName)).toBe(true);
});

it("exports only the supported scheduler root", async () => {
  const packageJson = JSON.parse(
    await readFile(join(schedulerRoot, "package.json"), "utf8"),
  ) as { readonly exports?: unknown };
  expect(packageJson.exports).toEqual({ ".": "./src/index.ts" });
});
