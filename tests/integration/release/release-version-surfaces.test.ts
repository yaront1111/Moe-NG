import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

const EXPECTED_JS_MANIFESTS = Object.freeze([
  "adapters/ide-contract/package.json",
  "adapters/jetbrains/package.json",
  "apps/control-room/package.json",
  "apps/daemon/package.json",
  "package.json",
  "packages/benchmark/package.json",
  "packages/context/package.json",
  "packages/contracts/package.json",
  "packages/control-room-client/package.json",
  "packages/control-room-model/package.json",
  "packages/coordination/package.json",
  "packages/core/package.json",
  "packages/import/package.json",
  "packages/mcp/package.json",
  "packages/review/package.json",
  "packages/runner/package.json",
  "packages/scheduler/package.json",
  "packages/skills/package.json",
  "packages/store/package.json",
  "packages/testkit/package.json",
]);

const CARGO_LOCK_PATH = "packages/runner/src/platform/windows/native/Cargo.lock";
const CARGO_PACKAGES = Object.freeze([
  {
    name: "moe-windows-job-broker",
    path: "packages/runner/src/platform/windows/native/broker/Cargo.toml",
  },
  {
    name: "moe-windows-job-core",
    path: "packages/runner/src/platform/windows/native/Cargo.toml",
  },
]);
const EXPECTED_CARGO_MANIFESTS = Object.freeze(CARGO_PACKAGES.map(({ path }) => path).sort());
const EXPECTED_CARGO_LOCKS = Object.freeze([CARGO_LOCK_PATH]);
const EXPECTED_INTERNAL_CARGO_LOCK_ROWS = Object.freeze(
  CARGO_PACKAGES.map(({ name }) => name).sort(),
);

const EXPECTED_VERSION_SURFACE_FILES = Object.freeze([
  ".github/workflows/cross-host.yml",
  "README.md",
  "apps/control-room/src/v2/shell/nav-rail.tsx",
  "apps/daemon/src/cli/moe-cli-main.ts",
  "docs/release-provenance.md",
  "tools/packaging/pack-docs.ts",
  "tools/packaging/smoke-windows-artifact.ps1",
]);

interface VersionContext {
  readonly full: string;
  readonly series: string;
}

interface ReleaseVersionSurface {
  readonly id: string;
  readonly path: string;
  readonly pattern: RegExp;
  readonly version: keyof VersionContext;
}

const RELEASE_VERSION_SURFACES: readonly ReleaseVersionSurface[] = Object.freeze([
  {
    id: "cli-help-series",
    path: "apps/daemon/src/cli/moe-cli-main.ts",
    pattern: /supervised multi-agent control plane \(v([0-9]+\.[0-9]+), Windows\)/u,
    version: "series",
  },
  {
    id: "control-room-nav-series",
    path: "apps/control-room/src/v2/shell/nav-rail.tsx",
    pattern: /className="cr2-brand-version">v([0-9]+\.[0-9]+)<\/span>/u,
    version: "series",
  },
  {
    id: "windows-artifact-smoke-version",
    path: "tools/packaging/smoke-windows-artifact.ps1",
    pattern: /\$version\.Output\.Trim\(\) -eq '([^']+)'/u,
    version: "full",
  },
  {
    id: "readme-release-stamp",
    path: "README.md",
    pattern: /This repository is stamped `([^`]+)`/u,
    version: "full",
  },
  {
    id: "readme-release-series",
    path: "README.md",
    pattern: /scope-frozen v([0-9]+\.[0-9]+)/u,
    version: "series",
  },
  {
    id: "readme-trusted-workspace-series",
    path: "README.md",
    pattern: /for v([0-9]+\.[0-9]+) it ships as a documented trusted-workspace limitation/u,
    version: "series",
  },
  {
    id: "release-provenance-tag-example",
    path: "docs/release-provenance.md",
    pattern: /package-matching release tag, such as `v([^`]+)`/u,
    version: "full",
  },
  {
    id: "release-provenance-verification-command",
    path: "docs/release-provenance.md",
    pattern: /gh release verify v([^\s]+) --repo/u,
    version: "full",
  },
  {
    id: "cross-host-shipping-lane-series",
    path: ".github/workflows/cross-host.yml",
    pattern: /THE WINDOWS LANE v([0-9]+\.[0-9]+) SHIPS ON/u,
    version: "series",
  },
  {
    id: "cross-host-release-scope-series",
    path: ".github/workflows/cross-host.yml",
    pattern: /SCOPE for v([0-9]+\.[0-9]+): the two local gates/u,
    version: "series",
  },
  {
    id: "pack-docs-exclusion-series",
    path: "tools/packaging/pack-docs.ts",
    pattern: /exclusions are what v([0-9]+\.[0-9]+) genuinely omits/u,
    version: "series",
  },
]);

interface VersionOccurrenceExclusion {
  readonly expectedCurrentCaptureCount: number;
  readonly id: string;
  readonly path: string;
  /** Capture group 1 is the excluded full literal, including `v` when present. */
  readonly pattern: RegExp;
}

