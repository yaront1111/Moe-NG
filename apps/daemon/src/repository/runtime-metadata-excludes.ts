import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { nodeGitRunner } from "./git-process-runner.js";
import type { GitRunner } from "./git-process-runner.js";
import { replaceRuntimeExcludeBlock } from "./runtime-metadata-exclude-file.js";

export interface RuntimeMetadataPaths {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly storePath: string;
  readonly initializing?: true;
}
export type RuntimeMetadataResult = Readonly<{ ok: true }> | Readonly<{ ok: false; code: string; layer: string }>;
const refuse = (code: string): RuntimeMetadataResult => ({ ok: false, code, layer: "RUNTIME_METADATA_EXCLUDES" });
const oneLine = (value: string) => value.replace(/\r?\n$/u, "");
function localName(root: string, path: string): string | null {
  const name = relative(root, path);
  if (name === "" || isAbsolute(name) || name === ".." || name.startsWith(`..${sep}`)) return null;
  if (/[\0\r\n]/u.test(name)) throw new Error("invalid path");
  return name.split(sep).join("/");
}
function canonicalFile(path: string): string {
  if (!isAbsolute(path) || /[\0\r\n]/u.test(path)) throw new Error("invalid path");
  return join(realpathSync.native(dirname(path)), basename(path));
}
const pattern = (name: string) => `/${name.replace(/[\\*?\[\]#! ]/gu, "\\$&")}`;
const storeFiles = (store: string) => [
  ...["", ".health.sqlite", ".backups.sqlite"].flatMap((family) =>
    ["", "-wal", "-shm", "-journal"].map((suffix) => `${store}${family}${suffix}`)),
  `${store}.moe-stack.lock`,
];

async function ignored(run: GitRunner, root: string, names: readonly string[]): Promise<boolean> {
  const result = await run(root, ["check-ignore", "--no-index", "-z", "--stdin"], `${names.join("\0")}\0`);
  if (result.code !== 0 && result.code !== 1) throw new Error("git failed");
  const found = new Set(result.stdout.split("\0").filter(Boolean));
  return names.every((name) => found.has(name));
}

/**
 * Ordinary Git exclusions cover observation, candidate capture, and operator staging together.
 * info/exclude has Git's repository-wide scope, including any worktrees created later. Never
 * install new exact file rules while existing peer worktrees could use those names as code/data.
 * Tracked files retain their normal Git meaning; exact tracked runtime files refuse startup.
 */
export async function prepareRuntimeMetadataExcludes(
  input: RuntimeMetadataPaths, run: GitRunner = nodeGitRunner,
): Promise<RuntimeMetadataResult> {
  let projectRoot: string; let configPath: string; let storePath: string;
  try {
    projectRoot = realpathSync.native(input.projectRoot);
    configPath = canonicalFile(input.configPath); storePath = canonicalFile(input.storePath);
    if (localName(projectRoot, configPath) === null) return refuse("RUNTIME_METADATA_PATH_INVALID");
    if (input.initializing === true && storeFiles(storePath).some(existsSync)) return refuse("RUNTIME_METADATA_PATH_OCCUPIED");
  } catch { return refuse("RUNTIME_METADATA_PATH_INVALID"); }
  try {
    const top = await run(projectRoot, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) {
      // A real non-repository can plan before bootstrap. Missing Git, unsafe ownership and
      // permission failures are not evidence of that state and must not enable workers.
      if (top.code === 128 && /^fatal: not a git repository \(or any of the parent directories\): \.git\s*$/u.test(top.stderr)) return { ok: true };
      return refuse("RUNTIME_METADATA_GIT_FAILED");
    }
    const root = realpathSync.native(oneLine(top.stdout));
    const project = localName(root, projectRoot);
    if (resolve(root) !== resolve(projectRoot) && project === null) return refuse("RUNTIME_METADATA_PATH_INVALID");
    const config = localName(root, configPath);
    if (config === null) return refuse("RUNTIME_METADATA_PATH_INVALID");
    const files = [config, ...storeFiles(storePath)
      .map((path) => localName(root, path)).filter((path): path is string => path !== null)];
    const dirs = [".moe", ".moe-next"].map((dir) => `${project === null ? "" : `${project}/`}${dir}`);
    const head = await run(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (head.code !== 1 && (head.code !== 0 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(oneLine(head.stdout)))) {
      return refuse("RUNTIME_METADATA_GIT_FAILED");
    }
    // Verifier reads HEAD into a fresh index, so an index-only removal is still tracked.
    // Windows path aliases name the same physical file despite Git's literal pathspec casing.
    const tracked = await run(root, ["ls-files", "-z", "--cached",
      ...(head.code === 0 ? [`--with-tree=${oneLine(head.stdout)}`] : []), "--",
      ...files.map((path) => `:(literal${process.platform === "win32" ? ",icase" : ""})${path}`)]);
    if (tracked.code !== 0) return refuse("RUNTIME_METADATA_GIT_FAILED");
    if (tracked.stdout !== "") return refuse("RUNTIME_METADATA_TRACKED");
    const worktrees = await run(root, ["worktree", "list", "--porcelain", "-z"]);
    if (worktrees.code !== 0) return refuse("RUNTIME_METADATA_GIT_FAILED");
    const checked = [...files, ...dirs.map((dir) => `${dir}/wrapper.log`)];
    if (worktrees.stdout.split("\0").filter((field) => field.startsWith("worktree ")).length > 1) {
      // Shared checkouts use existing exclusions only. Never replace a live peer's block.
      return await ignored(run, root, checked) ? { ok: true } : refuse("RUNTIME_METADATA_SHARED_WORKTREE");
    }
    const common = await run(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common.code !== 0) return refuse("RUNTIME_METADATA_GIT_FAILED");
    const exclude = join(realpathSync.native(oneLine(common.stdout)), "info", "exclude");
    const key = createHash("sha256").update(process.platform === "win32" ? configPath.toLowerCase() : configPath).digest("hex");
    try { replaceRuntimeExcludeBlock(exclude, key, [...dirs.map((dir) => `${pattern(dir)}/`), ...files.map(pattern)]); }
    catch { return refuse("RUNTIME_METADATA_EXCLUDES_UNAVAILABLE"); }
    // A project .gitignore can override info/exclude with negations. Check Git's effective
    // answer instead of declaring readiness merely because our rules reached disk.
    if (!await ignored(run, root, checked)) {
      return refuse("RUNTIME_METADATA_EXCLUDES_INEFFECTIVE");
    }
    return { ok: true };
  } catch { return refuse("RUNTIME_METADATA_GIT_FAILED"); }
}
