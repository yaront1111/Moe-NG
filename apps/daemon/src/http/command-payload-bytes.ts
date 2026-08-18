/**
 * The BINARY BOUNDARY of the command seam: a `RuntimeCommandEnvelope.payload` is a
 * `JsonObject`, so bytes cross it as base64 text and are materialized HERE, before any
 * service or codec sees them.
 *
 * DECODE AT THE SEAM, DO NOT WEAKEN THE CODEC — the second design decision this task
 * assigned to the architect. A base64 admission arm inside a request codec would give
 * every other caller of that codec a second, looser way in, and the codec's byte guard is
 * exactly what makes a forged or truncated request refuse. So this module hands over a
 * real `Uint8Array` or nothing at all, and the codec stays the single authority on what a
 * valid request is: bytes it refuses are refused by ITS untouched guard, under ITS code.
 *
 * It reports only WHETHER it could materialize the bytes and, for the caller's own
 * diagnosis, which rule fired. It mints no reason code: the caller maps a refusal onto
 * the code its own codec would have produced, which is what makes a corrupted transport
 * and a corrupted byte payload indistinguishable to the client — neither reveals where
 * the value was rejected.
 */

/** Which rule answered. Diagnostic only, and deliberately never surfaced to a caller. */
export type PayloadBytesRefusal =
  | "BASE64_NOT_CANONICAL"
  | "DECODED_EMPTY"
  | "DECODED_TOO_LARGE"
  | "ENCODED_TOO_LARGE"
  | "NOT_A_STRING";

export type PayloadBytesResult =
  | { readonly bytes: Uint8Array; readonly ok: true }
  | { readonly ok: false; readonly reason: PayloadBytesRefusal };

/** Base64 inflates by 4/3 and pads to a multiple of four. */
export function maxEncodedCharsFor(maxBytes: number): number {
  return Math.ceil(maxBytes / 3) * 4;
}

const CANONICAL_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

const refused = (reason: PayloadBytesRefusal): PayloadBytesResult =>
  Object.freeze({ ok: false as const, reason });

/**
 * One bounded decoder. Refuses rather than throwing on every arm, so a hostile payload
 * field can never reach a caller as an exception it did not expect.
 *
 * THE ENCODED LENGTH IS CHECKED BEFORE THE DECODE, deliberately: a caller who sends four
 * megabytes of base64 for a one-megabyte ceiling would otherwise force the allocation of
 * the very buffer the bound exists to prevent.
 *
 * Canonicality is proved by RE-ENCODING the decoded bytes and comparing: `Buffer` accepts
 * non-canonical trailing bits and stray characters silently, so "it decoded" is not the
 * same claim as "these are the bytes that were sent".
 */
export function decodeBase64PayloadBytes(value: unknown, maxBytes: number): PayloadBytesResult {
  if (typeof value !== "string") return refused("NOT_A_STRING");
  if (value.length > maxEncodedCharsFor(maxBytes)) return refused("ENCODED_TOO_LARGE");
  if (value.length % 4 !== 0 || !CANONICAL_BASE64.test(value)) {
    return refused("BASE64_NOT_CANONICAL");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) return refused("BASE64_NOT_CANONICAL");
  if (decoded.byteLength === 0) return refused("DECODED_EMPTY");
  if (decoded.byteLength > maxBytes) return refused("DECODED_TOO_LARGE");
  // A fresh, detached copy: a `Buffer` is a view onto a pooled ArrayBuffer, and handing a
  // pooled view to a codec that keeps it would let unrelated bytes change under it.
  return Object.freeze({ bytes: Uint8Array.from(decoded), ok: true as const });
}
