import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

import { expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const schedulerRoot = join(repositoryRoot, "packages", "scheduler");
const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx|astro|mdx|svelte|vue)$/u;
const forbiddenInternalPath = /(?:@moe\/scheduler\/|scheduler[\\/]src[\\/])/u;
/**
 * DEVELOPMENT_ONLY reference code. `@moe/scheduler` declares only @moe/context,
 * @moe/contracts and @moe/core and has no devDependencies, so a testkit import
 * could not resolve — but an unresolvable import is a build failure, not an
 * asserted property, and the manifest is one edit away from making it resolve.
 */
const forbiddenDevelopmentOnlyPath = /(?:@moe\/testkit|testkit[\\/]src[\\/])/u;

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
  readonly literal: string | null;
  readonly nextIndex: number;
}

const identifierStart = /[A-Za-z_$]/u;
const identifierPart = /[\w$]/u;
const regexPrefixIdentifiers: ReadonlySet<string> = new Set([
  "await", "case", "delete", "do", "else", "in", "instanceof", "new",
  "of", "return", "throw", "typeof", "void", "yield",
] as const);
const regexPrefixPunctuation: ReadonlySet<string> = new Set([
  "(", "[", "{", "=", ":", ",", ";", "!", "?", "&", "|", "+", "-", "*", "%", "^", "~", ">",
] as const);

function canStartRegularExpression(tokens: readonly SourceToken[]): boolean {
  const previous = tokens[tokens.length - 1];
  if (previous === undefined) return true;
  if (previous.kind === "identifier") return regexPrefixIdentifiers.has(previous.value);
  return previous.kind === "punctuation" && regexPrefixPunctuation.has(previous.value);
}

function readRegularExpression(contents: string, startIndex: number): number {
  let inCharacterClass = false;
  let index = startIndex + 1;
  while (index < contents.length) {
    const character = contents[index];
    if (character === "\\") {
      index += 2;
    } else if (character === "\n" || character === "\r") {
      throw new Error("unterminated regular expression source token");
    } else if (character === "[") {
      inCharacterClass = true;
      index += 1;
    } else if (character === "]") {
      inCharacterClass = false;
      index += 1;
    } else if (character === "/" && !inCharacterClass) {
      index += 1;
      while (/[A-Za-z]/u.test(contents[index] ?? "")) index += 1;
      return index;
    } else {
      index += 1;
    }
  }
  throw new Error("unterminated regular expression source token");
}

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
    if (character === "\n" || character === "\r") {
      throw new Error("unterminated quoted source token");
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
  let literal: string | null = "";
  let index = startIndex + 1;
  while (index < contents.length) {
    const character = contents[index];
    if (character === "\\") {
      if (literal !== null && index + 1 < contents.length) literal += contents[index + 1];
      index += 2;
    } else if (character === "\u0060") {
      return { expressions, literal, nextIndex: index + 1 };
    } else if (character === "$" && contents[index + 1] === "{") {
      literal = null;
      const expressionStart = index + 2;
      const expressionEnd = templateExpressionEnd(contents, expressionStart);
      expressions.push(contents.slice(expressionStart, expressionEnd));
      index = expressionEnd < contents.length ? expressionEnd + 1 : expressionEnd;
    } else {
      if (literal !== null) literal += character;
      index += 1;
    }
  }
  return { expressions, literal, nextIndex: contents.length };
}

