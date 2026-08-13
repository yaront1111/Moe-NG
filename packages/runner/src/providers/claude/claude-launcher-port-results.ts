import { types } from "node:util";

import { isHex64 } from "../../canonical.js";
import { parseActivationGrant } from "../../supervisor/effect-parse.js";
import { SUPERVISOR_ERROR_CODES, SUPERVISOR_LAYERS,
  type ActivationGrant } from "../../supervisor/effect-kernel.js";
import { exactRecord, isRef, oneOf, readOwnDataProperty } from "../../supervisor/effect-shape.js";
import { parseLaunchLockRegistration,
  type LaunchLockRegistration } from "../../supervisor/launch-lock.js";
import { CLAUDE_RUNTIME_PIN_ERROR_CODES, CLAUDE_RUNTIME_PIN_LAYER,
  CLAUDE_RUNTIME_PIN_VERSION } from "./claude-runtime-pin-closure.js";
import { CLAUDE_LAUNCH_ERROR_CODES, CLAUDE_LAUNCH_LAYERS,
  type ClaudeLaunchErrorCode, type ClaudeLaunchLayer,
  type ClaudeLauncherDependencies } from "./claude-launcher-contract.js";

/**
 * Total decoding for everything an injected launcher port HANDS BACK.
 *
 * A `try` around the call only contains a throw. A fulfilled Proxy, an accessor,
 * an optimistic `{kind:"CONSUMED"}` missing its payload, or a raw thenable all
 * return normally and then reject the caller's promise — or worse, advance
 * authority — the moment a discriminant is read. So nothing here reads a
 * property directly: it is lifted out of its own DATA descriptor, validated
 * with the production parsers, and copied into a frozen local record.
 */
export type PortDecision<T> =
  | { readonly kind: "OK"; readonly value: T }
  | { readonly kind: "REFUSED"; readonly code: ClaudeLaunchErrorCode; readonly layer: ClaudeLaunchLayer }
  | { readonly kind: "MALFORMED" };
const MALFORMED: PortDecision<never> = Object.freeze({ kind: "MALFORMED" as const });
const FAILURE_KEYS = ["ok", "code", "layer", "message", "detail"] as const;
const DETAIL_KEYS = ["state", "command", "leg"] as const;
const OUTCOME_REFUSED_KEYS = ["kind", "failure"] as const, EXITED_KEYS = ["kind", "ok", "launched"] as const;
const ADOPTED_KEYS = ["kind", "ok", "processIdentity", "lockIdentity", "wrapperIdentity"] as const;
const COMMIT_KEYS = ["kind", "ok", "activationDigest"] as const;
const GRANT_KEYS = ["kind", "ok", "grant", "versionDelta"] as const;
const REGISTERED_KEYS = ["kind", "ok", "registration"] as const;
const LEASE_OK_KEYS = ["ok", "lease"] as const;
const LEASE_REFUSED_KEYS = ["ok", "code", "layer", "message"] as const;
const RUNTIME_KEYS = ["ok", "preparationVersion", "quotedObservationDigest",
  "freshObservationDigest", "pinnedClosureDigest", "pinnedRoot", "pinRootIdentity",
  "executablePath", "observation", "bindingDigest"] as const;
const RUNTIME_REFUSED_KEYS = ["ok", "code", "layer", "truthClass", "message"] as const;
const PORT_KEYS = ["prepareRuntime", "resolveDuplicate", "validateCommit", "consumeGrant",
  "acquireLock", "openBoundary", "registerLock", "observeProcess", "now", "delay"] as const;
const MAX_PATH_CHARS = 32_767, PROTOTYPE_DEPTH = 4;

export function isSafeObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  try { return !types.isProxy(value); } catch { return false; }
}
/** An instanceof check walks a prototype chain a hostile trap can throw from. */
export function isInstance<T>(value: unknown, type: { readonly prototype: T }): value is T {
  try { return value instanceof (type as Function); } catch { return false; }
}

/** `await` on a raw thenable runs foreign code; only a native Promise may be awaited. */
export function isSafeNativePromise(value: unknown): value is Promise<unknown> {
  if (!isSafeObject(value)) return false;
  try { if (!types.isPromise(value)) return false; } catch { return false; }
  return ["then", "catch", "finally", "constructor"].every((key) => {
    const read = readOwnDataProperty(value, key);
    return read.ok && !read.present;
  });
}

export type Capability = (...args: readonly unknown[]) => unknown;

/**
 * Binds a method without invoking an accessor. The bounded walk crosses prototypes
 * because a live boundary is a CLASS instance — `BrokerSession` keeps `cancel` and
 * `close` on its prototype — so a plain-record reader would refuse production.
 */
