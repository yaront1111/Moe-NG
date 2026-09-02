import { isAbsolute } from "node:path";

import {
  PACK_STEP_FAILED, PACK_TOOL_SCHEMA, MAX_IDENTITY_ENTRIES, freezePackTool,
  type PackFileIdentity, type PackToolLaunch, type PackTreeEntry, type PackTreeIdentity,
} from "./pack-tool-identity.js";

export const PACK_TOOLCHAIN_SCHEMA = "moe-windows-pack-toolchain/1" as const;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;

export interface WindowsPackToolchain {
  readonly cargo: PackToolLaunch;
  readonly node: PackToolLaunch;
  readonly pnpm: PackToolLaunch;
  readonly powershell: PackToolLaunch;
  readonly schemaVersion: typeof PACK_TOOLCHAIN_SCHEMA;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function decodeFile(value: unknown): PackFileIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>,
      ["dev", "ino", "mode", "nlink", "path", "sha256", "size"])) {
    throw new Error(`${PACK_STEP_FAILED}: tool manifest invalid`);
  }
  const file = value as Record<string, unknown>;
  if (typeof file["dev"] !== "string" || typeof file["ino"] !== "string"
    || typeof file["mode"] !== "string" || typeof file["nlink"] !== "string"
    || typeof file["path"] !== "string"
    || !isAbsolute(file["path"]) || typeof file["sha256"] !== "string"
    || !/^[0-9a-f]{64}$/u.test(file["sha256"])
    || !Number.isSafeInteger(file["size"]) || Number(file["size"]) <= 0) {
    throw new Error(`${PACK_STEP_FAILED}: tool manifest invalid`);
  }
  return Object.freeze(file as unknown as PackFileIdentity);
}

function decodeTree(value: unknown): PackTreeIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, ["entries", "root"])) {
    throw new Error(`${PACK_STEP_FAILED}: tool manifest invalid`);
  }
  const tree = value as Record<string, unknown>;
  if (typeof tree["root"] !== "string" || !isAbsolute(tree["root"])
    || !Array.isArray(tree["entries"]) || tree["entries"].length === 0
    || tree["entries"].length > MAX_IDENTITY_ENTRIES) {
    throw new Error(`${PACK_STEP_FAILED}: tool manifest invalid`);
  }
  const entries = tree["entries"].map((entry): PackTreeEntry => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)
      || !exactKeys(entry as Record<string, unknown>,
        ["dev", "ino", "kind", "mode", "nlink", "path", "sha256", "size"])) {
      throw new Error(`${PACK_STEP_FAILED}: tool manifest invalid`);
    }
    const item = entry as Record<string, unknown>;
    if (typeof item["dev"] !== "string" || typeof item["ino"] !== "string"
      || typeof item["mode"] !== "string" || typeof item["nlink"] !== "string"
      || typeof item["path"] !== "string"
      || (item["kind"] !== "directory" && item["kind"] !== "file")
      || typeof item["sha256"] !== "string" || !Number.isSafeInteger(item["size"])) {
      throw new Error(`${PACK_STEP_FAILED}: tool manifest invalid`);
    }
    return Object.freeze(item as unknown as PackTreeEntry);
  });
  return Object.freeze({ entries: Object.freeze(entries), root: tree["root"] });
}

function decodeTool(value: unknown, expectedKind: PackToolLaunch["kind"]): PackToolLaunch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${PACK_STEP_FAILED}: tool manifest invalid`);
  }
  const candidate = value as Record<string, unknown>;
  const keys = candidate["tree"] === undefined
    ? ["argsPrefix", "executable", "kind", "schemaVersion", "witnesses"]
    : ["argsPrefix", "executable", "kind", "schemaVersion", "tree", "witnesses"];
  if (!exactKeys(candidate, keys) || candidate["schemaVersion"] !== PACK_TOOL_SCHEMA
    || candidate["kind"] !== expectedKind || !Array.isArray(candidate["argsPrefix"])
    || candidate["argsPrefix"].some((arg) => typeof arg !== "string")
    || !Array.isArray(candidate["witnesses"]) || candidate["witnesses"].length > 8) {
    throw new Error(`${PACK_STEP_FAILED}: tool manifest invalid`);
  }
  return freezePackTool({
    argsPrefix: candidate["argsPrefix"] as string[], executable: decodeFile(candidate["executable"]),
    kind: expectedKind,
    ...(candidate["tree"] === undefined ? {} : { tree: decodeTree(candidate["tree"]) }),
    witnesses: candidate["witnesses"].map(decodeFile),
  });
}

export function serializeWindowsPackToolchain(toolchain: WindowsPackToolchain): string {
  const encoded = JSON.stringify(toolchain);
  if (Buffer.byteLength(encoded, "utf8") > MAX_MANIFEST_BYTES) {
    throw new Error(`${PACK_STEP_FAILED}: tool manifest invalid`);
  }
  return encoded;
}

export function parseWindowsPackToolchain(encoded: string): WindowsPackToolchain {
  try {
    if (Buffer.byteLength(encoded, "utf8") > MAX_MANIFEST_BYTES) throw new Error();
    const value = JSON.parse(encoded) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || !exactKeys(value as Record<string, unknown>,
        ["cargo", "node", "pnpm", "powershell", "schemaVersion"])) {
      throw new Error();
    }
    const candidate = value as Record<string, unknown>;
    if (candidate["schemaVersion"] !== PACK_TOOLCHAIN_SCHEMA) throw new Error();
    return Object.freeze({
      cargo: decodeTool(candidate["cargo"], "cargo"),
      node: decodeTool(candidate["node"], "node"),
      pnpm: decodeTool(candidate["pnpm"], "pnpm"),
      powershell: decodeTool(candidate["powershell"], "powershell"),
      schemaVersion: PACK_TOOLCHAIN_SCHEMA,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(PACK_STEP_FAILED)) throw error;
    throw new Error(`${PACK_STEP_FAILED}: tool manifest invalid`);
  }
}
