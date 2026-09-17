import { constants } from "node:fs";
import {
  access, mkdir, open, readFile, readdir, realpath, rmdir, stat, unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, win32 } from "node:path";

import {
  MOE_CONFIG_FILENAME,
  MOE_CONFIG_SCHEMA_VERSION,
  cryptoRandomHex,
  planInit,
} from "../cli/moe-init.js";

export const PROJECT_MANAGER_FILES_LAYER = "PROJECT_MANAGER_FILES" as const;
export const PROJECT_MANAGER_ROOT_INVALID = "PROJECT_MANAGER_ROOT_INVALID" as const;
export const PROJECT_MANAGER_CONFIG_UNREADABLE = "PROJECT_MANAGER_CONFIG_UNREADABLE" as const;
export const PROJECT_MANAGER_CONFIG_INVALID = "PROJECT_MANAGER_CONFIG_INVALID" as const;
export const PROJECT_MANAGER_CONFIG_WRITE_FAILED = "PROJECT_MANAGER_CONFIG_WRITE_FAILED" as const;
export const MAX_PROJECT_MANAGER_CONFIG_BYTES = 64 * 1024;

export interface ManagedProjectFiles {
  readonly configPath: string;
  readonly projectId: string;
  readonly root: string;
  readonly storePath: string;
}

export interface WrittenProjectFiles {
  /** Every directory this call made, leaf first; empty when the root already existed. */
  readonly createdDirectories: readonly string[];
  readonly paths: readonly string[];
  readonly root: string;
}

export type ManagedProjectFilesResult =
  | Readonly<{
    readonly ok: true;
    readonly project: ManagedProjectFiles;
    readonly written: WrittenProjectFiles;
  }>
  | Readonly<{ readonly code: string; readonly layer: typeof PROJECT_MANAGER_FILES_LAYER; readonly ok: false }>;

export interface ProjectManagerFilesPort {
  create(root: string): Promise<ManagedProjectFilesResult>;
  discard(written: WrittenProjectFiles): Promise<void>;
  register(root: string): Promise<ManagedProjectFilesResult>;
}

export interface NodeProjectManagerFilesOptions {
  readonly randomHex?: (bytes: number) => string;
}

const CONFIG_KEYS = ["credential", "projectId", "schemaVersion", "storePath"] as const;
const CREDENTIAL = /^[0-9a-f]{64}$/u;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function refuse(code: string): ManagedProjectFilesResult {
  return Object.freeze({ code, layer: PROJECT_MANAGER_FILES_LAYER, ok: false });
}

function fsErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    const code = Reflect.get(error, "code");
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

async function pathMissing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if (fsErrorCode(error) === "ENOENT") return true;
    throw error;
  }
}

/**
 * The directories `mkdir(root, { recursive: true })` is about to make, leaf
 * first. Measured before the call: mkdir reports only the topmost one it made,
 * and on Windows in `\\?\` form, so its answer cannot be matched back to `root`.
 */
async function missingDirectories(root: string): Promise<readonly string[]> {
  const missing: string[] = [];
  for (let path = root; await pathMissing(path); path = dirname(path)) {
    missing.push(path);
    if (dirname(path) === path) break;
  }
  return Object.freeze(missing);
}

function written(
  root: string,
  createdDirectories: readonly string[],
  paths: readonly string[],
): WrittenProjectFiles {
  return Object.freeze({
    createdDirectories: Object.freeze([...createdDirectories]),
    paths: Object.freeze([...paths]),
    root,
  });
}

async function discardWrittenFiles(receipt: WrittenProjectFiles): Promise<void> {
  for (const path of receipt.paths) {
    try {
      await unlink(path);
    } catch (error) {
      if (fsErrorCode(error) !== "ENOENT") throw error;
    }
  }
  // Leaf first: an ancestor can only empty once the directory below it is gone,
  // and one that is not empty keeps every ancestor above it.
  for (const directory of receipt.createdDirectories) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (fsErrorCode(error) === "ENOTEMPTY") return;
      if (fsErrorCode(error) !== "ENOENT") throw error;
    }
  }
}

async function discardQuietly(receipt: WrittenProjectFiles): Promise<void> {
  try {
    await discardWrittenFiles(receipt);
  } catch {
    // Best effort: the refusal that triggered the rollback stays authoritative.
  }
}

function localAbsoluteRoot(value: unknown): value is string {
  return typeof value === "string"
    && value !== ""
    && value.length <= 4096
    && !value.includes("\0")
    && !value.startsWith("\\\\")
    && value !== "."
    && (isAbsolute(value) || win32.isAbsolute(value));
}