export function readCapability(source: unknown, key: string): Capability | null {
  if (!isSafeObject(source)) return null;
  let current: object | null = source;
  for (let depth = 0; depth < PROTOTYPE_DEPTH && current !== null; depth += 1) {
    const read = readOwnDataProperty(current, key);
    if (!read.ok) return null;
    if (read.present) {
      const candidate = read.value;
      if (typeof candidate !== "function") return null;
      try { if (types.isProxy(candidate)) return null; } catch { return null; }
      return (...args: readonly unknown[]): unknown => Reflect.apply(candidate, source, args);
    }
    try { current = Object.getPrototypeOf(current) as object | null; } catch { return null; }
    if (current !== null && !isSafeObject(current)) return null;
  }
  return null;
}

export interface LaunchEntry {
  readonly platform: string; readonly signal: AbortSignal | undefined; readonly deps: unknown;
}

/** The options record is caller data too: a throwing getter must not escape. */
export function snapshotLaunchEntry(options: unknown, hostPlatform: string): LaunchEntry | null {
  if (options === undefined) {
    return Object.freeze({ platform: hostPlatform, signal: undefined, deps: undefined });
  }
  if (!isSafeObject(options)) return null;
  const platform = readOwnDataProperty(options, "platform");
  const signal = readOwnDataProperty(options, "signal");
  const deps = readOwnDataProperty(options, "deps");
  if (!platform.ok || !signal.ok || !deps.ok) return null;
  const platformValue = platform.present ? platform.value : hostPlatform;
  if (typeof platformValue !== "string") return null;
  const signalValue = signal.present ? signal.value : undefined;
  if (signalValue !== undefined && (!isSafeObject(signalValue) || !isInstance(signalValue, AbortSignal))) return null;
  return Object.freeze({ platform: platformValue, signal: signalValue,
    deps: deps.present ? deps.value : undefined });
}

export function snapshotLauncherPorts(value: unknown): ClaudeLauncherDependencies | null {
  const bound: Record<string, Capability> = {};
  for (const key of PORT_KEYS) {
    const capability = readCapability(value, key);
    if (capability === null) return null;
    bound[key] = capability;
  }
  return Object.freeze(bound) as unknown as ClaudeLauncherDependencies;
}

function isPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PATH_CHARS &&
    !value.includes("\0") && value.isWellFormed();
}

/** Preserves a delegated code and layer only after the WHOLE failure validates. */
function supervisorRefusal(value: unknown): PortDecision<never> {
  const parsed = exactRecord(value, FAILURE_KEYS);
  if (parsed === null || parsed["ok"] !== false || typeof parsed["message"] !== "string") return MALFORMED;
  if (!oneOf(parsed["code"], SUPERVISOR_ERROR_CODES) || !oneOf(parsed["layer"], SUPERVISOR_LAYERS)) {
    return MALFORMED;
  }
  const detail = exactRecord(parsed["detail"], DETAIL_KEYS);
  if (detail === null) return MALFORMED;
  for (const key of DETAIL_KEYS) {
    if (detail[key] !== null && typeof detail[key] !== "string") return MALFORMED;
  }
  return Object.freeze({ kind: "REFUSED" as const, code: parsed["code"], layer: parsed["layer"] });
}

export function decodeRefusedArm(value: unknown): PortDecision<never> | null {
  const parsed = exactRecord(value, OUTCOME_REFUSED_KEYS);
  if (parsed === null) return null;
  return parsed["kind"] === "REFUSED" || parsed["kind"] === "SUSPECT"
    ? supervisorRefusal(parsed["failure"]) : MALFORMED;
}

export interface DecodedDuplicate {
  readonly kind: "ADOPTED" | "EXIT_BEFORE_LAUNCH"; readonly processIdentity: string | null;
}

export function decodeDuplicate(value: unknown): PortDecision<DecodedDuplicate> {
  const refused = decodeRefusedArm(value);
  if (refused !== null) return refused;
  const adopted = exactRecord(value, ADOPTED_KEYS);
  if (adopted !== null) {
    if (adopted["kind"] !== "ADOPTED" || adopted["ok"] !== true) return MALFORMED;
    if (!isRef(adopted["processIdentity"]) || !isRef(adopted["lockIdentity"]) ||
      !isRef(adopted["wrapperIdentity"])) return MALFORMED;
    return Object.freeze({ kind: "OK" as const, value: Object.freeze(
      { kind: "ADOPTED" as const, processIdentity: adopted["processIdentity"] }) });
  }
  const exited = exactRecord(value, EXITED_KEYS);
  if (exited === null || exited["kind"] !== "EXIT_BEFORE_LAUNCH" || exited["ok"] !== true ||
    exited["launched"] !== false) return MALFORMED;
  return Object.freeze({ kind: "OK" as const, value: Object.freeze(
    { kind: "EXIT_BEFORE_LAUNCH" as const, processIdentity: null }) });
}

export interface DecodedRuntime {
  readonly executablePath: string; readonly bindingDigest: string;
  readonly quotedObservationDigest: string; readonly freshObservationDigest: string;
  readonly pinnedClosureDigest: string;
}

