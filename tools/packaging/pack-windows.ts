#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  PACK_STEP_FAILED, runPackStep, type WindowsPackToolchain,
} from "./pack-command.js";
import { MOE_CMD, MOE_PS1, closureDoc, installDoc } from "./pack-docs.js";
import { collectImportFaults } from "./pack-imports.js";
import { inspectStagedTree } from "./pack-inventory.js";
import {
  PackOutputError, packOutputPathPresent, prepareWindowsArtifactOutput, snapshotPackTree,
} from "./pack-output.js";
import {
  collectClosure, collectDevDependencies, collectSourceBridges, findWorkspacePackages,
  pruneTestArtifacts, removeEmptyDirectories, treeBytes, walkFiles,
} from "./pack-staging.js";
import { publishWindowsArchive } from "./pack-windows-archive.js";

export { PACK_STEP_FAILED, publishWindowsArchive };

/**
 * `pnpm pack:windows` — the installable Windows artifact.
 *
 * Shape of the zip, and WHY it is not just a `pnpm deploy` tree: Node 24 refuses
 * `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` for a `.ts` file whose realpath
 * is under `node_modules`, and this artifact ships sources. So the workspace
 * packages are laid out OUTSIDE `node_modules` — mirroring the repository —
 * and `moe start` junctions them back in on first run.
 *
 *   <root>/apps/daemon        the daemon + the moe CLI
 *   <root>/packages/*         the workspace packages, real directories
 *   <root>/node_modules       the pruned third-party closure only
 *   <root>/control-room       the built vite bundle
 *   <root>/moe.cmd, moe.ps1   the entry points
 */

export const WINDOWS_ARTIFACT_FILENAME = "moe-windows.zip" as const;

const NODE_RANGE = ">=24.16.0 <25";

export interface PackOptions {
  readonly log: (line: string) => void;
  /** Durable publication root, deliberately outside the callback-owned source tree. */
  readonly outputRoot: string;
  readonly sourceSha: string;
  /** Exact tracked Git object tree selected by the packaging-source boundary. */
  readonly sourceRoot: string;
  /** Frozen identities resolved before materialization; ambient PATH is never tool authority. */
  readonly toolchain: WindowsPackToolchain;
}

/** Existing public bytes are a conflict; the packer never deletes through a checked pathname. */
export function invalidateWindowsArtifact(outputRoot: string): string {
  const output = prepareWindowsArtifactOutput(outputRoot);
  if (packOutputPathPresent(output.zip)) {
    throw new PackOutputError("PACK_OUTPUT_PUBLICATION_CONFLICT");
  }
  const rechecked = prepareWindowsArtifactOutput(outputRoot);
  if (rechecked.dist !== output.dist || rechecked.zip !== output.zip) {
    throw new PackOutputError("PACK_OUTPUT_PATH_UNSAFE");
  }
  return rechecked.zip;
}

interface Staged {
  /** `@moe/x` -> staged directory, forward-slash, e.g. `packages/x`. */
  readonly links: Readonly<Record<string, string>>;
}

/**
 * Reshapes one `pnpm deploy` output into the artifact layout: the daemon to
 * `apps/daemon`, every other `@moe` package out of `node_modules` and into
 * `packages/`, and the third-party remainder to a single root `node_modules`.
 */
export function reshapeWindowsDeploy(deployDir: string, staging: string): Staged {
  const scope = join(deployDir, "node_modules", "@moe");
  const links: Record<string, string> = { "@moe/daemon": "apps/daemon" };
  mkdirSync(join(staging, "apps"), { recursive: true });
  mkdirSync(join(staging, "packages"), { recursive: true });
  for (const entry of topLevelNames(scope)) {
    const source = join(scope, entry);
    if (entry === "daemon") {
      rmSync(source, { force: true, recursive: true });
      continue;
    }
    renameSync(source, join(staging, "packages", entry));
    links[`@moe/${entry}`] = `packages/${entry}`;
  }
  rmSync(scope, { force: true, recursive: true });
  renameSync(join(deployDir, "node_modules"), join(staging, "node_modules"));
  // Machine-specific: pnpm's shims and metadata carry the PACKER's absolute
  // paths, which are both useless to the operator and a needless disclosure.
  for (const junk of [".bin", ".pnpm", ".modules.yaml"]) {
    rmSync(join(staging, "node_modules", junk), { force: true, recursive: true });
  }
  cpSync(join(deployDir, "src"), join(staging, "apps", "daemon", "src"), { recursive: true });
  cpSync(join(deployDir, "package.json"), join(staging, "apps", "daemon", "package.json"));
  return { links: Object.freeze(links) };
}

function topLevelNames(directory: string): readonly string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function writeArtifactFiles(
  staging: string, sourceRoot: string, staged: Staged, options: PackOptions,
): number {
  const version = (JSON.parse(
    readFileSync(join(sourceRoot, "package.json"), "utf8"),
  ) as { version: string }).version;
  const closure = collectClosure(join(staging, "node_modules"));
  cpSync(join(sourceRoot, "LICENSE"), join(staging, "LICENSE"));
  writeFileSync(join(staging, "INSTALL.md"),
    installDoc({ closureCount: closure.length, nodeRange: NODE_RANGE, version }), "utf8");
  writeFileSync(join(staging, "MANIFEST-CLOSURE.txt"),
    closureDoc({ dirtyPaths: [], entries: closure, version }), "utf8");
  writeFileSync(join(staging, "moe-workspace-links.json"),
    `${JSON.stringify({ links: staged.links, schemaVersion: "moe-workspace-links/1" }, null, 2)}\n`,
    "utf8");
  writeFileSync(join(staging, "moe.cmd"), MOE_CMD, "utf8");
  writeFileSync(join(staging, "moe.ps1"), MOE_PS1, "utf8");
  options.log(`  closure: ${String(closure.length)} third-party packages`);
  return closure.length;
}