const VERSION_OCCURRENCE_EXCLUSIONS: readonly VersionOccurrenceExclusion[] = Object.freeze([
  {
    expectedCurrentCaptureCount: 1,
    id: "in-toto-release-predicate-schema",
    path: ".github/workflows/reusable-windows-publication-verify.yml",
    pattern: /predicateType === "https:\/\/in-toto\.io\/attestation\/release\/(v[0-9]+\.[0-9]+)"/u,
  },
  {
    expectedCurrentCaptureCount: 1,
    id: "cli-cwd-injected-version-fixture",
    path: "apps/daemon/src/cli/moe-cli-cwd.test.ts",
    pattern: /packageVersion: "([0-9]+\.[0-9]+\.[0-9]+)"/u,
  },
  {
    expectedCurrentCaptureCount: 4,
    id: "cli-main-injected-version-fixtures",
    path: "apps/daemon/src/cli/moe-cli-main.test.ts",
    pattern: /"([0-9]+\.[0-9]+\.[0-9]+)"/u,
  },
  {
    expectedCurrentCaptureCount: 2,
    id: "journey-scope-freeze-evidence-ledger",
    path: "tests/e2e/control-room/journey-coverage.ts",
    pattern: /the (v[0-9]+\.[0-9]+) scope freeze/iu,
  },
  {
    expectedCurrentCaptureCount: 1,
    id: "distribution-sweep-history",
    path: "tests/integration/distribution/pack-artifact-sweep.test.ts",
    pattern: /(v[0-9]+\.[0-9]+) shipped 25 of this repo's/u,
  },
  {
    expectedCurrentCaptureCount: 1,
    id: "release-verifier-predicate-fixture",
    path: "tests/integration/release/verify-windows-release.test.mjs",
    pattern: /predicateType: "https:\/\/in-toto\.io\/attestation\/release\/(v[0-9]+\.[0-9]+)"/u,
  },
  {
    expectedCurrentCaptureCount: 1,
    id: "integrity-hostile-activation-claim",
    path: "tests/security/integrity-hostile-cases.ts",
    pattern: /"Moe v([0-9]+\.[0-9]+\.[0-9]+) satisfies its stated correctness invariants/u,
  },
  {
    expectedCurrentCaptureCount: 1,
    id: "pack-inventory-history",
    path: "tools/packaging/pack-inventory.ts",
    pattern: /shipping (v[0-9]+\.[0-9]+) once carried/u,
  },
]);

type SourceMap = ReadonlyMap<string, string>;

interface VersionOccurrence {
  readonly key: string;
  readonly literal: string;
  readonly path: string;
}

interface CargoLockPackage {
  readonly name?: string;
  readonly source?: string;
  readonly version?: string;
}

