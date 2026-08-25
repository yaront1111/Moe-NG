import { snapshotExactRecord } from "../platform-contract.js";
import { CHANNEL_PAYLOAD_CAPS } from "./windows-frames.js";
import { isBoundedText, isLocalAbsolutePath } from "./windows-path-guard.js";
import {
  unknownOutcome,
  type WindowsProcessCode,
  type WindowsProcessUnknown,
} from "./windows-process-contract.js";

/**
 * Hostile-input validation for a launch request, and its encoding into the
 * broker's control payload.
 *
 * EVERY REFUSAL HERE HAPPENS BEFORE THE BROKER EXISTS. That is the point of the
 * module: the process boundary must be able to say "nothing was created" and
 * mean it, which is only true if the request was judged before a binary was
 * resolved or a child was spawned.
 *
 * The encoding mirrors `decode_launch` (native/broker/src/control.rs): text,
 * list, text, pairs — every length and count a LITTLE-ENDIAN u16, every string
 * UTF-8, and the payload consumed exactly.
 */

export const MAX_ARGV_ENTRIES = 128;
export const MAX_ARGUMENT_CHARS = 4096;
export const MAX_ENVIRONMENT_ENTRIES = 64;
export const MAX_ENVIRONMENT_VALUE_CHARS = 8192;

/**
 * The only environment variables that may reach a provider. Upper-case because
 * matching is case-insensitive; deliberately short, because a name that is not
 * here is a deliberate widening rather than an oversight. `NODE_OPTIONS` and
 * the `*_PROXY` family are absent on purpose — both are code-injection seams.
 */
export const ALLOWED_ENVIRONMENT_KEYS = Object.freeze([
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "TEMP",
  "TMP",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "COMMONPROGRAMFILES",
  "USERNAME",
  "COMPUTERNAME",
  "LANG",
  "TZ",
] as const);

const REQUEST_KEYS = Object.freeze(["executable", "argv", "cwd", "environment"] as const);

function refuse(code: WindowsProcessCode, message: string): WindowsProcessUnknown {
  return unknownOutcome(code, "WINDOWS_PROCESS_REQUEST", message);
}

function readArgv(argv: unknown): readonly string[] | WindowsProcessUnknown {
  try {
    if (!Array.isArray(argv) || argv.length > MAX_ARGV_ENTRIES) {
      return refuse("PROCESS_BOUNDARY_ARGV_REJECTED", "argv is not a bounded array");
    }
    if (
      Object.getOwnPropertyDescriptor(argv, Symbol.iterator) !== undefined ||
      Object.keys(argv).length !== argv.length
    ) {
      return refuse("PROCESS_BOUNDARY_ARGV_REJECTED", "argv is sparse or carries extra behavior");
    }
    const snapshot: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(argv, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        return refuse("PROCESS_BOUNDARY_ARGV_REJECTED", "an argument is not a plain data entry");
      }
      if (!isBoundedText(descriptor.value, MAX_ARGUMENT_CHARS)) {
        return refuse("PROCESS_BOUNDARY_ARGV_REJECTED", "an argument is not bounded well-formed text");
      }
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch {
    return refuse("PROCESS_BOUNDARY_ARGV_REJECTED", "argv could not be read as bounded plain data");
  }
}

/**
 * Returns the pairs rather than a boolean, so the encoder writes the exact
 * entries that were validated. Re-reading the caller's record afterwards is how
 * a hostile object passes validation and is then recorded as something else.
 */
function readEnvironment(
  environment: unknown,
  allowedNames: readonly string[],
): readonly (readonly [string, string])[] | WindowsProcessUnknown {
  try {
    return readEnvironmentRecord(environment, allowedNames);
  } catch {
    return refuse(
      "PROCESS_BOUNDARY_ENVIRONMENT_REJECTED",
      "the environment could not be read as bounded plain data",
    );
  }
}

function readEnvironmentRecord(
  environment: unknown,
  allowedNames: readonly string[],
): readonly (readonly [string, string])[] | WindowsProcessUnknown {
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
    return refuse("PROCESS_BOUNDARY_ENVIRONMENT_REJECTED", "the environment is not a record");
  }
  const names = Object.keys(environment);
  const snapshot = snapshotExactRecord(environment, names);
  if (snapshot === null || names.length > MAX_ENVIRONMENT_ENTRIES) {
    return refuse(
      "PROCESS_BOUNDARY_ENVIRONMENT_REJECTED",
      "the environment is not a bounded record of plain data properties",
    );
  }
  const seen = new Set<string>();
  const pairs: (readonly [string, string])[] = [];
  for (const name of names) {
    const upper = name.toUpperCase();
    // Windows collapses `PATH` and `Path` into one variable, so a record
    // carrying both is ambiguous about which value wins; refusing is the only
    // answer that does not silently pick one.
    if (seen.has(upper) || !allowedNames.includes(upper)) {
      return refuse(
        "PROCESS_BOUNDARY_ENVIRONMENT_REJECTED",
        "an environment name is duplicated or outside the allowlist",
      );
    }
    const value = snapshot[name];
    if (!isBoundedText(value, MAX_ENVIRONMENT_VALUE_CHARS)) {
      return refuse(
        "PROCESS_BOUNDARY_ENVIRONMENT_REJECTED",
        "an environment value is not bounded well-formed text",
      );
    }
    seen.add(upper);
    pairs.push([name, value]);
  }
  return pairs;
}

