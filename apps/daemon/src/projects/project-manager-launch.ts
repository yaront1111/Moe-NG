import { readFileSync, realpathSync, statSync } from "node:fs";
import { win32 } from "node:path";

import { PROJECT_STACK_ENVIRONMENT_KEYS } from "@moe/runner";

import { MOE_CONFIG_SCHEMA_VERSION } from "../cli/moe-init.js";
import type { ProjectCatalogEntry } from "./project-catalog.js";

export const PROJECT_MANAGER_LAUNCH_LAYER = "PROJECT_MANAGER_LAUNCH" as const;
export const PROJECT_MANAGER_LAUNCH_CONFIG_UNREADABLE =
  "PROJECT_MANAGER_LAUNCH_CONFIG_UNREADABLE" as const;
export const PROJECT_MANAGER_LAUNCH_CONFIG_MISMATCH =
  "PROJECT_MANAGER_LAUNCH_CONFIG_MISMATCH" as const;
export const PROJECT_MANAGER_LAUNCH_ENVIRONMENT_INVALID =
  "PROJECT_MANAGER_LAUNCH_ENVIRONMENT_INVALID" as const;

export const MAX_PROJECT_MANAGER_LAUNCH_CONFIG_BYTES = 64 * 1024;

export interface ProjectManagerLaunchFs {
  canonicalDirectory(path: string): string;
  canonicalFile(path: string): string;
  readConfig(path: string): string;
}

export type ProjectManagerLaunchResult = Readonly<{
  readonly environment: Readonly<Record<string, string>>;
  readonly ok: true;
}> | Readonly<{
  readonly code:
    | typeof PROJECT_MANAGER_LAUNCH_CONFIG_UNREADABLE
    | typeof PROJECT_MANAGER_LAUNCH_CONFIG_MISMATCH
    | typeof PROJECT_MANAGER_LAUNCH_ENVIRONMENT_INVALID;
  readonly layer: typeof PROJECT_MANAGER_LAUNCH_LAYER;
  readonly ok: false;
}>;

const CONFIG_KEYS = Object.freeze(["credential", "projectId", "schemaVersion", "storePath"] as const);
const CREDENTIAL = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SERVER_OWNED_ENVIRONMENT = new Set([
  "MOE_DAEMON_CREDENTIAL",
  "MOE_PROJECT_ID",
  "MOE_PROJECT_INSTANCE_ID",
  "MOE_STORE_PATH",
]);

function refusal(
  code: Exclude<ProjectManagerLaunchResult, { readonly ok: true }>["code"],
): ProjectManagerLaunchResult {
  return Object.freeze({ code, layer: PROJECT_MANAGER_LAUNCH_LAYER, ok: false });
}

function localWindowsPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && !value.includes("\0") && /^[A-Za-z]:[\\/]/u.test(value) && win32.isAbsolute(value);
}

function pathKey(value: string): string {
  return win32.normalize(value).toLowerCase();
}

function exactConfig(raw: string): Readonly<{
  credential: string; projectId: string; storePath: string;
}> | null {
  if (new TextEncoder().encode(raw).byteLength > MAX_PROJECT_MANAGER_LAUNCH_CONFIG_BYTES) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    || Object.getPrototypeOf(parsed) !== Object.prototype) return null;
  const keys = Reflect.ownKeys(parsed);
  if (keys.length !== CONFIG_KEYS.length
    || keys.some((key) => typeof key !== "string" || !CONFIG_KEYS.includes(key as typeof CONFIG_KEYS[number]))) {
    return null;
  }
  const record: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    const descriptor = Reflect.getOwnPropertyDescriptor(parsed, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    record[key] = descriptor.value;
  }
  if (record["schemaVersion"] !== MOE_CONFIG_SCHEMA_VERSION
    || typeof record["credential"] !== "string" || !CREDENTIAL.test(record["credential"])
    || typeof record["projectId"] !== "string" || !IDENTIFIER.test(record["projectId"])
    || !localWindowsPath(record["storePath"])) return null;
  return Object.freeze({
    credential: record["credential"],
    projectId: record["projectId"],
    storePath: record["storePath"],
  });
}

function reviewedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> | null {
  try {
    const byUpperName = new Map<string, string | undefined>();
    for (const name of Object.keys(source)) {
      const upper = name.toUpperCase();
      if (!PROJECT_STACK_ENVIRONMENT_KEYS.includes(upper as typeof PROJECT_STACK_ENVIRONMENT_KEYS[number])) {
        continue;
      }
      if (byUpperName.has(upper)) return null;
      const descriptor = Reflect.getOwnPropertyDescriptor(source, name);
      if (descriptor === undefined || !("value" in descriptor)) return null;
      byUpperName.set(upper, descriptor.value);
    }
    const environment: Record<string, string> = {};
    for (const name of PROJECT_STACK_ENVIRONMENT_KEYS) {
      if (SERVER_OWNED_ENVIRONMENT.has(name)) continue;
      const value = byUpperName.get(name);
      if (value === undefined) continue;
      if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return null;
      environment[name] = value;
    }
    return environment;
  } catch {
    return null;
  }
}

/**
 * Re-reads the secret project config at the last responsible moment. The
 * catalog is intentionally non-secret; the stack host reads the same file
 * again and compares these bindings, closing the mutation window fail-closed.
 */
export function prepareProjectManagerLaunch(
  entry: ProjectCatalogEntry,
  sourceEnvironment: Readonly<Record<string, string | undefined>>,
  fs: ProjectManagerLaunchFs = createNodeProjectManagerLaunchFs(),
): ProjectManagerLaunchResult {
  let canonicalConfig: string;
  let canonicalRoot: string;
  let raw: string;
  try {
    canonicalConfig = fs.canonicalFile(entry.configPath);
    canonicalRoot = fs.canonicalDirectory(entry.root);
    raw = fs.readConfig(canonicalConfig);
  } catch {
    return refusal(PROJECT_MANAGER_LAUNCH_CONFIG_UNREADABLE);
  }
  const config = exactConfig(raw);
  if (config === null) return refusal(PROJECT_MANAGER_LAUNCH_CONFIG_MISMATCH);
  let canonicalStore: string;
  try {
    canonicalStore = win32.join(
      fs.canonicalDirectory(win32.dirname(config.storePath)),
      win32.basename(config.storePath),
    );
  } catch {
    return refusal(PROJECT_MANAGER_LAUNCH_CONFIG_UNREADABLE);
  }
  if (pathKey(canonicalConfig) !== pathKey(entry.configPath)
    || pathKey(win32.dirname(canonicalConfig)) !== pathKey(canonicalRoot)
    || pathKey(canonicalRoot) !== pathKey(entry.root)
    || config.projectId !== entry.projectId
    || pathKey(canonicalStore) !== pathKey(entry.storePath)) {
    return refusal(PROJECT_MANAGER_LAUNCH_CONFIG_MISMATCH);
  }
  const environment = reviewedEnvironment(sourceEnvironment);
  if (environment === null) return refusal(PROJECT_MANAGER_LAUNCH_ENVIRONMENT_INVALID);
  return Object.freeze({
    environment: Object.freeze({
      ...environment,
      MOE_DAEMON_CREDENTIAL: config.credential,
      MOE_PROJECT_ID: config.projectId,
    }),
    ok: true,
  });
}

export function createNodeProjectManagerLaunchFs(): ProjectManagerLaunchFs {
  return Object.freeze({
    canonicalDirectory: (path: string): string => {
      const canonical = realpathSync.native(path);
      if (!statSync(canonical).isDirectory()) throw new Error(PROJECT_MANAGER_LAUNCH_CONFIG_UNREADABLE);
      return canonical;
    },
    canonicalFile: (path: string): string => {
      const canonical = realpathSync.native(path);
      if (!statSync(canonical).isFile()) throw new Error(PROJECT_MANAGER_LAUNCH_CONFIG_UNREADABLE);
      return canonical;
    },
    readConfig: (path: string): string => {
      if (statSync(path).size > MAX_PROJECT_MANAGER_LAUNCH_CONFIG_BYTES) {
        return " ".repeat(MAX_PROJECT_MANAGER_LAUNCH_CONFIG_BYTES + 1);
      }
      return readFileSync(path, "utf8");
    },
  });
}
