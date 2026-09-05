import { createHash } from "node:crypto";

/**
 * The exact external contract for the daemon's per-environment variable store.
 *
 * WHY THE READ SHAPE IS A TYPED CONTRACT HERE rather than an inline object literal in the store.
 * The single property this whole slice exists to hold is that a variable's VALUE never leaves the
 * store. An inline shape is one careless spread away from carrying one; a named, rostered,
 * exact-arity shape means adding a value slot is a visible edit to a file whose tests assert the
 * roster. `ENVIRONMENT_VARIABLE_READ_KEYS` is that roster, and it is asserted by set-equality, so
 * a fifth member cannot be added quietly.
 *
 * WHY THE LAYER IS DERIVED FROM THE CODE. `environmentRefusal` takes no layer argument: the
 * closed `ENVIRONMENT_CODE_LAYERS` map is the single source, so a call site cannot mint a refusal
 * whose code and layer disagree, and the code roster cannot drift from the layer map. This
 * mirrors `planning/expansion-request-contracts.ts`, whose header explains the same choice.
 *
 * WHY REFUSAL DETAILS ARE FIXED PROSE. Details are constants keyed by code, never interpolated.
 * `identity/session-credential-digest.ts:56-64` makes the same rule for the same reason: an
 * interpolated detail is how a secret escapes through the one field a refusal is allowed to
 * carry. Here the stakes are literal - interpolating "value X is too large" would put the
 * operator's secret into every log the refusal reaches, which is precisely the leak this row
 * exists to prevent.
 *
 * This module reads nothing, writes nothing, holds no key and mints no authority.
 */

/** The three environments a project has. Closed: there is no "custom environment" story. */
export const ENVIRONMENT_NAMES = Object.freeze(["preview", "production", "verify"] as const);

export type EnvironmentName = (typeof ENVIRONMENT_NAMES)[number];

/**
 * POSIX-shell-safe variable names only: an uppercase letter, then uppercase letters, digits and
 * underscores. Deliberately narrower than what a shell will tolerate, because these names are
 * destined for a spawned process's environment block (child 2's delivery), and a name carrying
 * `=`, a NUL or a newline is how an environment block gets split into something else.
 */
export const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
export const ENVIRONMENT_VARIABLE_NAME_MAX_LENGTH = 128;

/**
 * Bounded in UTF-8 BYTES, not code units. A value is measured as it will be stored and delivered;
 * counting JavaScript characters would let a value of 4-byte code points reach four times the
 * intended size. 4 KiB comfortably holds a private key or a long connection string.
 */
export const MAX_ENVIRONMENT_VALUE_BYTES = 4_096;

/** Which surface answered a refusal. Closed: a refusal outside this roster is a bug. */
export const ENVIRONMENT_LAYERS = Object.freeze(["KEY", "NAME", "SCOPE", "VALUE"] as const);

export type EnvironmentLayer = (typeof ENVIRONMENT_LAYERS)[number];

/**
 * Every refusal this slice can mint, mapped to the layer that mints it. The code roster below is
 * DERIVED from these keys, so the two can never disagree.
 *
 * ENV_STORE_KEY_UNAVAILABLE covers every way the sealing key fails to produce a readable value:
 * absent credential, unreadable credential, and a credential that is present but WRONG. They
 * share one code on purpose - splitting them would let a caller probe whether a given credential
 * is merely missing or actually incorrect, which is a fact about the secret.
 */
export const ENVIRONMENT_CODE_LAYERS = Object.freeze({
  ENV_ENVIRONMENT_UNKNOWN: "SCOPE",
  ENV_NAME_INVALID: "NAME",
  ENV_STORE_KEY_UNAVAILABLE: "KEY",
  ENV_VALUE_TOO_LARGE: "VALUE",
} as const satisfies Readonly<Record<string, EnvironmentLayer>>);

export type EnvironmentCode = keyof typeof ENVIRONMENT_CODE_LAYERS;

/** Derived, never restated: the roster IS the layer map's key set. */
export const ENVIRONMENT_CODES: readonly EnvironmentCode[] = Object.freeze(
  (Object.keys(ENVIRONMENT_CODE_LAYERS) as EnvironmentCode[]).sort(),
);

/**
 * Fixed prose per code. No template, no number, no name, no value - the tests assert that no
 * detail contains a digit, so a future "must be under 4096 bytes" cannot creep in and start the
 * habit of interpolating the caller's input.
 */
export const ENVIRONMENT_REFUSAL_DETAILS = Object.freeze({
  ENV_ENVIRONMENT_UNKNOWN: "the environment named is not one this project has",
  ENV_NAME_INVALID: "the variable name is not a permitted environment variable name",
  ENV_STORE_KEY_UNAVAILABLE: "the environment store key could not be derived from the daemon credential",
  ENV_VALUE_TOO_LARGE: "the value exceeds the permitted size for an environment variable",
} as const satisfies Readonly<Record<EnvironmentCode, string>>);

export interface EnvironmentRefusal {
  readonly code: EnvironmentCode;
  readonly detail: string;
  readonly layer: EnvironmentLayer;
  readonly ok: false;
}

/**
 * The ONLY way this slice mints a refusal. It takes the code alone: the layer and the detail are
 * looked up, so no call site can pair a code with the wrong layer or attach its own message.
 */
export function environmentRefusal(code: EnvironmentCode): EnvironmentRefusal {
  return Object.freeze({
    code,
    detail: ENVIRONMENT_REFUSAL_DETAILS[code],
    layer: ENVIRONMENT_CODE_LAYERS[code],
    ok: false as const,
  });
}

/**
 * What a read of a variable may say. Four members and nothing else - in particular, no value and
 * no slot a value could be smuggled into. `fingerprintSha256` is the operator's ONLY feedback
 * that an update took effect, since they can never read the value back.
 */
export const ENVIRONMENT_VARIABLE_READ_KEYS = Object.freeze([
  "fingerprintSha256", "isSet", "name", "updatedAt",
] as const);

export interface EnvironmentVariableRead {
  readonly fingerprintSha256: string;
  readonly isSet: true;
  readonly name: string;
  readonly updatedAt: string;
}

export function isEnvironmentName(value: unknown): value is EnvironmentName {
  return typeof value === "string"
    && (ENVIRONMENT_NAMES as readonly string[]).includes(value);
}

export function isEnvironmentVariableName(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= ENVIRONMENT_VARIABLE_NAME_MAX_LENGTH
    && ENVIRONMENT_VARIABLE_NAME_PATTERN.test(value);
}

const textEncoder = new TextEncoder();

export function environmentValueBytes(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function isEnvironmentValueWithinBound(value: unknown): value is string {
  return typeof value === "string"
    && textEncoder.encode(value).byteLength <= MAX_ENVIRONMENT_VALUE_BYTES;
}

/**
 * Lowercase 64-hex sha256 of PLAINTEXT BYTES. Over the plaintext, not the ciphertext, because
 * seals are salted per write: a fingerprint of the ciphertext would change on every write and
 * tell the operator nothing about whether their update actually changed the value.
 *
 * The bytes form is the primitive and the read path uses it directly on what the cipher handed
 * back. Decoding those bytes to a string first would be a needless round trip through a lossy
 * conversion, and would put one more copy of the secret in memory as a string.
 */
export function environmentValueFingerprintOfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function environmentValueFingerprint(value: string): string {
  return environmentValueFingerprintOfBytes(environmentValueBytes(value));
}
