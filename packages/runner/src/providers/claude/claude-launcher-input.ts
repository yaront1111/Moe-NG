import { deepFreeze, isPlainRecord } from "../../canonical.js";
import { snapshotExactRecord } from "../../platform/platform-contract.js";
import { type ClaudeRuntimePinRequest } from "./claude-runtime-pin.js";
import { type ClaudeLaunchRequest } from "./claude-launcher-contract.js";

const REQUEST_KEYS = ["runtime", "duplicateDelivery", "effect", "attempt", "grant", "claim",
  "wrapperIdentity", "bootstrapCredentialDigest", "priorRegistration", "argv", "cwd", "environment",
  "reconciliation", "limits"] as const;
const LIMIT_KEYS = ["stdoutBytes", "stderrBytes", "tailBytes", "timeoutMs"] as const;
const RUNTIME_KEYS = ["quotedObservation", "installedRoot", "pinRoot", "fs", "facts", "clock"] as const;
const AUTHORITY_KEYS = ["duplicateDelivery", "effect", "attempt", "grant", "claim",
  "priorRegistration", "reconciliation"] as const;
const INVALID = Symbol("invalid-launch-input");

export interface ClaudeLaunchSnapshot extends ClaudeLaunchRequest {}

function cloneData(value: unknown, budget = { remaining: 2_048 }, depth = 0): unknown | typeof INVALID {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length <= 65_536 && !value.includes("\0") ? value : INVALID;
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : INVALID;
  if (depth > 16 || budget.remaining-- <= 0) return INVALID;
  if (Array.isArray(value)) {
    if (value.length > 256 || Object.keys(value).length !== value.length ||
        Object.getOwnPropertyDescriptor(value, Symbol.iterator) !== undefined) return INVALID;
    const copy: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) return INVALID;
      const item = cloneData(descriptor.value, budget, depth + 1);
      if (item === INVALID) return INVALID;
      copy.push(item);
    }
    return deepFreeze(copy);
  }
  if (!isPlainRecord(value)) return INVALID;
  const names = Object.keys(value);
  const raw = names.length <= 256 ? snapshotExactRecord(value, names) : null;
  if (raw === null) return INVALID;
  const copy: Record<string, unknown> = {};
  for (const name of names) {
    const item = cloneData(raw[name], budget, depth + 1);
    if (item === INVALID) return INVALID;
    copy[name] = item;
  }
  return deepFreeze(copy);
}

function snapshotRuntime(value: unknown): ClaudeRuntimePinRequest | null {
  const raw = snapshotExactRecord(value, RUNTIME_KEYS);
  if (raw === null || typeof raw["installedRoot"] !== "string" || typeof raw["pinRoot"] !== "string") return null;
  const quotedObservation = cloneData(raw["quotedObservation"]);
  if (quotedObservation === INVALID) return null;
  return Object.freeze({ ...raw, quotedObservation }) as unknown as ClaudeRuntimePinRequest;
}

function snapshotArray(value: unknown): readonly string[] | null {
  try {
    if (!Array.isArray(value) || value.length > 128 || Object.keys(value).length !== value.length ||
      Object.getOwnPropertyDescriptor(value, Symbol.iterator) !== undefined) return null;
    const result: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string" ||
        descriptor.value.length > 4_096 || descriptor.value.includes("\0")) return null;
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch { return null; }
}

function snapshotEnvironment(value: unknown): Readonly<Record<string, string>> | null {
  try {
    if (!isPlainRecord(value)) return null;
    const names = Object.keys(value);
    const raw = snapshotExactRecord(value, names);
    if (raw === null || names.length > 64) return null;
    const result: Record<string, string> = {};
    for (const name of names) {
      const item = raw[name];
      if (typeof item !== "string" || item.length > 8_192 || item.includes("\0")) return null;
      result[name] = item;
    }
    return Object.freeze(result);
  } catch { return null; }
}

export function snapshotClaudeLaunchRequest(value: unknown): ClaudeLaunchSnapshot | null {
  const raw = snapshotExactRecord(value, REQUEST_KEYS);
  if (raw === null) return null;
  const argv = snapshotArray(raw["argv"]);
  const environment = snapshotEnvironment(raw["environment"]);
  const runtime = snapshotRuntime(raw["runtime"]);
  const authority: Record<string, unknown> = {};
  for (const key of AUTHORITY_KEYS) {
    const copied = cloneData(raw[key]);
    if (copied === INVALID) return null;
    authority[key] = copied;
  }
  const limits = snapshotExactRecord(raw["limits"], LIMIT_KEYS);
  const numbers = limits === null ? [] : LIMIT_KEYS.map((key) => limits[key]);
  if (argv === null || environment === null || runtime === null || limits === null ||
    numbers.some((item) => !Number.isSafeInteger(item) || (item as number) <= 0) ||
    (limits["stdoutBytes"] as number) > 1_048_576 || (limits["stderrBytes"] as number) > 1_048_576 ||
    (limits["tailBytes"] as number) > 65_536 || (limits["timeoutMs"] as number) > 600_000 ||
    typeof raw["cwd"] !== "string" || raw["cwd"].length > 32_767 || raw["cwd"].includes("\0") ||
    typeof raw["wrapperIdentity"] !== "string" || !/^[0-9a-f]{64}$/u.test(String(raw["bootstrapCredentialDigest"]))) return null;
  return Object.freeze({ ...raw, ...authority, runtime, argv, environment, limits: Object.freeze({
    stdoutBytes: limits["stdoutBytes"], stderrBytes: limits["stderrBytes"],
    tailBytes: limits["tailBytes"], timeoutMs: limits["timeoutMs"],
  }) }) as unknown as ClaudeLaunchSnapshot;
}
