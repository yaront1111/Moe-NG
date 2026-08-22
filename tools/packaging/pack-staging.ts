import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { isTestArtifact } from "./pack-inventory.js";

/**
 * Filesystem shaping for the Windows pack. Kept apart from `pack-windows.ts` so
 * the pipeline reads as a pipeline and each tree operation stays one small,
 * inspectable function.
 *
 * Every path this module returns is FORWARD-SLASH and relative to the root it
 * was given: the inventory gate compares against literals, and a `\` would make
 * every one of them miss on the platform this artifact targets.
 */

export interface WorkspacePackage {
  readonly name: string;
  /** Repo-relative, forward-slash, e.g. `packages/store`. */
  readonly sourceDir: string;
}

/** Every file under `root`, relative and forward-slash, depth-first and sorted. */
export function walkFiles(root: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort(
    (a, b) => (a.name < b.name ? -1 : 1),
  )) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walkFiles(join(root, entry.name), relativePath));
    else found.push(relativePath);
  }
  return found;
}

/**
 * Deletes what must never ship, using the SAME predicate the inventory gate
 * applies. Two predicates would let the prune drift from the gate and leave the
 * gate asserting a rule nothing enforces.
 */
export function pruneTestArtifacts(root: string): readonly string[] {
  const removed = walkFiles(root).filter(isTestArtifact);
  for (const path of removed) rmSync(join(root, path), { force: true });
  return removed;
}

/**
 * `Compress-Archive` stores directory entries, so a `tests/` folder emptied by the
 * prune still appears in the zip listing — the reviewer who opens the artifact
 * reads that as shipped tests. Bottom-up, and it reports what it removed rather
 * than swallowing the count.
 */
export function removeEmptyDirectories(root: string): readonly string[] {
  const removed: string[] = [];
  const visit = (directory: string, relativePath: string): boolean => {
    let empty = true;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      const childPath = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
      if (!entry.isDirectory()) empty = false;
      else if (visit(child, childPath)) removed.push(childPath);
      else empty = false;
    }
    return empty;
  };
  if (visit(root, "")) return Object.freeze([]);
  for (const path of removed) rmSync(join(root, path), { force: true, recursive: true });
  return Object.freeze(removed.sort());
}

function manifestName(directory: string): string | null {
  const manifest = join(directory, "package.json");
  if (!existsSync(manifest)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

/**
 * Where each workspace package lives IN THE REPO, discovered rather than
 * transcribed: `@moe/ide-adapter-contract` lives at `adapters/ide-contract`, and
 * a name-to-directory guess is exactly how a pack ships the wrong tree.
 */
export function findWorkspacePackages(repoRoot: string): readonly WorkspacePackage[] {
  const found: WorkspacePackage[] = [];
  for (const group of ["apps", "adapters", "packages"]) {
    const groupDir = join(repoRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = manifestName(join(groupDir, entry.name));
      if (name !== null) found.push({ name, sourceDir: `${group}/${entry.name}` });
    }
  }
  return Object.freeze(found.sort((a, b) => (a.name < b.name ? -1 : 1)));
}

/**
 * The `.js` bridges the SOURCE offers for one package, expressed as staged paths.
 *
 * Read from the source tree on purpose. Deriving the expectation from the staging
 * tree would make the check vacuous: a bridge deleted from staging would simply
 * stop being expected, and the gate would pass while the artifact could not
 * resolve a single `./x.js` import.
 */
export function collectSourceBridges(
  repoRoot: string, sourceDir: string, stagedPrefix: string,
): readonly string[] {
  const absolute = join(repoRoot, sourceDir);
  if (!existsSync(absolute)) return Object.freeze([]);
  const bridges = walkFiles(absolute)
    .filter((path) => !path.startsWith("node_modules/"))
    .filter((path) => path.endsWith(".js") && !isTestArtifact(path))
    .map((path) => `${stagedPrefix}/${path}`);
  return Object.freeze(bridges);
}

/** Every dev-only package name declared anywhere in the workspace, plus the root's. */
export function collectDevDependencies(
  repoRoot: string, workspace: readonly WorkspacePackage[],
): readonly string[] {
  const names = new Set<string>();
  const manifests = [join(repoRoot, "package.json"),
    ...workspace.map((entry) => join(repoRoot, entry.sourceDir, "package.json"))];
  for (const manifest of manifests) {
    if (!existsSync(manifest)) continue;
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    for (const name of Object.keys(parsed.devDependencies ?? {})) names.add(name);
  }
  return Object.freeze([...names].sort());
}

export interface ClosureEntry {
  readonly name: string;
  readonly version: string;
}

/**
 * The external closure, read out of the staged tree itself. `MANIFEST-CLOSURE.txt`
 * exists so the audit surface travels WITH the artifact: a reviewer should read
 * the dependency list, not discover it.
 *
 * A hoisted `pnpm deploy` still NESTS on a version conflict: `body-parser` wants
 * `content-type@2` while `express` wants `content-type@1`, so one of them lives in
 * a package's own `node_modules`, never the root's. The walk follows every such
 * nesting, because a list read off the root alone omits exactly the versions the
 * conflict exists to keep. Keyed on `name@version`: one version nested under two
 * parents is one disclosure, two versions of one name are two.
 */
export function collectClosure(nodeModules: string): readonly ClosureEntry[] {
  if (!existsSync(nodeModules)) return Object.freeze([]);
  const entries = new Map<string, ClosureEntry>();
  const visit = (directory: string, scope: string | null): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (scope === null && entry.name.startsWith("@")) {
        visit(join(directory, entry.name), entry.name);
        continue;
      }
      const name = scope === null ? entry.name : `${scope}/${entry.name}`;
      if (name.startsWith("@moe/")) continue;
      const packageDir = join(directory, entry.name);
      const manifest = join(packageDir, "package.json");
      if (!existsSync(manifest)) continue;
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
      const version = typeof parsed.version === "string" ? parsed.version : "unknown";
      entries.set(`${name}@${version}`, { name, version });
      const nested = join(packageDir, "node_modules");
      if (existsSync(nested)) visit(nested, null);
    }
  };
  visit(nodeModules, null);
  return Object.freeze([...entries.values()].sort((a, b) => (
    a.name === b.name ? (a.version < b.version ? -1 : 1) : (a.name < b.name ? -1 : 1)
  )));
}

/** Empties a directory without following into it, so a re-pack starts clean. */
export function resetDirectory(directory: string): void {
  rmSync(directory, { force: true, recursive: true });
  mkdirSync(directory, { recursive: true });
}

/** Total bytes under a tree; reported so the operator sees what they downloaded. */
export function treeBytes(root: string, files: readonly string[]): number {
  let total = 0;
  for (const file of files) total += statSync(join(root, file)).size;
  return total;
}

/** `relative` with the separator this repo's logical paths always use. */
export function logicalRelative(from: string, to: string): string {
  return relative(from, to).replaceAll("\\", "/");
}
