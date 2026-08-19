/**
 * The Windows pack's INVENTORY GATE, kept pure over a path list so the rules are
 * unit-testable without building a 30 MB tree.
 *
 * Everything here answers one question: is this staging directory something we
 * would hand a stranger? A dev dependency, a test fixture, a `.git` directory or
 * a lost `.js` bridge each turns a shippable artifact into a liability, and each
 * gets its own code so the operator fixes the right thing.
 *
 * This module has NO runtime imports by design, so it loads under plain Node.
 */

export const PACK_REQUIRED_PATH_MISSING = "PACK_REQUIRED_PATH_MISSING" as const;
export const PACK_TEST_ARTIFACT_PRESENT = "PACK_TEST_ARTIFACT_PRESENT" as const;
export const PACK_VCS_ARTIFACT_PRESENT = "PACK_VCS_ARTIFACT_PRESENT" as const;
export const PACK_DEV_DEPENDENCY_PRESENT = "PACK_DEV_DEPENDENCY_PRESENT" as const;
export const PACK_BRIDGE_MISSING = "PACK_BRIDGE_MISSING" as const;
export const PACK_WORKTREE_DIRTY = "PACK_WORKTREE_DIRTY" as const;
export const PACK_DANGLING_IMPORT = "PACK_DANGLING_IMPORT" as const;
export const PACK_DEV_DEPENDENCY_IMPORT = "PACK_DEV_DEPENDENCY_IMPORT" as const;

export type PackRefusalCode =
  | typeof PACK_BRIDGE_MISSING
  | typeof PACK_DANGLING_IMPORT
  | typeof PACK_DEV_DEPENDENCY_IMPORT
  | typeof PACK_DEV_DEPENDENCY_PRESENT
  | typeof PACK_REQUIRED_PATH_MISSING
  | typeof PACK_TEST_ARTIFACT_PRESENT
  | typeof PACK_VCS_ARTIFACT_PRESENT
  | typeof PACK_WORKTREE_DIRTY;

export interface PackRefusal {
  readonly code: PackRefusalCode;
  /** The EXACT path or package that was refused. */
  readonly detail: string;
  readonly message: string;
}

export interface PackInventoryInput {
  /**
   * `<file> -> <specifier>` for a shipped source whose relative import resolves to
   * nothing in the staging tree. This is what proves the prune left the artifact
   * LOADABLE: a fixture deleted out from under a surviving `export *` bridge is
   * `ERR_MODULE_NOT_FOUND` in the operator's terminal, not a lint opinion.
   */
  readonly danglingImports: readonly string[];
  /** Every dev-only package name in the workspace; none may appear in node_modules. */
  readonly devDependencies: readonly string[];
  /** `<file> -> <package>` for a shipped source importing a dev-only package. */
  readonly devDependencyImports: readonly string[];
  /** Staged-relative `.js` bridges the SOURCE tree offers, so a lost one is visible. */
  readonly expectedBridges: readonly string[];
  /** Every staged file, forward-slash, relative to the staging root. */
  readonly paths: readonly string[];
}

export interface PackInventoryAdmitted {
  readonly fileCount: number;
  readonly ok: true;
}

export interface PackInventoryRefused {
  readonly ok: false;
  readonly refusals: readonly PackRefusal[];
}

export type PackInventoryResult = PackInventoryAdmitted | PackInventoryRefused;

/**
 * What a usable artifact must contain. `moe.cmd` and `moe.ps1` are here because a
 * zip whose only entry point is a `src/` path is not an install, it is a puzzle;
 * `moe-workspace-links.json` is here because without it `moe start` links nothing
 * and every workspace import fails at resolution.
 */
export const REQUIRED_STAGED_PATHS = Object.freeze([
  "INSTALL.md",
  "LICENSE",
  "MANIFEST-CLOSURE.txt",
  "apps/daemon/package.json",
  "apps/daemon/src/cli/moe-cli-main.ts",
  "apps/daemon/src/daemon-main.ts",
  "apps/daemon/src/orchestrator/agent-wrapper-main.ts",
  "apps/daemon/src/orchestrator/moe-up-main.ts",
  "control-room/index.html",
  "moe-workspace-links.json",
  "moe.cmd",
  "moe.ps1",
]);

/**
 * `*.test.ts` alone is NOT enough, and neither was the suffix LIST that replaced
 * it: shipping v0.1 once carried 25 of this repo's own test artifacts past a gate
 * whose only case was `claude-launcher-test-fixtures.ts`. Three near-misses did it
 * — `-test-fixtures.ts` never matches a file NAMED `test-fixtures.ts`, bare
 * `-fixtures.ts` has no "test" in it at all, and `-test-harness.ts` sat one
 * character from the listed `-test-helpers.ts`. Rules over a whole basename, not
 * a suffix table, because adjacency to a correct entry is not coverage.
 */
const TEST_BASENAME_RULES = Object.freeze([
  /\.(test|spec)\.(ts|tsx|mts|cts|js|mjs|cjs)$/u,
  /(^|[.\-_])fixtures?\.(ts|tsx|mts|cts|js|mjs|cjs)$/u,
  /(^|[.\-_])harness\.(ts|tsx|mts|cts|js|mjs|cjs)$/u,
  /(^|[.\-_])test-(helpers?|data|utils?)\.(ts|tsx|mts|cts|js|mjs|cjs)$/u,
  /\.tsbuildinfo$/u,
]);

/** A DIRECTORY segment, never a substring: `native/src/spec.rs` is production Rust. */
const TEST_SEGMENTS = Object.freeze(["__tests__", "__mocks__", "test", "tests"]);

