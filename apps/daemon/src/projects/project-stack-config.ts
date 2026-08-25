import { timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { win32 } from "node:path";

import { MOE_CONFIG_FILENAME, MOE_CONFIG_SCHEMA_VERSION } from "../cli/moe-init.js";
import { PROJECT_STACK_HOST_LAYER } from "./project-stack-host.js";

export { PROJECT_STACK_HOST_LAYER } from "./project-stack-host.js";
export const PROJECT_STACK_ARGUMENTS_INVALID = "PROJECT_STACK_ARGUMENTS_INVALID" as const;
export const PROJECT_STACK_CONFIG_INVALID = "PROJECT_STACK_CONFIG_INVALID" as const;
export const PROJECT_STACK_CONFIG_MISMATCH = "PROJECT_STACK_CONFIG_MISMATCH" as const;
export const PROJECT_STACK_CONFIG_UNREADABLE = "PROJECT_STACK_CONFIG_UNREADABLE" as const;
export const PROJECT_STACK_PATH_UNRESOLVED = "PROJECT_STACK_PATH_UNRESOLVED" as const;
export const MAX_PROJECT_STACK_CONFIG_BYTES = 64 * 1024;

type ConfigCode =
  | typeof PROJECT_STACK_ARGUMENTS_INVALID
  | typeof PROJECT_STACK_CONFIG_INVALID
  | typeof PROJECT_STACK_CONFIG_MISMATCH
  | typeof PROJECT_STACK_CONFIG_UNREADABLE
  | typeof PROJECT_STACK_PATH_UNRESOLVED;

export interface ProjectStackConfigFs {
  canonicalDirectory(path: string): string;
  canonicalFile(path: string): string;
  readConfig(path: string): string;
}

export interface ProjectStackBindings {
  readonly assetRoot: string;
  readonly configPath: string;
  readonly credential: string;
  readonly instanceId: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly storePath: string;
}

export type ProjectStackConfigResult =
  | Readonly<{ readonly bindings: ProjectStackBindings; readonly ok: true }>
  | Readonly<{ readonly code: ConfigCode; readonly layer: typeof PROJECT_STACK_HOST_LAYER; readonly ok: false }>;

export interface ResolveProjectStackConfigInput {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fs: ProjectStackConfigFs;
}

const CONFIG_KEYS = ["credential", "projectId", "schemaVersion", "storePath"] as const;
const CREDENTIAL = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function refuse(code: ConfigCode): ProjectStackConfigResult {
  return Object.freeze({ code, layer: PROJECT_STACK_HOST_LAYER, ok: false });
}

function localPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 4096
    && /^[A-Za-z]:\\/u.test(value)
    && win32.isAbsolute(value)
    && !value.includes("\0");
}

function readArguments(argv: readonly string[]): { assetRoot: string; configPath: string } | null {
  if (argv.length !== 2) return null;
  const configPrefix = "--config=";
  const assetPrefix = "--asset-root=";
  if (!argv[0]?.startsWith(configPrefix) || !argv[1]?.startsWith(assetPrefix)) return null;
  const configPath = argv[0].slice(configPrefix.length);
  const assetRoot = argv[1].slice(assetPrefix.length);
  return localPath(configPath) && win32.basename(configPath).toLowerCase() === MOE_CONFIG_FILENAME
    && localPath(assetRoot) ? { assetRoot, configPath } : null;
}

function readRecord(raw: string): Readonly<Record<string, string>> | null {
  if (new TextEncoder().encode(raw).byteLength > MAX_PROJECT_STACK_CONFIG_BYTES) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).toSorted().join("\0") !== [...CONFIG_KEYS].toSorted().join("\0")) return null;
  if (record["schemaVersion"] !== MOE_CONFIG_SCHEMA_VERSION
    || typeof record["credential"] !== "string" || !CREDENTIAL.test(record["credential"])
    || typeof record["projectId"] !== "string" || !IDENTIFIER.test(record["projectId"])
    || !localPath(record["storePath"])) return null;
  return record as Readonly<Record<string, string>>;
}

function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function canonicalStore(path: string, fs: ProjectStackConfigFs): string {
  return win32.join(fs.canonicalDirectory(win32.dirname(path)), win32.basename(path));
}

export function resolveProjectStackConfig(
  input: ResolveProjectStackConfigInput,
): ProjectStackConfigResult {
  const args = readArguments(input.argv);
  if (args === null) return refuse(PROJECT_STACK_ARGUMENTS_INVALID);
  let configPath: string;
  let assetRoot: string;
  let raw: string;
  try {
    configPath = input.fs.canonicalFile(args.configPath);
    assetRoot = input.fs.canonicalDirectory(args.assetRoot);
    raw = input.fs.readConfig(configPath);
  } catch {
    return refuse(PROJECT_STACK_PATH_UNRESOLVED);
  }
  const config = readRecord(raw);
  if (config === null) return refuse(PROJECT_STACK_CONFIG_INVALID);

  let envCredential: unknown;
  let envProjectId: unknown;
  let envStorePath: unknown;
  let instanceId: unknown;
  try {
    envCredential = input.env["MOE_DAEMON_CREDENTIAL"];
    envProjectId = input.env["MOE_PROJECT_ID"];
    envStorePath = input.env["MOE_STORE_PATH"];
    instanceId = input.env["MOE_PROJECT_INSTANCE_ID"];
  } catch {
    return refuse(PROJECT_STACK_CONFIG_INVALID);
  }
  if (typeof instanceId !== "string" || !UUID_V4.test(instanceId)
    || typeof envCredential !== "string" || !CREDENTIAL.test(envCredential)
    || typeof envProjectId !== "string" || !IDENTIFIER.test(envProjectId)
    || !localPath(envStorePath)) return refuse(PROJECT_STACK_CONFIG_INVALID);

  let storePath: string;
  let configuredStore: string;
  try {
    storePath = canonicalStore(envStorePath, input.fs);
    configuredStore = canonicalStore(config["storePath"] as string, input.fs);
  } catch {
    return refuse(PROJECT_STACK_PATH_UNRESOLVED);
  }
  if (!sameSecret(envCredential, config["credential"] as string)
    || envProjectId !== config["projectId"] || storePath.toLowerCase() !== configuredStore.toLowerCase()) {
    return refuse(PROJECT_STACK_CONFIG_MISMATCH);
  }
  return Object.freeze({
    bindings: Object.freeze({
      assetRoot,
      configPath,
      credential: envCredential,
      instanceId,
      projectId: envProjectId,
      projectRoot: win32.dirname(configPath),
      storePath,
    }),
    ok: true,
  });
}

export function createNodeProjectStackConfigFs(): ProjectStackConfigFs {
  return Object.freeze({
    canonicalDirectory: (path: string): string => {
      const canonical = realpathSync.native(path);
      if (!statSync(canonical).isDirectory()) throw new Error(PROJECT_STACK_PATH_UNRESOLVED);
      return canonical;
    },
    canonicalFile: (path: string): string => {
      const canonical = realpathSync.native(path);
      if (!statSync(canonical).isFile()) throw new Error(PROJECT_STACK_PATH_UNRESOLVED);
      return canonical;
    },
    readConfig: (path: string): string => {
      if (statSync(path).size > MAX_PROJECT_STACK_CONFIG_BYTES) return " ".repeat(MAX_PROJECT_STACK_CONFIG_BYTES + 1);
      return readFileSync(path, "utf8");
    },
  });
}
