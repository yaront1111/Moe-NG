import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PACK_STEP_FAILED } from "./pack-tool-identity.js";

export const TOOLCHAIN_PINS_SCHEMA = "moe-toolchain-pins/1" as const;
export const TOOLCHAIN_PINS_PATH = fileURLToPath(new URL("./toolchain-pins.json", import.meta.url));

const KEYS = Object.freeze([
  "nodeSha256", "nodeVersion", "pnpmNativeSha256", "pnpmNativeTreeSha256",
  "pnpmPackageTreeSha256", "pnpmVersion", "schemaVersion",
] as const);
const DIGEST = /^[0-9a-f]{64}$/u;
const NODE_VERSION = /^v\d+\.\d+\.\d+$/u;
const PNPM_VERSION = /^\d+\.\d+\.\d+$/u;

export interface ToolchainPins {
  readonly nodeSha256: string;
  readonly nodeVersion: string;
  readonly pnpmNativeSha256: string;
  readonly pnpmNativeTreeSha256: string;
  readonly pnpmPackageTreeSha256: string;
  readonly pnpmVersion: string;
  readonly schemaVersion: typeof TOOLCHAIN_PINS_SCHEMA;
}

function invalid(): never {
  throw new Error(`${PACK_STEP_FAILED}: toolchain pins invalid`);
}

function record(raw: unknown): Readonly<Record<string, unknown>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) invalid();
  const value = raw as Readonly<Record<string, unknown>>;
  const keys = Object.keys(value).sort();
  if (keys.length !== KEYS.length || keys.some((key, index) => key !== KEYS[index])) invalid();
  return value;
}

export function readToolchainPins(path = TOOLCHAIN_PINS_PATH): ToolchainPins {
  try {
    const value = record(JSON.parse(readFileSync(path, "utf8")) as unknown);
    const nodeVersion = value["nodeVersion"];
    const pnpmVersion = value["pnpmVersion"];
    const digests = [value["nodeSha256"], value["pnpmNativeSha256"],
      value["pnpmNativeTreeSha256"], value["pnpmPackageTreeSha256"]];
    if (value["schemaVersion"] !== TOOLCHAIN_PINS_SCHEMA
      || typeof nodeVersion !== "string" || !NODE_VERSION.test(nodeVersion)
      || typeof pnpmVersion !== "string" || !PNPM_VERSION.test(pnpmVersion)
      || digests.some((digest) => typeof digest !== "string" || !DIGEST.test(digest))) invalid();
    return Object.freeze({
      nodeSha256: digests[0] as string, nodeVersion,
      pnpmNativeSha256: digests[1] as string,
      pnpmNativeTreeSha256: digests[2] as string,
      pnpmPackageTreeSha256: digests[3] as string,
      pnpmVersion, schemaVersion: TOOLCHAIN_PINS_SCHEMA,
    });
  } catch {
    return invalid();
  }
}