function trackedFiles(): readonly string[] {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.trim()}`);
  }
  return result.stdout.split("\0").filter((path) => path.length > 0).sort();
}

function trackedFilesNamed(paths: readonly string[], basename: string): readonly string[] {
  return paths.filter((path) => path === basename || path.endsWith(`/${basename}`));
}

function rosterDifference(
  expected: readonly string[],
  observed: readonly string[],
): { readonly missing: readonly string[]; readonly unexpected: readonly string[] } {
  return {
    missing: expected.filter((value) => !observed.includes(value)),
    unexpected: observed.filter((value) => !expected.includes(value)),
  };
}

function sourcePaths(): readonly string[] {
  return [...new Set([
    ...EXPECTED_JS_MANIFESTS,
    ...EXPECTED_CARGO_MANIFESTS,
    CARGO_LOCK_PATH,
    ...EXPECTED_VERSION_SURFACE_FILES,
  ])].sort();
}

function repositorySources(): SourceMap {
  return new Map(sourcePaths().map((path) => [
    path,
    readFileSync(join(REPO_ROOT, ...path.split("/")), "utf8"),
  ]));
}

function requiredSource(sources: SourceMap, path: string): string {
  const source = sources.get(path);
  if (source === undefined) throw new Error(`release version source is missing: ${path}`);
  return source;
}

function parseJsonObject(source: string, path: string): Readonly<Record<string, unknown>> {
  const value = JSON.parse(source) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function rootVersion(sources: SourceMap): VersionContext {
  const root = parseJsonObject(requiredSource(sources, "package.json"), "package.json");
  if (typeof root.version !== "string") {
    throw new Error("package.json version must be a string");
  }
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(root.version);
  if (!match?.[1] || !match[2]) {
    throw new Error(`package.json version must be an exact release version: ${root.version}`);
  }
  return { full: root.version, series: `${match[1]}.${match[2]}` };
}

function observed(value: unknown): string {
  if (value === undefined) return "<missing>";
  return JSON.stringify(value) ?? String(value);
}

type TomlMultilineString = "basic" | "literal" | null;

interface TomlLine {
  readonly outsideValue: boolean;
  readonly source: string;
}

interface TomlTableHeader {
  readonly array: boolean;
  readonly path: string;
}

interface TomlScanState {
  readonly inlineTableDepth: number;
  readonly multiline: TomlMultilineString;
  readonly squareBracketDepth: number;
}

function tomlScanStateAfter(
  line: string,
  initial: TomlScanState,
): TomlScanState {
  let inlineTableDepth = initial.inlineTableDepth;
  let multiline = initial.multiline;
  let squareBracketDepth = initial.squareBracketDepth;
  let index = 0;
  while (index < line.length) {
    if (multiline === "basic") {
      if (line.startsWith('"""', index)) {
        multiline = null;
        index += 3;
      } else {
        index += line[index] === "\\" ? 2 : 1;
      }
      continue;
    }
    if (multiline === "literal") {
      if (line.startsWith("'''", index)) {
        multiline = null;
        index += 3;
      } else {
        index += 1;
      }
      continue;
    }

    if (line[index] === "#") break;
    if (line.startsWith('"""', index)) {
      multiline = "basic";
      index += 3;
      continue;
    }
    if (line.startsWith("'''", index)) {
      multiline = "literal";
      index += 3;
      continue;
    }
    if (line[index] === '"') {
      index += 1;
      while (index < line.length && line[index] !== '"') {
        index += line[index] === "\\" ? 2 : 1;
      }
      index += 1;
      continue;
    }
    if (line[index] === "'") {
      const closing = line.indexOf("'", index + 1);
      index = closing < 0 ? line.length : closing + 1;
      continue;
    }
    if (line[index] === "[") squareBracketDepth += 1;
    if (line[index] === "]") squareBracketDepth = Math.max(0, squareBracketDepth - 1);
    if (line[index] === "{") inlineTableDepth += 1;
    if (line[index] === "}") inlineTableDepth = Math.max(0, inlineTableDepth - 1);
    index += 1;
  }
  return Object.freeze({ inlineTableDepth, multiline, squareBracketDepth });
}

function tomlLines(source: string): readonly TomlLine[] {
  let state: TomlScanState = Object.freeze({
    inlineTableDepth: 0,
    multiline: null,
    squareBracketDepth: 0,
  });
  return source.replaceAll("\r\n", "\n").split("\n").map((line) => {
    const outsideValue = state.multiline === null
      && state.inlineTableDepth === 0
      && state.squareBracketDepth === 0;
    if (!(outsideValue && tomlTableHeader(line) !== undefined)) {
      state = tomlScanStateAfter(line, state);
    }
    return Object.freeze({ outsideValue, source: line });
  });
}

function tomlTableHeader(line: string): TomlTableHeader | undefined {
  const match = /^[ \t]*(\[\[?)([\s\S]*?)(\]\]?)[ \t]*(?:#.*)?$/u.exec(line);
  if (match === null) return undefined;
  const opener = match[1];
  const closer = match[3];
  if (opener === undefined || closer === undefined
    || (opener === "[[" && closer !== "]]")
    || (opener === "[" && closer !== "]")) return undefined;
  const path = match[2]?.trim() ?? "";
  return path === "" ? undefined : Object.freeze({ array: opener === "[[", path });
}

function decodeTomlBasicString(value: string): string | undefined {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    const escaped = value[index + 1];
    const simpleEscapes: Readonly<Record<string, string>> = {
      '"': '"', "\\": "\\", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
    };
    if (escaped !== undefined && simpleEscapes[escaped] !== undefined) {
      decoded += simpleEscapes[escaped];
      index += 1;
      continue;
    }
    if (escaped !== "u" && escaped !== "U") return undefined;
    const digitCount = escaped === "u" ? 4 : 8;
    const digits = value.slice(index + 2, index + 2 + digitCount);
    if (!new RegExp(`^[0-9A-Fa-f]{${String(digitCount)}}$`, "u").test(digits)) return undefined;
    const codePoint = Number.parseInt(digits, 16);
    if (codePoint > 0x10_FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) return undefined;
    decoded += String.fromCodePoint(codePoint);
    index += digitCount + 1;
  }
  return decoded;
}

function tomlStringValue(source: string): string | undefined {
  const value = source.trimStart();
  if (value.startsWith("'''") || value.startsWith('"""')) return undefined;
  if (value.startsWith("'")) {
    const closing = value.indexOf("'", 1);
    if (closing < 0 || !/^[ \t]*(?:#.*)?$/u.test(value.slice(closing + 1))) return undefined;
    return value.slice(1, closing);
  }
  if (!value.startsWith('"')) return undefined;
  let closing = 1;
  while (closing < value.length) {
    if (value[closing] === "\\") {
      closing += 2;
      continue;
    }
    if (value[closing] === '"') break;
    closing += 1;
  }
  if (closing >= value.length
    || !/^[ \t]*(?:#.*)?$/u.test(value.slice(closing + 1))) return undefined;
  return decodeTomlBasicString(value.slice(1, closing));
}

function tomlSimpleKey(source: string): string | undefined {
  const key = source.trim();
  return /^[A-Za-z0-9_-]+$/u.test(key) ? key : tomlStringValue(key);
}

function packageTable(source: string): string | undefined {
  const body: string[] = [];
  let collecting = false;
  for (const line of tomlLines(source)) {
    const header = line.outsideValue ? tomlTableHeader(line.source) : undefined;
    if (header !== undefined) {
      if (collecting) return body.join("\n");
      collecting = !header.array && tomlSimpleKey(header.path) === "package";
      continue;
    }
    if (collecting) body.push(line.source);
  }
  return collecting ? body.join("\n") : undefined;
}

function tomlAssignment(table: string, key: string): string | undefined {
  const pattern = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(.*)$`, "u");
  for (const line of tomlLines(table)) {
    if (!line.outsideValue) continue;
    const match = pattern.exec(line.source);
    if (match !== null) return match[1];
  }
  return undefined;
}

function tomlString(table: string, key: string): string | undefined {
  const value = tomlAssignment(table, key);
  return value === undefined ? undefined : tomlStringValue(value);
}