function exactConfig(raw: string): Readonly<{
  credential: string; projectId: string; storePath: string;
}> | null {
  if (new TextEncoder().encode(raw).byteLength > MAX_PROJECT_MANAGER_CONFIG_BYTES) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).toSorted().join("\0") !== [...CONFIG_KEYS].toSorted().join("\0")
    || record["schemaVersion"] !== MOE_CONFIG_SCHEMA_VERSION
    || typeof record["credential"] !== "string" || !CREDENTIAL.test(record["credential"])
    || typeof record["projectId"] !== "string" || !PROJECT_ID.test(record["projectId"])
    || !localAbsoluteRoot(record["storePath"])) return null;
  return Object.freeze({
    credential: record["credential"],
    projectId: record["projectId"],
    storePath: record["storePath"],
  });
}

async function canonicalProject(
  root: string,
  projectId: string,
  configPath: string,
  storePath: string,
): Promise<ManagedProjectFiles> {
  const canonicalRoot = await realpath(root);
  const canonicalConfig = await realpath(configPath);
  const canonicalStore = join(await realpath(dirname(storePath)), basename(storePath));
  return Object.freeze({
    configPath: canonicalConfig,
    projectId,
    root: canonicalRoot,
    storePath: canonicalStore,
  });
}

async function registerExisting(root: string): Promise<ManagedProjectFilesResult> {
  if (!localAbsoluteRoot(root)) return refuse(PROJECT_MANAGER_ROOT_INVALID);
  let canonicalRoot: string;
  let configPath: string;
  let raw: string;
  try {
    canonicalRoot = await realpath(root);
    if (!(await stat(canonicalRoot)).isDirectory()) return refuse(PROJECT_MANAGER_ROOT_INVALID);
    configPath = await realpath(join(canonicalRoot, MOE_CONFIG_FILENAME));
    const configStat = await stat(configPath);
    if (!configStat.isFile() || configStat.size > MAX_PROJECT_MANAGER_CONFIG_BYTES) {
      return refuse(PROJECT_MANAGER_CONFIG_INVALID);
    }
    raw = await readFile(configPath, "utf8");
  } catch {
    return refuse(PROJECT_MANAGER_CONFIG_UNREADABLE);
  }
  const config = exactConfig(raw);
  if (config === null) return refuse(PROJECT_MANAGER_CONFIG_INVALID);
  try {
    return Object.freeze({
      ok: true,
      project: await canonicalProject(canonicalRoot, config.projectId, configPath, config.storePath),
      written: written(root, [], []),
    });
  } catch {
    return refuse(PROJECT_MANAGER_CONFIG_INVALID);
  }
}

/**
 * The receipt grows as the call makes things, and every non-ok exit, refusal
 * or throw, discards exactly that receipt: the tree is left as the call found
 * it, so a retry never meets this call's own leftovers as a foreign config.
 */
async function createFresh(
  root: string,
  randomHex: (bytes: number) => string,
): Promise<ManagedProjectFilesResult> {
  if (!localAbsoluteRoot(root)) return refuse(PROJECT_MANAGER_ROOT_INVALID);
  let made = written(root, [], []);
  try {
    const missing = await missingDirectories(root);
    const createdPath = await mkdir(root, { recursive: true });
    made = written(root, createdPath === undefined ? [] : missing, []);
    await access(root, constants.W_OK);
    const resolution = planInit({
      force: false,
      probe: { entries: await readdir(root), writable: true },
      randomHex,
      targetDir: root,
    });
    if (!resolution.ok) {
      await discardQuietly(made);
      return refuse(resolution.refusals[0]?.code ?? PROJECT_MANAGER_CONFIG_WRITE_FAILED);
    }
    for (const file of resolution.files) {
      // The receipt takes the path the moment `wx` creates it, not once the
      // bytes land: a write that fails after open still gets discarded, and a
      // foreign file that made open throw EEXIST is never named, so never removed.
      const handle = await open(file.path, "wx", 0o600);
      made = written(root, made.createdDirectories, [...made.paths, file.path]);
      try {
        await handle.writeFile(file.contents, "utf8");
      } finally {
        await handle.close();
      }
    }
    return Object.freeze({
      ok: true,
      project: await canonicalProject(
        root, resolution.projectId, resolution.configPath, resolution.storePath,
      ),
      written: made,
    });
  } catch {
    await discardQuietly(made);
    return refuse(PROJECT_MANAGER_CONFIG_WRITE_FAILED);
  }
}

export function createNodeProjectManagerFiles(
  options: NodeProjectManagerFilesOptions = {},
): ProjectManagerFilesPort {
  return Object.freeze({
    create: (root: string) => createFresh(root, options.randomHex ?? cryptoRandomHex),
    discard: discardWrittenFiles,
    register: registerExisting,
  });
}