function sourceTokens(contents: string): SourceToken[] {
  const tokens: SourceToken[] = [];
  // A leading `#!` shebang is not JavaScript and must be skipped before tokenizing:
  // `#!/usr/bin/env node` otherwise opens a regex literal at the first `/` that never
  // terminates, and the scan throws instead of reading the file. A bin entry point is
  // exactly the kind of file this boundary must cover, so skipping the line widens
  // coverage rather than narrowing it.
  let index = contents.startsWith("#!")
    ? (contents.indexOf("\n") < 0 ? contents.length : contents.indexOf("\n") + 1)
    : 0;
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
    } else if (character === "/" && canStartRegularExpression(tokens)) {
      index = readRegularExpression(contents, index);
    } else if (character === "'" || character === '"') {
      const quoted = readQuoted(contents, index);
      tokens.push({ kind: "string", value: quoted.value });
      index = quoted.nextIndex;
    } else if (character === "\u0060") {
      const template = readTemplate(contents, index);
      if (template.literal !== null) tokens.push({ kind: "string", value: template.literal });
      for (const expression of template.expressions) {
        tokens.push({ kind: "punctuation", value: "{" });
        tokens.push(...sourceTokens(expression));
        tokens.push({ kind: "punctuation", value: "}" });
      }
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

/**
 * Reuses the same tokenizer rather than text-matching, and that is load-bearing
 * here, not stylistic: three landed production sources — fairness-contract.ts:11,
 * fairness-evidence.ts:7 and fairness-ring.ts:9 — cite the reference PATH inside
 * doc comments to record what they were deliberately NOT derived from. A raw
 * grep would report those three as violations while proving nothing.
 */
function containsDevelopmentOnlyImport(contents: string): boolean {
  return moduleSpecifiers(contents).some(
    (specifier) => forbiddenDevelopmentOnlyPath.test(specifier));
}

const forbiddenImportCases: ReadonlyArray<readonly [string, string]> = [
  ["static value import-from", 'import { fence } from "@moe/scheduler/authority/private.js";'],
  ["import type-from", 'import type { Lease } from "../../scheduler/src/authority/lease.js";'],
  ["side-effect import", 'import "@moe/scheduler/authority/private.js";'],
  ["export-from", 'export { fence } from "../../scheduler/src/authority/private.js";'],
  ["dynamic import", 'const scheduler = await import("@moe/scheduler/authority/private.js");'],
  ["backtick dynamic import", 'const scheduler = import(\x60@moe/scheduler/authority/private.js\x60);'],
  ["backtick require", 'const scheduler = require(\x60../../scheduler/src/authority/private.js\x60);'],
  ["backtick import-from", 'import { fence } from \x60../../scheduler/src/authority/private.js\x60;'],
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
  ["interpolated template specifier", 'const scheduler = import(\x60@moe/scheduler/${segment}\x60);'],
  ["constant-string interpolated template specifier", 'const scheduler = import(\x60${"@moe/scheduler/authority/private.js"}\x60);'],
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
      const repositoryPath = relative(repositoryRoot, file);
      scanned.push(repositoryPath);
      try {
        if (containsForbiddenSchedulerImport(contents)) violations.push(repositoryPath);
      } catch (error) {
        throw new Error(`boundary scan failed for ${repositoryPath}: ${String(error)}`);
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

it("detects a genuine import after a regex containing a quote", () => {
  const contents = 'const pattern = /"/;\nimport { fence } from "@moe/scheduler/authority/private.js";';
  expect(containsForbiddenSchedulerImport(contents)).toBe(true);
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

const developmentOnlyImportCases: ReadonlyArray<readonly [string, string]> = [
  ["a package import", 'import { selectNext } from "@moe/testkit";'],
  ["a deep package import", 'import { PRIORITY_LADDER } from "@moe/testkit/scheduler-fairness/fairness-policy.js";'],
  ["a relative reference import", 'import { boundFor } from "../../testkit/src/scheduler-fairness/fairness-selection.js";'],
  ["a side-effect import", 'import "@moe/testkit";'],
  ["an export-from", 'export { DEFAULT_M_D } from "@moe/testkit";'],
  ["a dynamic import", 'const reference = await import("@moe/testkit");'],
  ["a CommonJS require", 'const reference = require("..\\\\testkit\\\\src\\\\scheduler-fairness\\\\index.js");'],
];

const developmentOnlyProseCases: ReadonlyArray<readonly [string, string]> = [
  ["the citation in fairness-contract.ts:11", " * in packages/testkit/src/scheduler-fairness. Three differences carry the design:"],
  ["the citation in fairness-evidence.ts:7", " * packages/testkit/src/scheduler-fairness/fairness-codec.ts decodes a caller's"],
  ["the citation in fairness-ring.ts:9", " * packages/testkit/src/scheduler-fairness returns nothing outside its tests, so"],
  ["a block-comment citation", '/** Mirrors BYPASSES_PER_LEVEL at @moe/testkit fairness-policy.ts:25. */'],
  ["a commented-out import", '// import { selectNext } from "@moe/testkit";'],
  ["a constant naming the path", 'const cited = "packages/testkit/src/scheduler-fairness/fairness-policy.ts:8";'],
];

it("covers forbidden and cited DEVELOPMENT_ONLY cases", () => {
  expect(developmentOnlyImportCases.length).toBe(7);
  expect(developmentOnlyProseCases.length).toBe(6);
});

it.each(developmentOnlyImportCases)("detects a DEVELOPMENT_ONLY import as %s", (_label, contents) => {
  expect(containsDevelopmentOnlyImport(contents)).toBe(true);
});

it.each(developmentOnlyProseCases)("allows %s", (_label, contents) => {
  expect(containsDevelopmentOnlyImport(contents)).toBe(false);
});

/**
 * DoD 3. The floor is hand-written from `find packages/scheduler/src -name
 * '*.ts' ! -name '*.test.ts' | wc -l` = 66 at the time of writing, kept a little
 * below so ordinary growth does not churn it. Without a floor, a mis-resolved
 * directory read scans zero files and the empty violation list reads as proof.
 */
const MINIMUM_PRODUCTION_SOURCES_SCANNED = 60;

it("keeps DEVELOPMENT_ONLY reference code out of scheduler production sources", async () => {
  const scanned: string[] = [];
  const violations: string[] = [];
  for (const file of await sourceFiles(join(schedulerRoot, "src"))) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
    const repositoryPath = relative(repositoryRoot, file);
    scanned.push(repositoryPath);
    if (containsDevelopmentOnlyImport(await readFile(file, "utf8"))) {
      violations.push(repositoryPath);
    }
  }
  expect(violations).toEqual([]);
  expect(scanned.length).toBeGreaterThanOrEqual(MINIMUM_PRODUCTION_SOURCES_SCANNED);
  // Named witnesses: the three sources that CITE the reference in prose, and the
  // two new engine modules. A scan that silently stopped covering them would
  // otherwise pass on the floor alone.
  for (const witness of [
    join("packages", "scheduler", "src", "fairness", "fairness-contract.ts"),
    join("packages", "scheduler", "src", "fairness", "fairness-evidence.ts"),
    join("packages", "scheduler", "src", "fairness", "fairness-ring.ts"),
    join("packages", "scheduler", "src", "fairness", "fairness-rotation.ts"),
    join("packages", "scheduler", "src", "fairness", "fairness-aging.ts"),
  ]) {
    expect(scanned).toContain(witness);
  }
});

it("declares no dependency that could resolve a DEVELOPMENT_ONLY import", async () => {
  const packageJson = JSON.parse(await readFile(join(schedulerRoot, "package.json"), "utf8")) as {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  };
  const declared = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ];
  expect(declared).toEqual(["@moe/context", "@moe/contracts", "@moe/core"]);
});

it("exports only the supported scheduler root", async () => {
  const packageJson = JSON.parse(
    await readFile(join(schedulerRoot, "package.json"), "utf8"),
  ) as { readonly exports?: unknown };
  expect(packageJson.exports).toEqual({ ".": "./src/index.ts" });
});