export function decodeRuntime(value: unknown): PortDecision<DecodedRuntime> {
  const refused = exactRecord(value, RUNTIME_REFUSED_KEYS);
  if (refused !== null) {
    if (refused["ok"] !== false || refused["truthClass"] !== "UNKNOWN") return MALFORMED;
    if (refused["layer"] !== CLAUDE_RUNTIME_PIN_LAYER || typeof refused["message"] !== "string" ||
      !oneOf(refused["code"], CLAUDE_RUNTIME_PIN_ERROR_CODES)) return MALFORMED;
    return Object.freeze({ kind: "REFUSED" as const, code: refused["code"],
      layer: CLAUDE_RUNTIME_PIN_LAYER });
  }
  const parsed = exactRecord(value, RUNTIME_KEYS);
  if (parsed === null || parsed["ok"] !== true) return MALFORMED;
  if (parsed["preparationVersion"] !== CLAUDE_RUNTIME_PIN_VERSION) return MALFORMED;
  if (!isHex64(parsed["quotedObservationDigest"]) || !isHex64(parsed["freshObservationDigest"]) ||
    !isHex64(parsed["pinnedClosureDigest"]) || !isHex64(parsed["bindingDigest"])) return MALFORMED;
  if (!isPath(parsed["executablePath"]) || !isPath(parsed["pinnedRoot"]) ||
    !isRef(parsed["pinRootIdentity"])) return MALFORMED;
  return Object.freeze({ kind: "OK" as const, value: Object.freeze({
    executablePath: parsed["executablePath"], bindingDigest: parsed["bindingDigest"],
    quotedObservationDigest: parsed["quotedObservationDigest"],
    freshObservationDigest: parsed["freshObservationDigest"], pinnedClosureDigest: parsed["pinnedClosureDigest"] }) });
}

export function decodeCommit(value: unknown): PortDecision<string> {
  const refused = decodeRefusedArm(value);
  if (refused !== null) return refused;
  const parsed = exactRecord(value, COMMIT_KEYS);
  if (parsed === null || parsed["kind"] !== "COHERENT" || parsed["ok"] !== true) return MALFORMED;
  if (!isHex64(parsed["activationDigest"])) return MALFORMED;
  return Object.freeze({ kind: "OK" as const, value: parsed["activationDigest"] });
}

export function decodeGrant(value: unknown): PortDecision<ActivationGrant> {
  const refused = decodeRefusedArm(value);
  if (refused !== null) return refused;
  const parsed = exactRecord(value, GRANT_KEYS);
  if (parsed === null || parsed["kind"] !== "CONSUMED" || parsed["ok"] !== true) return MALFORMED;
  if (parsed["versionDelta"] !== 1) return MALFORMED;
  const grant = parseActivationGrant(parsed["grant"]);
  if (grant === null || grant.state !== "CONSUMED") return MALFORMED;
  return Object.freeze({ kind: "OK" as const, value: Object.freeze({ grantId: grant.grantId,
    intentId: grant.intentId, wrapperIdentity: grant.wrapperIdentity, state: grant.state, version: grant.version }) });
}

export function decodeRegistration(value: unknown): PortDecision<LaunchLockRegistration> {
  const refused = decodeRefusedArm(value);
  if (refused !== null) return refused;
  const parsed = exactRecord(value, REGISTERED_KEYS);
  if (parsed === null || parsed["kind"] !== "REGISTERED" || parsed["ok"] !== true) return MALFORMED;
  const registration = parseLaunchLockRegistration(parsed["registration"]);
  if (registration === null) return MALFORMED;
  return Object.freeze({ kind: "OK" as const, value: Object.freeze({
    lockIdentity: registration.lockIdentity, wrapperIdentity: registration.wrapperIdentity,
    processIdentity: registration.processIdentity, registeredAt: registration.registeredAt,
    bootstrapCredentialDigest: registration.bootstrapCredentialDigest }) });
}

export interface DecodedLease { readonly release: Capability }

export function decodeLease(value: unknown): PortDecision<DecodedLease> {
  const refused = exactRecord(value, LEASE_REFUSED_KEYS);
  if (refused !== null) {
    if (refused["ok"] !== false || typeof refused["message"] !== "string") return MALFORMED;
    if (!oneOf(refused["code"], CLAUDE_LAUNCH_ERROR_CODES) ||
      !oneOf(refused["layer"], CLAUDE_LAUNCH_LAYERS)) return MALFORMED;
    return Object.freeze({ kind: "REFUSED" as const, code: refused["code"], layer: refused["layer"] });
  }
  const parsed = exactRecord(value, LEASE_OK_KEYS);
  if (parsed === null || parsed["ok"] !== true) return MALFORMED;
  const release = readCapability(parsed["lease"], "release");
  if (release === null) return MALFORMED;
  return Object.freeze({ kind: "OK" as const, value: Object.freeze({ release }) });
}
