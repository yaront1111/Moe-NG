import { isIsoInstant } from "../identity/session-contracts.js";

/**
 * VETTING FOR ONE UNTRUSTED PORT RESULT.
 *
 * `SessionHandshakePort` is an injected interface, so what a mint hands back is
 * structurally untrusted: a hand-written double, a hostile stub, or a future
 * implementation may return any object at all. Everything here answers exactly one
 * question — is this recognisably a mint, or recognisably a refusal — and nothing
 * here decides what the SEAM does about the answer. That split is why the file exists:
 * the handshake stays a policy module and the shape rules stay auditable on their own.
 */

const MINTED_KEYS = Object.freeze([
  "capabilities", "credential", "expiresAt", "ok", "principalId",
]);
const REFUSED_KEYS = Object.freeze(["code", "ok"]);
const DISPOSED_REFUSED_KEYS = Object.freeze(["code", "disposition", "ok"]);
const LAYERED_REFUSED_KEYS = Object.freeze(["code", "layer", "ok"]);
const DISPOSED_LAYERED_KEYS = Object.freeze(["code", "disposition", "layer", "ok"]);
/** Distinguishes "no such own enumerable data property" from a property whose value is null. */
const ABSENT_PROPERTY = Symbol("absent-property");

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validMinted(value: unknown): value is Readonly<{
  readonly capabilities: readonly string[];
  readonly credential: string;
  readonly expiresAt: string;
  readonly ok: true;
  readonly principalId: string;
}> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const capabilities = record["capabilities"];
  const expiresAt = record["expiresAt"];
  return keys.length === MINTED_KEYS.length
    && keys.every((key, index) => key === MINTED_KEYS[index])
    && record["ok"] === true
    && nonEmpty(record["credential"])
    && nonEmpty(record["principalId"])
    && typeof expiresAt === "string"
    && isIsoInstant(expiresAt)
    && Array.isArray(capabilities)
    && capabilities.length > 0
    && capabilities.every(nonEmpty);
}

/** What a validated port refusal is allowed to tell the pairing seam. */
export interface ValidatedRefusal {
  /** Exactly `code` and `layer`, or null when the refusal carried no layer. */
  readonly cause: Readonly<{ readonly code: string; readonly layer: string }> | null;
  /** The declared retry disposition verbatim, or null when the refusal declared none. */
  readonly disposition: string | null;
}

/**
 * Reads an own ENUMERABLE DATA property. A hidden key, an accessor, a prototype
 * carrier or a missing key all read ABSENT_PROPERTY, so no getter is ever invoked
 * and no inherited value can pose as the port's own refusal fact.
 */
function ownDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && descriptor.enumerable === true && "value" in descriptor
    ? descriptor.value
    : ABSENT_PROPERTY;
}

export function validRefused(value: unknown): ValidatedRefusal | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  const hasExactKeys = (expected: readonly string[]): boolean =>
    keys.length === expected.length && expected.every((key) => keys.includes(key));
  // Four exact shapes, each a cross of "carries a layer" and "declares a
  // disposition". `layer` and `disposition` are both optional on the port type so
  // hand-written doubles stay valid, so all four have to be recognisable here.
  const disposedLayered = hasExactKeys(DISPOSED_LAYERED_KEYS);
  const layered = disposedLayered || hasExactKeys(LAYERED_REFUSED_KEYS);
  const disposed = disposedLayered || hasExactKeys(DISPOSED_REFUSED_KEYS);
  if (!layered && !disposed && !hasExactKeys(REFUSED_KEYS)) return null;

  const code = ownDataValue(value, "code");
  if (ownDataValue(value, "ok") !== false || !nonEmpty(code)) return null;

  let cause: Readonly<{ readonly code: string; readonly layer: string }> | null = null;
  if (layered) {
    const layer = ownDataValue(value, "layer");
    if (!nonEmpty(layer)) return null;
    // THE ONE CAUSE CONSTRUCTION: exactly `code` and `layer`, copied field by field
    // from vetted own data values. The port's own object is never forwarded and
    // never spread, so no structural extra can ride into the response or the wire.
    cause = Object.freeze({ code, layer });
  }
  if (!disposed) return Object.freeze({ cause, disposition: null });

  const disposition = ownDataValue(value, "disposition");
  return typeof disposition === "string" ? Object.freeze({ cause, disposition }) : null;
}