/**
 * Validates a caller-supplied request and returns the control payload.
 *
 * Gate order is load-bearing and is asserted: shape, then executable, then
 * argv, then cwd, then environment, then total size. No input can score better
 * by leaving a field out than by supplying a bad one.
 */
export function encodeLaunchPayload(request: unknown): Uint8Array | WindowsProcessUnknown {
  return encodeLaunchPayloadWithAllowedEnvironment(request, ALLOWED_ENVIRONMENT_KEYS);
}

/**
 * Internal policy seam for another curated Windows boundary. Callers must pass
 * a frozen reviewed roster; the provider entry above always keeps its original
 * roster and cannot be widened through its public signature.
 */
export function encodeLaunchPayloadWithAllowedEnvironment(
  request: unknown,
  allowedNames: readonly string[],
  injectedEnvironment: readonly (readonly [string, string])[] = [],
): Uint8Array | WindowsProcessUnknown {
  try {
    return encodeChecked(request, allowedNames, injectedEnvironment);
  } catch {
    return refuse(
      "PROCESS_BOUNDARY_REQUEST_MALFORMED",
      "the request could not be read as an exact plain-data record",
    );
  }
}

function encodeChecked(
  request: unknown,
  allowedNames: readonly string[],
  injectedEnvironment: readonly (readonly [string, string])[],
): Uint8Array | WindowsProcessUnknown {
  const snapshot = snapshotExactRecord(request, REQUEST_KEYS);
  if (snapshot === null) {
    return refuse(
      "PROCESS_BOUNDARY_REQUEST_MALFORMED",
      "the request is not an exact record of executable, argv, cwd and environment",
    );
  }
  const executable = snapshot["executable"];
  if (!isLocalAbsolutePath(executable)) {
    return refuse(
      "PROCESS_BOUNDARY_EXECUTABLE_REJECTED",
      "the executable is not a bounded local drive-absolute path",
    );
  }
  const argv = readArgv(snapshot["argv"]);
  if (!Array.isArray(argv)) {
    return argv as WindowsProcessUnknown;
  }
  const cwd = snapshot["cwd"];
  if (!isLocalAbsolutePath(cwd)) {
    return refuse(
      "PROCESS_BOUNDARY_CWD_REJECTED",
      "the working directory is not a bounded local drive-absolute path",
    );
  }
  const environment = readEnvironment(snapshot["environment"], allowedNames);
  if (!Array.isArray(environment)) {
    return environment as WindowsProcessUnknown;
  }
  const augmented = [...environment];
  const seen = new Set(augmented.map(([name]) => name.toUpperCase()));
  for (const [name, value] of injectedEnvironment) {
    const upper = name.toUpperCase();
    if (seen.has(upper) || !allowedNames.includes(upper)
      || !isBoundedText(name, MAX_ARGUMENT_CHARS)
      || !isBoundedText(value, MAX_ENVIRONMENT_VALUE_CHARS)) {
      return refuse(
        "PROCESS_BOUNDARY_ENVIRONMENT_REJECTED",
        "an injected environment entry is invalid or duplicates caller data",
      );
    }
    seen.add(upper);
    augmented.push([name, value]);
  }
  if (augmented.length > MAX_ENVIRONMENT_ENTRIES) {
    return refuse("PROCESS_BOUNDARY_ENVIRONMENT_REJECTED", "the environment is oversized");
  }
  return sized(encode(executable, argv, cwd, augmented));
}

function sized(payload: Uint8Array): Uint8Array | WindowsProcessUnknown {
  if (payload.length > CHANNEL_PAYLOAD_CAPS.CONTROL) {
    return refuse(
      "PROCESS_BOUNDARY_REQUEST_OVERSIZED",
      "the encoded launch request is larger than the control channel's cap",
    );
  }
  return payload;
}

const UTF8 = new TextEncoder();

/** A u16 little-endian length or count. */
function count(value: number): readonly number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

/** A u16-length-prefixed UTF-8 string; the length counts BYTES, not characters. */
function text(value: string): readonly number[] {
  const encoded = UTF8.encode(value);
  return [...count(encoded.length), ...encoded];
}

function encode(
  executable: string,
  argv: readonly string[],
  cwd: string,
  environment: readonly (readonly [string, string])[],
): Uint8Array {
  const bytes: number[] = [...text(executable), ...count(argv.length)];
  for (const argument of argv) {
    bytes.push(...text(argument));
  }
  bytes.push(...text(cwd), ...count(environment.length));
  for (const [name, value] of environment) {
    bytes.push(...text(name), ...text(value));
  }
  return Uint8Array.from(bytes);
}
