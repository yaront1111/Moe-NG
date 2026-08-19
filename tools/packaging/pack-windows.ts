#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MOE_CMD, MOE_PS1, closureDoc, installDoc } from "./pack-docs.js";
import { inspectStagedTree, inspectWorktree } from "./pack-inventory.js";
import {
  collectClosure, collectDevDependencies, collectSourceBridges, findWorkspacePackages,
  pruneTestArtifacts, resetDirectory, treeBytes, walkFiles,
} from "./pack-staging.js";

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

export const PACK_STEP_FAILED = "PACK_STEP_FAILED" as const;

/** Repo paths whose bytes end up in the zip; dirt in any of them stops the pack. */
const SHIPPED_PREFIXES = Object.freeze(["apps/", "packages/", "adapters/", "LICENSE"]);
const NODE_RANGE = ">=24.16.0 <25";

export interface PackOptions {
  readonly allowDirty: boolean;
  readonly log: (line: string) => void;
  readonly repoRoot: string;
}

/** `shell: true` because pnpm is a `.cmd` shim on Windows; every argument quoted. */
function run(command: string, args: readonly string[], cwd: string, log: (l: string) => void): void {
  const line = [command, ...args.map((arg) => `"${arg}"`)].join(" ");
  log(`  $ ${line}`);
  const result = spawnSync(line, { cwd, encoding: "utf8", shell: true, stdio: "pipe" });
  if (result.status !== 0) {
    const tail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-12);
    throw new Error(`${PACK_STEP_FAILED}: ${line}\n${tail.join("\n")}`);
  }
}

const WORKSPACE_STATE = "node_modules/.pnpm-workspace-state-v1.json";

/**
 * MEASURED 2026-08-19: `pnpm deploy` is a FILTERED PRODUCTION install and it
 * stamps the SHARED workspace state with `dev:false, production:true,
 * nodeLinker:"hoisted", filteredInstall:true`. pnpm 11's `verifyDepsBeforeRun`
 * then re-runs `install --production` on the next `pnpm run` in this checkout,
 * which wants to purge node_modules and dies with
 * `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` — every gate in the repo exits 1
 * without running anything. Six agents share this worktree; packing must not
 * leave that behind, so the state file is restored byte-for-byte afterwards.
 */
function preserveWorkspaceState(repoRoot: string, work: () => void): void {
  const path = join(repoRoot, WORKSPACE_STATE);
  const saved = existsSync(path) ? readFileSync(path) : null;
  try {
    work();
  } finally {
    if (saved !== null) writeFileSync(path, saved);
  }
}

function gitPorcelain(repoRoot: string): readonly string[] {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: repoRoot, encoding: "utf8", shell: false,
  });
  if (result.status !== 0) throw new Error(`${PACK_STEP_FAILED}: git status --porcelain`);
  return result.stdout.split("\n");
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
function reshapeDeploy(deployDir: string, staging: string): Staged {
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
  staging: string, repoRoot: string, staged: Staged, options: PackOptions, dirty: readonly string[],
): number {
  const version = (JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as { version: string }).version;
  const closure = collectClosure(join(staging, "node_modules"));
  cpSync(join(repoRoot, "LICENSE"), join(staging, "LICENSE"));
  writeFileSync(join(staging, "INSTALL.md"),
    installDoc({ closureCount: closure.length, nodeRange: NODE_RANGE, version }), "utf8");
  writeFileSync(join(staging, "MANIFEST-CLOSURE.txt"),
    closureDoc({ dirtyPaths: dirty, entries: closure, version }), "utf8");
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

export function packWindows(options: PackOptions): number {
  const { log, repoRoot } = options;
  const dirty = inspectWorktree(gitPorcelain(repoRoot), SHIPPED_PREFIXES);
  if (dirty !== null) {
    if (!options.allowDirty) {
      log(dirty.message);
      log("pack: this worktree is shared — commit or stash, or re-run with --allow-dirty");
      return 1;
    }
    log(`pack: WARNING packing a dirty worktree — ${dirty.detail}`);
  }
  const dirtyPaths = dirty === null ? [] : dirty.detail.split(", ");

  const dist = join(repoRoot, "dist");
  const staging = join(dist, "moe-windows");
  const deployDir = join(dist, ".pack-deploy");
  resetDirectory(staging);
  // pnpm deploy wants the target absent, not merely empty.
  rmSync(deployDir, { force: true, recursive: true });

  log("pack: deploying the daemon's production closure");
  preserveWorkspaceState(repoRoot, () => {
    run("pnpm", ["--filter", "@moe/daemon", "deploy", "--legacy", "--prod",
      "--config.node-linker=hoisted", deployDir], repoRoot, log);
  });
  const staged = reshapeDeploy(deployDir, staging);
  rmSync(deployDir, { force: true, recursive: true });

  log("pack: building the control room");
  run("pnpm", ["--filter", "@moe/control-room", "build"], repoRoot, log);
  cpSync(join(repoRoot, "apps", "control-room", "dist"), join(staging, "control-room"),
    { recursive: true });

  const closureCount = writeArtifactFiles(staging, repoRoot, staged, options, dirtyPaths);
  const pruned = pruneTestArtifacts(staging);
  log(`pack: pruned ${String(pruned.length)} test and build artifacts`);

  const files = walkFiles(staging);
  const verdict = inspectStagedTree({
    devDependencies: collectDevDependencies(repoRoot, findWorkspacePackages(repoRoot)),
    expectedBridges: expectedBridges(repoRoot, staged),
    paths: files,
  });
  if (!verdict.ok) {
    for (const refusal of verdict.refusals.slice(0, 20)) log(refusal.message);
    log(`pack: ${String(verdict.refusals.length)} inventory refusals — nothing was zipped`);
    return 1;
  }
  log(`pack: inventory clean — ${String(verdict.fileCount)} files, `
    + `${String(Math.round(treeBytes(staging, files) / 1024 / 1024))} MB unpacked`);

  const zip = join(dist, "moe-windows.zip");
  rmSync(zip, { force: true });
  log("pack: compressing");
  run("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    `Compress-Archive -Path '${staging.replaceAll("'", "''")}\\*' `
    + `-DestinationPath '${zip.replaceAll("'", "''")}' -Force`], repoRoot, log);
  const bytes = treeBytes(dist, ["moe-windows.zip"]);
  log(`pack: ${zip}`);
  log(`pack: ${String(Math.round((bytes / 1024 / 1024) * 100) / 100)} MB, `
    + `${String(verdict.fileCount)} files, ${String(closureCount)} third-party packages`);
  return 0;
}

const meta = import.meta as ImportMeta & { readonly main?: boolean };
if (meta.main === true) {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  try {
    process.exitCode = packWindows({
      allowDirty: process.argv.includes("--allow-dirty"),
      log: (line) => process.stdout.write(`${line}\n`),
      repoRoot,
    });
  } catch (error) {
    process.stdout.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