function expectedBridges(repoRoot: string, staged: Staged): readonly string[] {
  const workspace = findWorkspacePackages(repoRoot);
  const bridges: string[] = [];
  for (const [specifier, stagedPrefix] of Object.entries(staged.links)) {
    const source = workspace.find((entry) => entry.name === specifier);
    if (source === undefined) continue;
    bridges.push(...collectSourceBridges(repoRoot, source.sourceDir, stagedPrefix));
  }
  return Object.freeze(bridges);
}

interface PackTemporaryOwner {
  readonly root: string;
  readonly token: string;
}

const PACK_OWNER_PREFIX = "moe-windows-pack-owner-";
const PACK_OWNER_MARKER = ".moe-windows-pack-owner";

function createPackTemporaryOwner(): PackTemporaryOwner {
  const temporaryParent = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(join(temporaryParent, PACK_OWNER_PREFIX)));
  const token = randomUUID();
  writeFileSync(join(root, PACK_OWNER_MARKER), token, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return Object.freeze({ root, token });
}

function validatePackOwnerTree(root: string): void {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new PackOutputError("PACK_OUTPUT_PATH_UNSAFE");
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new PackOutputError("PACK_OUTPUT_PATH_UNSAFE");
      if (stat.isDirectory()) pending.push(path);
      else if (!stat.isFile()) throw new PackOutputError("PACK_OUTPUT_PATH_UNSAFE");
    }
  }
}

/** Recursively removes only the same exclusive, marker-owned OS-temp directory. */
function removePackTemporaryOwner(owner: PackTemporaryOwner): void {
  try {
    const temporaryParent = realpathSync(tmpdir());
    const canonicalRoot = realpathSync(owner.root);
    if (dirname(canonicalRoot) !== temporaryParent
      || !basename(canonicalRoot).startsWith(PACK_OWNER_PREFIX)
      || readFileSync(join(canonicalRoot, PACK_OWNER_MARKER), "utf8") !== owner.token) {
      throw new Error();
    }
    validatePackOwnerTree(canonicalRoot);
    rmSync(canonicalRoot, { force: false, recursive: true });
  } catch (error) {
    if (error instanceof PackOutputError) throw error;
    throw new PackOutputError("PACK_OUTPUT_PATH_UNSAFE");
  }
}

export function packWindows(options: PackOptions): number {
  const { log, outputRoot, sourceRoot } = options;
  const zip = invalidateWindowsArtifact(outputRoot);
  const owner = createPackTemporaryOwner();
  try {
    const staging = join(owner.root, "staging");
    const deployDir = join(owner.root, "deploy");
    mkdirSync(staging, { recursive: false });

    log("pack: installing the selected commit's locked build dependencies");
    runPackStep(options.toolchain.pnpm,
      ["install", "--frozen-lockfile", "--ignore-scripts"], sourceRoot, log,
      process.env, options.toolchain.powershell);
    log("pack: building the control room");
    runPackStep(options.toolchain.pnpm,
      ["--filter", "@moe/control-room", "build"], sourceRoot, log,
      process.env, options.toolchain.powershell);
    const controlRoomDist = join(sourceRoot, "apps", "control-room", "dist");
    cpSync(controlRoomDist, join(staging, "control-room"), { recursive: true });

    log("pack: deploying the daemon's production closure");
    runPackStep(options.toolchain.pnpm, ["--filter", "@moe/daemon", "deploy", "--legacy", "--prod",
      "--config.node-linker=hoisted", deployDir], sourceRoot, log,
      process.env, options.toolchain.powershell);
    const staged = reshapeWindowsDeploy(deployDir, staging);
    rmSync(deployDir, { force: true, recursive: true });

    const closureCount = writeArtifactFiles(staging, sourceRoot, staged, options);
    const pruned = pruneTestArtifacts(staging);
    const emptied = removeEmptyDirectories(staging);
    log(`pack: pruned ${String(pruned.length)} test and build artifacts`
      + ` and ${String(emptied.length)} directories they emptied`);

    const files = walkFiles(staging);
    const devDependencies = collectDevDependencies(sourceRoot, findWorkspacePackages(sourceRoot));
    const imports = collectImportFaults(staging, files, devDependencies);
    const verdict = inspectStagedTree({
      danglingImports: imports.dangling,
      devDependencies,
      devDependencyImports: imports.devDependency,
      expectedBridges: expectedBridges(sourceRoot, staged),
      paths: files,
    });
    if (!verdict.ok) {
      for (const refusal of verdict.refusals.slice(0, 20)) log(refusal.message);
      log(`pack: ${String(verdict.refusals.length)} inventory refusals — nothing was zipped`);
      return 1;
    }
    const snapshot = snapshotPackTree(staging, files);
    log(`pack: inventory clean — ${String(verdict.fileCount)} files, `
      + `${String(Math.round(treeBytes(staging, files) / 1024 / 1024))} MB unpacked`);

    log("pack: compressing and reopening the exact admitted snapshot");
    publishWindowsArchive({
      log, outputRoot, powershell: options.toolchain.powershell,
      snapshot, staging, temporaryRoot: owner.root,
    });
    const bytes = statSync(zip).size;
    log(`pack: ${zip}`);
    log(`pack: ${String(Math.round((bytes / 1024 / 1024) * 100) / 100)} MB, `
      + `${String(verdict.fileCount)} files, ${String(closureCount)} third-party packages`);
    return 0;
  } finally {
    removePackTemporaryOwner(owner);
  }
}
