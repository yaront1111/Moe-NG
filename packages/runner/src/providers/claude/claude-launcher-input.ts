import { deepFreeze, isPlainRecord } from "../../canonical.js";
import { snapshotExactRecord } from "../../platform/platform-contract.js";
import { type ClaudeRuntimePinRequest } from "./claude-runtime-pin.js";
import { type ClaudeLaunchRequest } from "./claude-launcher-contract.js";
import { isHostileObject, snapshotLaunchSelection,
  type ClaudeLaunchSelection } from "./claude-launch-selection.js";

/**
 * This list and `ClaudeLaunchRequest` must name the SAME set: `snapshotExactRecord`
 * length-checks `Object.keys` against it, so a field added on one side only makes
 * EVERY request snapshot null and every launch refuse CLAUDE_LAUNCH_REQUEST_MALFORMED
 * — not just the new path. There is no test for this module, so that drift would
 * surface as a wave of generic malformed refusals in unrelated suites.
 */
const REQUEST_KEYS = ["runtime", "duplicateDelivery", "effect", "attempt", "grant", "claim",
  "wrapperIdentity", "bootstrapCredentialDigest", "priorRegistration", "argv", "cwd", "environment",
  "reconciliation", "limits", "launchSelection"] as const;
/**
 * Compile-time proof that the two sides agree, in BOTH directions. Either alias
 * resolves to something other than `never` the moment one side gains a name the
 * other lacks, and a non-`never` type cannot satisfy the `extends never`
 * constraint — so the drift becomes a named compile error here instead of an
 * anonymous wave of malformed refusals in someone else's suite.
 */
export type RequestKeyIsDeclared<
  _K extends never = Exclude<(typeof REQUEST_KEYS)[number], keyof ClaudeLaunchRequest>,
> = true;
export type DeclaredFieldHasKey<
  _F extends never = Exclude<keyof ClaudeLaunchRequest, (typeof REQUEST_KEYS)[number]>,
> = true;
const LIMIT_KEYS = ["stdoutBytes", "stderrBytes", "tailBytes", "timeoutMs"] as const;
const RUNTIME_KEYS = ["quotedObservation", "installedRoot", "pinRoot", "fs", "facts", "clock"] as const;
const AUTHORITY_KEYS = ["duplicateDelivery", "effect", "attempt", "grant", "claim",
  "priorRegistration", "reconciliation"] as const;
const INVALID = Symbol("invalid-launch-input");
/**
 * argv and the environment are the two operands the SELECTION gate owns, so a
 * hostile shape in either has to reach that gate's vocabulary rather than be
 * restamped as a generic malformed request — the same reasoning that already
 * hands the gate a null selection instead of answering for it.
 *
 * It is a distinct value rather than `null` because the two answers pick
 * different layers, and collapsing them would make TELEMETRY_CONFIGURATION
 * unreachable for exactly the inputs most worth naming precisely.
 */
export const HOSTILE_LAUNCH_OPERAND = Symbol("hostile-launch-operand");
export type LaunchRequestSnapshot =
  ClaudeLaunchSnapshot | null | typeof HOSTILE_LAUNCH_OPERAND;

/**
 * The snapshot differs from the request in exactly one place: a selection that
 * does not snapshot becomes `null` rather than collapsing the whole request.
 *
 * That is the difference between a caller being told its SELECTION is unusable,
 * at TELEMETRY_CONFIGURATION, and being told its request is malformed somewhere
 * — the same generic answer a bad `cwd` produces. The launcher's selection gate
 * is the only thing entitled to name a selection defect, so this module hands
 * it the absence instead of answering first. The hostile value itself is NOT
 * carried through: only the null survives, so nothing downstream can be made to
 * read a trap.
 */
export interface ClaudeLaunchSnapshot extends Omit<ClaudeLaunchRequest, "launchSelection"> {
  readonly launchSelection: ClaudeLaunchSelection | null;
}