/**
 * Test support whose FILENAME says nothing. Each was measured on 2026-08-19 by
 * listing every importer: all of them are `*.test.ts` files or each other, none
 * is reachable from production. They are named individually rather than by a
 * broader rule because "race", "scenarios" and "drivers" are ordinary words that
 * production code is entitled to use.
 *
 * This list cannot go quietly stale in either direction: `inspectStagedTree`
 * refuses a shipped source whose relative import lost its target, so an entry
 * MISSING here stops the pack, and the sweep test asserts each entry still
 * resolves to a file on disk.
 */
const TEST_SUPPORT_STEMS = Object.freeze([
  "src/dispatch-conformance",
  "src/planning/planning-invariant-drivers",
  "src/projections/projection-crash-worker",
  "src/supervisor/race-restart-scenarios",
  "src/supervisor/race-scenarios",
  "src/supervisor/race-steps",
  "src/supervisor/race-world",
  "src/work/work-race-drift-table",
  "src/work/work-race-schedule",
  "src/work/work-race-world",
]);

const SOURCE_EXTENSION = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/u;

function refuse(code: PackRefusalCode, detail: string): PackRefusal {
  return Object.freeze({ code, detail, message: `${code}: ${detail}` });
}

/** `node_modules/a/...` -> `a`; `node_modules/@s/a/...` -> `@s/a`; otherwise null. */
export function installedPackageOf(path: string): string | null {
  const segments = path.split("/");
  const index = segments.lastIndexOf("node_modules");
  if (index < 0) return null;
  const first = segments[index + 1];
  if (first === undefined || first.startsWith(".")) return null;
  if (!first.startsWith("@")) return first;
  const second = segments[index + 2];
  return second === undefined ? null : `${first}/${second}`;
}

/**
 * Shared with the pack script's prune pass so the gate and the prune agree.
 *
 * VENDORED bytes are exempt on purpose. `node_modules` here is whatever `pnpm
 * deploy` produced, and the DoD clause beside "no tests" requires that closure be
 * preserved; deleting `fast-uri/test/*.test.js` out of a published package would
 * satisfy one half of the clause by breaking the other.
 */
export function isTestArtifact(path: string): boolean {
  const segments = path.split("/");
  if (segments.includes("node_modules")) return false;
  if (segments.slice(0, -1).some((segment) => TEST_SEGMENTS.includes(segment))) return true;
  if (TEST_BASENAME_RULES.some((rule) => rule.test(segments.at(-1) ?? ""))) return true;
  const stem = path.replace(SOURCE_EXTENSION, "");
  return TEST_SUPPORT_STEMS.some((support) => stem === support || stem.endsWith(`/${support}`));
}

export function inspectStagedTree(input: PackInventoryInput): PackInventoryResult {
  const present = new Set(input.paths);
  const dev = new Set(input.devDependencies);
  const refusals: PackRefusal[] = [];

  for (const required of REQUIRED_STAGED_PATHS) {
    if (!present.has(required)) refusals.push(refuse(PACK_REQUIRED_PATH_MISSING, required));
  }
  for (const path of input.paths) {
    if (isTestArtifact(path)) refusals.push(refuse(PACK_TEST_ARTIFACT_PRESENT, path));
    if (path.split("/").includes(".git")) refusals.push(refuse(PACK_VCS_ARTIFACT_PRESENT, path));
  }
  // Reported once per package, not once per file: a shipped `vitest` is one fault
  // with 900 files, and 900 refusals would bury the eight that matter.
  const offendingPackages = new Set<string>();
  for (const path of input.paths) {
    const installed = installedPackageOf(path);
    if (installed !== null && dev.has(installed)) offendingPackages.add(installed);
  }
  for (const name of [...offendingPackages].sort()) {
    refusals.push(refuse(PACK_DEV_DEPENDENCY_PRESENT, name));
  }
  for (const bridge of input.expectedBridges) {
    if (!present.has(bridge)) refusals.push(refuse(PACK_BRIDGE_MISSING, bridge));
  }
  for (const edge of input.danglingImports) refusals.push(refuse(PACK_DANGLING_IMPORT, edge));
  for (const edge of input.devDependencyImports) {
    refusals.push(refuse(PACK_DEV_DEPENDENCY_IMPORT, edge));
  }

  if (refusals.length > 0) return Object.freeze({ ok: false, refusals: Object.freeze(refusals) });
  return Object.freeze({ fileCount: input.paths.length, ok: true });
}

/** `git status --porcelain` codes are two columns; the path starts at column 3. */
function porcelainPath(line: string): string {
  const raw = line.slice(3).trim();
  // A rename reports `origin -> destination`; the DESTINATION is what would ship.
  const arrow = raw.lastIndexOf(" -> ");
  const path = arrow < 0 ? raw : raw.slice(arrow + 4);
  return path.replace(/^"|"$/gu, "").replaceAll("\\", "/");
}

/**
 * Six agents share this worktree, so it WILL be dirty. Refusing is the pinned
 * policy: a zip that quietly carries a peer's uncommitted bytes is forged
 * evidence about what the release commit contains.
 */
export function inspectWorktree(
  porcelain: readonly string[], shippedPrefixes: readonly string[],
): PackRefusal | null {
  const dirty = porcelain
    .filter((line) => line.trim() !== "")
    .map(porcelainPath)
    .filter((path) => shippedPrefixes.some(
      (prefix) => path === prefix || path.startsWith(prefix),
    ))
    .sort();
  if (dirty.length === 0) return null;
  return refuse(PACK_WORKTREE_DIRTY, dirty.join(", "));
}