function tomlBoolean(table: string, key: string): boolean | undefined {
  const value = tomlAssignment(table, key);
  const match = value === undefined ? null : /^(true|false)[ \t]*(?:#.*)?$/u.exec(value);
  return match?.[1] === undefined ? undefined : match[1] === "true";
}

function cargoLockPackage(table: string): CargoLockPackage {
  const name = tomlString(table, "name");
  const version = tomlString(table, "version");
  const packageSource = tomlString(table, "source");
  return {
    ...(name === undefined ? {} : { name }),
    ...(version === undefined ? {} : { version }),
    ...(packageSource === undefined ? {} : { source: packageSource }),
  };
}

function cargoLockPackages(source: string): readonly CargoLockPackage[] {
  const packages: CargoLockPackage[] = [];
  let body: string[] | null = null;
  for (const line of tomlLines(source)) {
    const header = line.outsideValue ? tomlTableHeader(line.source) : undefined;
    if (header !== undefined) {
      if (body !== null) packages.push(cargoLockPackage(body.join("\n")));
      body = header.array && tomlSimpleKey(header.path) === "package" ? [] : null;
      continue;
    }
    if (body !== null) body.push(line.source);
  }
  if (body !== null) packages.push(cargoLockPackage(body.join("\n")));
  return packages;
}

function globalPattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}

function versionDiscoveryExcluded(path: string): boolean {
  return path.startsWith(".moe/") || path === "pnpm-lock.yaml"
    || trackedFilesNamed([path], "package.json").length === 1
    || trackedFilesNamed([path], "Cargo.toml").length === 1
    || trackedFilesNamed([path], "Cargo.lock").length === 1;
}