function cloneData(value: unknown, budget = { remaining: 2_048 }, depth = 0): unknown | typeof INVALID {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length <= 65_536 && !value.includes("\0") ? value : INVALID;
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : INVALID;
  if (depth > 16 || budget.remaining-- <= 0) return INVALID;
  // Before `Array.isArray`, before any descriptor read: reflection is what runs
  // a trap, and a trap that has run has already had its effect no matter what
  // this function decides afterwards. Catching the throw of a trap that already
  // executed is containment, not refusal.
  if (isHostileObject(value)) return INVALID;
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
  if (isHostileObject(value)) return null;
  const raw = snapshotExactRecord(value, RUNTIME_KEYS);
  if (raw === null || typeof raw["installedRoot"] !== "string" || typeof raw["pinRoot"] !== "string") return null;
  const quotedObservation = cloneData(raw["quotedObservation"]);
  if (quotedObservation === INVALID) return null;
  return Object.freeze({ ...raw, quotedObservation }) as unknown as ClaudeRuntimePinRequest;
}

function snapshotArray(value: unknown): readonly string[] | null | typeof HOSTILE_LAUNCH_OPERAND {
  if (isHostileObject(value)) return HOSTILE_LAUNCH_OPERAND;
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

function snapshotEnvironment(
  value: unknown,
): Readonly<Record<string, string>> | null | typeof HOSTILE_LAUNCH_OPERAND {
  if (isHostileObject(value)) return HOSTILE_LAUNCH_OPERAND;
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

export function snapshotClaudeLaunchRequest(value: unknown): LaunchRequestSnapshot {
  // The FIRST reflection on this call path is the exact-record read below, so
  // the request itself is proven non-hostile ahead of it. `raw` then holds the
  // operands by reference, unread — naming a proxy is not reflecting on it, so
  // the per-operand checks that follow still run before any trap could.
  if (isHostileObject(value)) return null;
  const raw = snapshotExactRecord(value, REQUEST_KEYS);
  if (raw === null) return null;
  const argv = snapshotArray(raw["argv"]);
  const environment = snapshotEnvironment(raw["environment"]);
  if (argv === HOSTILE_LAUNCH_OPERAND || environment === HOSTILE_LAUNCH_OPERAND) {
    return HOSTILE_LAUNCH_OPERAND;
  }
  const runtime = snapshotRuntime(raw["runtime"]);
  const authority: Record<string, unknown> = {};
  for (const key of AUTHORITY_KEYS) {
    const copied = cloneData(raw[key]);
    if (copied === INVALID) return null;
    authority[key] = copied;
  }
  if (isHostileObject(raw["limits"])) return null;
  const limits = snapshotExactRecord(raw["limits"], LIMIT_KEYS);
  const numbers = limits === null ? [] : LIMIT_KEYS.map((key) => limits[key]);
  const launchSelection = snapshotLaunchSelection(raw["launchSelection"]);
  if (argv === null || environment === null || runtime === null || limits === null ||
    numbers.some((item) => !Number.isSafeInteger(item) || (item as number) <= 0) ||
    (limits["stdoutBytes"] as number) > 1_048_576 || (limits["stderrBytes"] as number) > 1_048_576 ||
    (limits["tailBytes"] as number) > 65_536 || (limits["timeoutMs"] as number) > 600_000 ||
    typeof raw["cwd"] !== "string" || raw["cwd"].length > 32_767 || raw["cwd"].includes("\0") ||
    typeof raw["wrapperIdentity"] !== "string" || !/^[0-9a-f]{64}$/u.test(String(raw["bootstrapCredentialDigest"]))) return null;
  return Object.freeze({ ...raw, ...authority, runtime, argv, environment, launchSelection,
    limits: Object.freeze({
    stdoutBytes: limits["stdoutBytes"], stderrBytes: limits["stderrBytes"],
    tailBytes: limits["tailBytes"], timeoutMs: limits["timeoutMs"],
  }) }) as unknown as ClaudeLaunchSnapshot;
}
