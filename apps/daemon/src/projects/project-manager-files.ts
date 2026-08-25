import { constants } from "node:fs";
import {
  access, mkdir, readFile, readdir, realpath, stat, writeFile,
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

export type ManagedProjectFilesResult =
  | Readonly<{ readonly ok: true; readonly project: ManagedProjectFiles }>
  | Readonly<{ readonly code: string; readonly layer: typeof PROJECT_MANAGER_FILES_LAYER; readonly ok: false }>;

export interface ProjectManagerFilesPort {
  create(root: string): Promise<ManagedProjectFilesResult>;
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
    });
  } catch {
    return refuse(PROJECT_MANAGER_CONFIG_INVALID);
  }
}

export function createNodeProjectManagerFiles(
  options: NodeProjectManagerFilesOptions = {},
): ProjectManagerFilesPort {
  return Object.freeze({
    create: async (root: string): Promise<ManagedProjectFilesResult> => {
      if (!localAbsoluteRoot(root)) return refuse(PROJECT_MANAGER_ROOT_INVALID);
      try {
        await mkdir(root, { recursive: true });
        await access(root, constants.W_OK);
        const resolution = planInit({
          force: false,
          probe: { entries: await readdir(root), writable: true },
          randomHex: options.randomHex ?? cryptoRandomHex,
          targetDir: root,
        });
        if (!resolution.ok) return refuse(resolution.refusals[0]?.code ?? PROJECT_MANAGER_CONFIG_WRITE_FAILED);
        for (const file of resolution.files) {
          await writeFile(file.path, file.contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
        }
        return Object.freeze({
          ok: true,
          project: await canonicalProject(
            root, resolution.projectId, resolution.configPath, resolution.storePath,
          ),
        });
      } catch {
        return refuse(PROJECT_MANAGER_CONFIG_WRITE_FAILED);
      }
    },
    register: registerExisting,
  });
}