function trackedTextSources(): SourceMap {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const sources = new Map<string, string>();
  for (const path of trackedFiles()) {
    if (versionDiscoveryExcluded(path)) continue;
    const bytes = readFileSync(join(REPO_ROOT, ...path.split("/")));
    if (bytes.includes(0)) continue;
    try {
      sources.set(path, decoder.decode(bytes));
    } catch {
      // Binary/non-UTF-8 tracked bytes cannot contain a canonical UTF-8 release literal.
    }
  }
  return sources;
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function occurrence(path: string, index: number, literal: string): VersionOccurrence {
  return Object.freeze({ key: `${path}\0${index}\0${literal}`, literal, path });
}

function currentVersionOccurrences(
  sources: SourceMap,
  version: VersionContext,
): readonly VersionOccurrence[] {
  const literals = [
    {
      literal: version.full,
      pattern: new RegExp(
        `(?<![0-9.])${escapedPattern(version.full)}(?![0-9.])`,
        "gu",
      ),
    },
    {
      literal: `v${version.series}`,
      pattern: new RegExp(`${escapedPattern(`v${version.series}`)}(?![0-9.])`, "gu"),
    },
  ];
  return [...sources.entries()].flatMap(([path, source]) => literals.flatMap(({ pattern }) =>
    [...source.matchAll(pattern)].flatMap((match) => match.index === undefined || match[0] === ""
      ? [] : [occurrence(path, match.index, match[0])]))).sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

function declaredSurfaceOccurrences(
  sources: SourceMap,
  version: VersionContext,
): readonly VersionOccurrence[] {
  return RELEASE_VERSION_SURFACES.map((surface) => {
    const source = requiredSource(sources, surface.path);
    const matches = [...source.matchAll(globalPattern(surface.pattern))];
    if (matches.length !== 1 || matches[0]?.index === undefined) {
      throw new Error(`${surface.id}: expected exactly one structural release-version match`);
    }
    const literal = surface.version === "full" ? version.full : `v${version.series}`;
    const localIndex = matches[0][0].indexOf(literal);
    if (localIndex < 0) {
      throw new Error(`${surface.id}: structural match does not contain ${literal}`);
    }
    return occurrence(surface.path, matches[0].index + localIndex, literal);
  }).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

function excludedVersionOccurrences(
  sources: SourceMap,
  version: VersionContext,
): readonly VersionOccurrence[] {
  const currentLiterals = new Set([version.full, `v${version.series}`]);
  return VERSION_OCCURRENCE_EXCLUSIONS.flatMap((exclusion) => {
    const source = requiredSource(sources, exclusion.path);
    const captures = [...source.matchAll(globalPattern(exclusion.pattern))].flatMap((match) => {
      const literal = match[1];
      if (match.index === undefined || literal === undefined || !currentLiterals.has(literal)) {
        return [];
      }
      const localIndex = match[0].indexOf(literal);
      return localIndex < 0 ? [] : [occurrence(exclusion.path, match.index + localIndex, literal)];
    });
    if (captures.length !== exclusion.expectedCurrentCaptureCount) {
      const captureWord = exclusion.expectedCurrentCaptureCount === 1 ? "capture" : "captures";
      throw new Error(
        `${exclusion.id}: expected exactly ${String(exclusion.expectedCurrentCaptureCount)}`
        + ` current-version ${captureWord}; observed ${String(captures.length)}`,
      );
    }
    return captures;
  }).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

function validateReleaseVersionSources(sources: SourceMap): readonly string[] {
  const issues: string[] = [];
  const version = rootVersion(sources);

  for (const path of EXPECTED_JS_MANIFESTS) {
    const manifest = parseJsonObject(requiredSource(sources, path), path);
    if (manifest.version !== version.full) {
      issues.push(`${path}: version must equal root ${version.full}; observed ${observed(manifest.version)}`);
    }
    if (manifest.private !== true) {
      issues.push(`${path}: private must be true; observed ${observed(manifest.private)}`);
    }
  }

  for (const cargoPackage of CARGO_PACKAGES) {
    const table = packageTable(requiredSource(sources, cargoPackage.path));
    if (table === undefined) {
      issues.push(`${cargoPackage.path}: [package] table is missing`);
      continue;
    }
    const name = tomlString(table, "name");
    const packageVersion = tomlString(table, "version");
    const publish = tomlBoolean(table, "publish");
    if (name !== cargoPackage.name) {
      issues.push(
        `${cargoPackage.path}: package.name must be ${cargoPackage.name}; observed ${observed(name)}`,
      );
    }
    if (packageVersion !== version.full) {
      issues.push(
        `${cargoPackage.path}: package.version must equal root ${version.full}; observed ${observed(packageVersion)}`,
      );
    }
    if (publish !== false) {
      issues.push(
        `${cargoPackage.path}: package.publish must be false; observed ${observed(publish)}`,
      );
    }
  }

  const internalLockRows = cargoLockPackages(requiredSource(sources, CARGO_LOCK_PATH))
    .filter((row) => row.source === undefined);
  for (const row of internalLockRows) {
    if (row.name === undefined) {
      issues.push(`${CARGO_LOCK_PATH}: source-free package row is missing name`);
    }
    if (row.version === undefined) {
      issues.push(`${CARGO_LOCK_PATH}: source-free package row is missing version`);
    }
  }
  const lockNames = internalLockRows.flatMap(({ name }) => name === undefined ? [] : [name]).sort();
  const lockRoster = rosterDifference(EXPECTED_INTERNAL_CARGO_LOCK_ROWS, lockNames);
  for (const name of lockRoster.missing) {
    issues.push(`${CARGO_LOCK_PATH}: internal package row is missing: ${name}`);
  }
  for (const name of lockRoster.unexpected) {
    issues.push(`${CARGO_LOCK_PATH}: unexpected internal package row: ${name}`);
  }
  for (const cargoPackage of CARGO_PACKAGES) {
    const matchingRows = internalLockRows.filter(({ name }) => name === cargoPackage.name);
    if (matchingRows.length !== 1) {
      issues.push(
        `${CARGO_LOCK_PATH}: ${cargoPackage.name} must have exactly one internal row; observed ${matchingRows.length}`,
      );
      continue;
    }
    const lockVersion = matchingRows[0]?.version;
    if (lockVersion !== version.full) {
      issues.push(
        `${CARGO_LOCK_PATH}: ${cargoPackage.name} version must equal root ${version.full}; observed ${observed(lockVersion)}`,
      );
    }
  }

  for (const surface of RELEASE_VERSION_SURFACES) {
    const source = requiredSource(sources, surface.path);
    const matches = [...source.matchAll(globalPattern(surface.pattern))];
    if (matches.length !== 1) {
      issues.push(
        `${surface.id} (${surface.path}): structural match count must be 1; observed ${matches.length}`,
      );
      continue;
    }
    const surfaceVersion = matches[0]?.[1];
    const expectedVersion = version[surface.version];
    if (surfaceVersion !== expectedVersion) {
      issues.push(
        `${surface.id} (${surface.path}): version must equal ${expectedVersion}; observed ${observed(surfaceVersion)}`,
      );
    }
  }

  return issues;
}

function mutatedOnce(sources: SourceMap, path: string, from: string, to: string): SourceMap {
  const source = requiredSource(sources, path);
  const first = source.indexOf(from);
  if (first < 0 || source.indexOf(from, first + from.length) >= 0) {
    throw new Error(`mutation target must occur exactly once in ${path}: ${from}`);
  }
  return new Map(sources).set(path, `${source.slice(0, first)}${to}${source.slice(first + from.length)}`);
}

function wrongFullVersion(version: VersionContext): string {
  return version.full === "999.999.999" ? "998.998.998" : "999.999.999";
}

function wrongSeriesVersion(version: VersionContext): string {
  return version.series === "999.999" ? "998.998" : "999.999";
}

describe("release version surfaces", () => {
  it("pins the exact nonempty tracked JavaScript manifest roster in both directions", () => {
    const observedManifests = trackedFilesNamed(trackedFiles(), "package.json");
    const difference = rosterDifference(EXPECTED_JS_MANIFESTS, observedManifests);

    expect(EXPECTED_JS_MANIFESTS.length).toBe(20);
    expect(observedManifests.length).toBeGreaterThan(0);
    expect(new Set(observedManifests).size).toBe(observedManifests.length);
    expect(difference.missing, "tracked JavaScript manifests missing from the release roster")
      .toEqual([]);
    expect(difference.unexpected, "tracked JavaScript manifests absent from the release roster")
      .toEqual([]);
  });

  it("pins the exact nonempty tracked native Cargo manifest and lock rosters", () => {
    const tracked = trackedFiles();
    const observedManifests = trackedFilesNamed(tracked, "Cargo.toml");
    const observedLocks = trackedFilesNamed(tracked, "Cargo.lock");
    const manifestDifference = rosterDifference(EXPECTED_CARGO_MANIFESTS, observedManifests);
    const lockDifference = rosterDifference(EXPECTED_CARGO_LOCKS, observedLocks);

    expect(EXPECTED_CARGO_MANIFESTS.length).toBe(2);
    expect(observedManifests.length).toBeGreaterThan(0);
    expect(manifestDifference.missing, "tracked Cargo manifests missing from the release roster")
      .toEqual([]);
    expect(manifestDifference.unexpected, "tracked Cargo manifests absent from the release roster")
      .toEqual([]);
    expect(EXPECTED_CARGO_LOCKS.length).toBe(1);
    expect(observedLocks.length).toBeGreaterThan(0);
    expect(lockDifference.missing, "tracked Cargo locks missing from the release roster").toEqual([]);
    expect(lockDifference.unexpected, "tracked Cargo locks absent from the release roster").toEqual([]);
  });

  it("recognizes repository-root and nested Cargo files during tracked discovery", () => {
    const candidates = [
      "Cargo.lock", "Cargo.toml", "native/Cargo.lock", "native/Cargo.toml", "not-cargo.txt",
    ];

    expect(trackedFilesNamed(candidates, "Cargo.toml"))
      .toStrictEqual(["Cargo.toml", "native/Cargo.toml"]);
    expect(trackedFilesNamed(candidates, "Cargo.lock"))
      .toStrictEqual(["Cargo.lock", "native/Cargo.lock"]);
  });

  it("pins the exact nonempty internal Cargo.lock package roster in both directions", () => {
    const lockPackages = cargoLockPackages(readFileSync(join(REPO_ROOT, ...CARGO_LOCK_PATH.split("/")), "utf8"));
    const internalRows = lockPackages.filter(({ source }) => source === undefined);
    const internalNames = internalRows
      .flatMap(({ name }) => name === undefined ? [] : [name])
      .sort();
    const difference = rosterDifference(EXPECTED_INTERNAL_CARGO_LOCK_ROWS, internalNames);

    expect(EXPECTED_INTERNAL_CARGO_LOCK_ROWS.length).toBe(2);
    expect(internalRows.every(({ name, version }) => name !== undefined && version !== undefined))
      .toBe(true);
    expect(internalNames.length).toBeGreaterThan(0);
    expect(new Set(internalNames).size).toBe(internalNames.length);
    expect(difference.missing, "internal Cargo.lock rows missing from the release roster").toEqual([]);
    expect(difference.unexpected, "internal Cargo.lock rows absent from the release roster").toEqual([]);
  });

  it("maps every declared release version surface onto the seven reviewed source files", () => {
    const observedFiles = [...new Set(RELEASE_VERSION_SURFACES.map(({ path }) => path))].sort();
    const difference = rosterDifference(EXPECTED_VERSION_SURFACE_FILES, observedFiles);

    expect(RELEASE_VERSION_SURFACES.length).toBe(11);
    expect(observedFiles.length).toBeGreaterThan(0);
    expect(difference.missing, "release version files without a structural observation").toEqual([]);
    expect(difference.unexpected, "structural version observations outside the public roster")
      .toEqual([]);
  });

  it("discovers the exact nonempty current-version occurrence set in both directions", () => {
    const sources = trackedTextSources();
    const version = rootVersion(repositorySources());
    const discovered = currentVersionOccurrences(sources, version);
    const surfaces = declaredSurfaceOccurrences(sources, version);
    const exclusions = excludedVersionOccurrences(sources, version);
    const declared = [...surfaces, ...exclusions].sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    const difference = rosterDifference(
      declared.map(({ key }) => key),
      discovered.map(({ key }) => key),
    );

    expect(VERSION_OCCURRENCE_EXCLUSIONS.length).toBe(8);
    for (const exclusion of VERSION_OCCURRENCE_EXCLUSIONS) {
      expect(exclusion.expectedCurrentCaptureCount, `empty exclusion: ${exclusion.id}`)
        .toBeGreaterThan(0);
    }
    expect(surfaces.length).toBe(11);
    expect(exclusions.length).toBe(12);
    expect(discovered.length).toBeGreaterThan(0);
    expect(new Set(discovered.map(({ key }) => key)).size).toBe(discovered.length);
    expect(new Set(declared.map(({ key }) => key)).size).toBe(declared.length);
    expect(difference.missing, "declared surface/exclusion absent from tracked content").toEqual([]);
    expect(difference.unexpected, "unclassified tracked current-version occurrence").toEqual([]);
  });

  it("goes red for an unclassified tracked current-version occurrence", () => {
    const sources = trackedTextSources();
    const version = rootVersion(repositorySources());
    const path = "README.md";
    const mutated = new Map(sources).set(
      path,
      `${requiredSource(sources, path)}\nUnclassified release ${version.full}\n`,
    );
    const declaredKeys = new Set([
      ...declaredSurfaceOccurrences(mutated, version),
      ...excludedVersionOccurrences(mutated, version),
    ].map(({ key }) => key));
    const unclassified = currentVersionOccurrences(mutated, version)
      .filter(({ key }) => !declaredKeys.has(key));

    expect(unclassified).toMatchObject([{ literal: version.full, path }]);
  });

  it("refuses a newly auto-admitted current-version occurrence behind an existing exclusion", () => {
    const sources = trackedTextSources();
    const version = rootVersion(repositorySources());
    const path = "apps/daemon/src/cli/moe-cli-main.test.ts";
    const mutated = new Map(sources).set(
      path,
      `${requiredSource(sources, path)}\nconst newlyUnreviewedFixture = "${version.full}";\n`,
    );

    expect(() => excludedVersionOccurrences(mutated, version)).toThrowError(
      "cli-main-injected-version-fixtures: expected exactly 4 current-version captures; observed 5",
    );
  });

  it("refuses a stale exclusion that contributes no current-version occurrence", () => {
    const sources = trackedTextSources();
    const version = rootVersion(repositorySources());
    const futureVersion = {
      full: wrongFullVersion(version),
      series: wrongSeriesVersion(version),
    };

    expect(() => excludedVersionOccurrences(sources, futureVersion)).toThrowError(
      "in-toto-release-predicate-schema: expected exactly 1 current-version capture; observed 0",
    );
  });

  it("keeps every private manifest and release version surface aligned with the root version", () => {
    expect(validateReleaseVersionSources(repositorySources())).toEqual([]);
  });

  it("goes red when a JavaScript package version diverges", () => {
    const sources = repositorySources();
    const version = rootVersion(sources);
    const wrongVersion = wrongFullVersion(version);
    const path = "packages/core/package.json";
    const mutated = mutatedOnce(
      sources,
      path,
      `"version": "${version.full}"`,
      `"version": "${wrongVersion}"`,
    );

    expect(validateReleaseVersionSources(mutated)).toContain(
      `${path}: version must equal root ${version.full}; observed "${wrongVersion}"`,
    );
  });

  it("goes red when a JavaScript package becomes publishable", () => {
    const sources = repositorySources();
    const path = "packages/core/package.json";
    const mutated = mutatedOnce(sources, path, `"private": true`, `"private": false`);

    expect(validateReleaseVersionSources(mutated)).toContain(
      `${path}: private must be true; observed false`,
    );
  });

  it("goes red when a native package version diverges", () => {
    const sources = repositorySources();
    const version = rootVersion(sources);
    const wrongVersion = wrongFullVersion(version);
    const path = "packages/runner/src/platform/windows/native/broker/Cargo.toml";
    const mutated = mutatedOnce(
      sources,
      path,
      `version = "${version.full}"`,
      `version = "${wrongVersion}"`,
    );

    expect(validateReleaseVersionSources(mutated)).toContain(
      `${path}: package.version must equal root ${version.full}; observed "${wrongVersion}"`,
    );
  });

  it("goes red when a native package becomes publishable", () => {
    const sources = repositorySources();
    const path = "packages/runner/src/platform/windows/native/broker/Cargo.toml";
    const mutated = mutatedOnce(sources, path, "publish = false", "publish = true");

    expect(validateReleaseVersionSources(mutated)).toContain(
      `${path}: package.publish must be false; observed true`,
    );
  });

  it("accepts a legally decorated Cargo.toml package header", () => {
    const sources = repositorySources();
    const path = "packages/runner/src/platform/windows/native/broker/Cargo.toml";
    const mutated = mutatedOnce(
      sources,
      path,
      "[package]",
      "  [ package ] # legal TOML table decoration",
    );

    expect(validateReleaseVersionSources(mutated)).toEqual([]);
  });

  it("accepts literal TOML strings for native package identity and version", () => {
    const sources = repositorySources();
    const version = rootVersion(sources);
    const path = "packages/runner/src/platform/windows/native/broker/Cargo.toml";
    const packageName = "moe-windows-job-broker";
    const withLiteralName = mutatedOnce(
      sources,
      path,
      `name = "${packageName}"`,
      `  name = '${packageName}' # legal literal string`,
    );
    const mutated = mutatedOnce(
      withLiteralName,
      path,
      `version = "${version.full}"`,
      `  version = '${version.full}' # legal literal string`,
    );

    expect(validateReleaseVersionSources(mutated)).toEqual([]);
  });

  it("does not borrow a package version from inside a multiline TOML string", () => {
    const sources = repositorySources();
    const version = rootVersion(sources);
    const path = "packages/runner/src/platform/windows/native/broker/Cargo.toml";
    const mutated = mutatedOnce(
      sources,
      path,
      `version = "${version.full}"`,
      `description = """\nversion = "${version.full}"\n"""`,
    );

    expect(validateReleaseVersionSources(mutated)).toContain(
      `${path}: package.version must equal root ${version.full}; observed <missing>`,
    );
  });

  it("does not treat a nested array value as a Cargo.toml package header", () => {
    const sources = repositorySources();
    const path = "packages/runner/src/platform/windows/native/broker/Cargo.toml";
    const mutated = mutatedOnce(
      sources,
      path,
      "[package]",
      "[workspace.metadata]\nprobe = [\n  [\"package\"]\n]\n\n[package]",
    );

    expect(validateReleaseVersionSources(mutated)).toEqual([]);
  });

  it("goes red when an internal Cargo.lock package version diverges", () => {
    const sources = repositorySources();
    const version = rootVersion(sources);
    const wrongVersion = wrongFullVersion(version);
    const lockSource = requiredSource(sources, CARGO_LOCK_PATH);
    const newline = lockSource.includes("\r\n") ? "\r\n" : "\n";
    const packageName = "moe-windows-job-core";
    const mutated = mutatedOnce(
      sources,
      CARGO_LOCK_PATH,
      `name = "${packageName}"${newline}version = "${version.full}"`,
      `name = "${packageName}"${newline}version = "${wrongVersion}"`,
    );

    expect(validateReleaseVersionSources(mutated)).toContain(
      `${CARGO_LOCK_PATH}: ${packageName} version must equal root ${version.full}; observed "${wrongVersion}"`,
    );
  });

  it("accepts literal Cargo.lock source strings without classifying registry rows as internal", () => {
    const sources = repositorySources();
    const lockSource = requiredSource(sources, CARGO_LOCK_PATH);
    const basicSource = 'source = "registry+https://github.com/rust-lang/crates.io-index"';
    const literalSource = "source = 'registry+https://github.com/rust-lang/crates.io-index'";
    const mutatedSource = lockSource.replaceAll(basicSource, literalSource);
    expect(mutatedSource).not.toBe(lockSource);
    const mutated = new Map(sources).set(CARGO_LOCK_PATH, mutatedSource);

    expect(validateReleaseVersionSources(mutated)).toEqual([]);
  });

  it("goes red for an unexpected internal row behind a legal decorated Cargo.lock header", () => {
    const sources = repositorySources();
    const version = rootVersion(sources);
    const lockSource = requiredSource(sources, CARGO_LOCK_PATH);
    const mutated = new Map(sources).set(CARGO_LOCK_PATH, `${lockSource}\n`
      + `[[package]]   # legal Cargo.lock table comment\n`
      + `name = "moe-unexpected-internal"\nversion = "${version.full}"\n`);

    expect(validateReleaseVersionSources(mutated)).toContain(
      `${CARGO_LOCK_PATH}: unexpected internal package row: moe-unexpected-internal`,
    );
  });

  it.each([
    ["indented", "  [[package]]"],
    ["inner-spaced", "[[ package ]]"],
  ])("goes red for an unexpected internal row behind a legal %s Cargo.lock header", (
    _name,
    header,
  ) => {
    const sources = repositorySources();
    const version = rootVersion(sources);
    const lockSource = requiredSource(sources, CARGO_LOCK_PATH);
    const mutated = new Map(sources).set(CARGO_LOCK_PATH, `${lockSource}\n`
      + `${header} # legal Cargo.lock table decoration\n`
      + `name = "moe-unexpected-internal"\nversion = "${version.full}"\n`);

    expect(validateReleaseVersionSources(mutated)).toContain(
      `${CARGO_LOCK_PATH}: unexpected internal package row: moe-unexpected-internal`,
    );
  });

  it("goes red for a duplicate expected source-free Cargo.lock row", () => {
    const sources = repositorySources();
    const version = rootVersion(sources);
    const lockSource = requiredSource(sources, CARGO_LOCK_PATH);
    const packageName = "moe-windows-job-core";
    const mutated = new Map(sources).set(CARGO_LOCK_PATH, `${lockSource}\n`
      + `[[package]]\nname = "${packageName}"\nversion = "${version.full}"\n`);

    expect(validateReleaseVersionSources(mutated)).toContain(
      `${CARGO_LOCK_PATH}: ${packageName} must have exactly one internal row; observed 2`,
    );
  });

  it("goes red for a nameless source-free Cargo.lock row", () => {
    const sources = repositorySources();
    const version = rootVersion(sources);
    const lockSource = requiredSource(sources, CARGO_LOCK_PATH);
    const mutated = new Map(sources).set(CARGO_LOCK_PATH, `${lockSource}\n`
      + `[[package]]\nversion = "${version.full}"\n`);

    expect(validateReleaseVersionSources(mutated)).toContain(
      `${CARGO_LOCK_PATH}: source-free package row is missing name`,
    );
  });

  it("goes red for a versionless source-free Cargo.lock row", () => {
    const sources = repositorySources();
    const lockSource = requiredSource(sources, CARGO_LOCK_PATH);
    const mutated = new Map(sources).set(CARGO_LOCK_PATH, `${lockSource}\n`
      + `[[package]]\nname = "moe-versionless-internal"\n`);

    expect(validateReleaseVersionSources(mutated)).toContain(
      `${CARGO_LOCK_PATH}: source-free package row is missing version`,
    );
  });

  it("goes red when a public version surface diverges", () => {
    const sources = repositorySources();
    const version = rootVersion(sources);
    const wrongVersion = wrongSeriesVersion(version);
    const path = "apps/control-room/src/v2/shell/nav-rail.tsx";
    const mutated = mutatedOnce(sources, path, `>v${version.series}<`, `>v${wrongVersion}<`);

    expect(validateReleaseVersionSources(mutated)).toContain(
      `control-room-nav-series (${path}): version must equal ${version.series}; observed "${wrongVersion}"`,
    );
  });

  it("goes red when the trusted-workspace README release prose diverges", () => {
    const sources = repositorySources();
    const version = rootVersion(sources);
    const wrongVersion = wrongSeriesVersion(version);
    const path = "README.md";
    const mutated = mutatedOnce(
      sources,
      path,
      `for v${version.series} it ships`,
      `for v${wrongVersion} it ships`,
    );

    expect(validateReleaseVersionSources(mutated)).toContain(
      `readme-trusted-workspace-series (${path}): version must equal ${version.series}; observed "${wrongVersion}"`,
    );
  });

  it.each(["00.1.0", "0.01.0", "0.1.00"])(
    "refuses a root release version with a leading-zero component: %s",
    (invalidVersion) => {
      const sources = repositorySources();
      const version = rootVersion(sources);
      const mutated = mutatedOnce(
        sources,
        "package.json",
        `"version": "${version.full}"`,
        `"version": "${invalidVersion}"`,
      );

      expect(() => validateReleaseVersionSources(mutated)).toThrowError(
        `package.json version must be an exact release version: ${invalidVersion}`,
      );
    },
  );
});
