import { decodeBoundedJsonBytes } from "@moe/contracts";

/**
 * The body of a read that takes no operand: zero bytes or exactly `{}`. Anything else — a member
 * the read would ignore, another JSON value, or bytes that do not decode — is a malformed request,
 * so a caller can never believe it shaped a read the daemon answered unshaped.
 */
export function emptyBody(body: unknown): boolean {
  if (body instanceof Uint8Array && body.length === 0) return true;
  const decoded = decodeBoundedJsonBytes(body);
  return decoded.ok && typeof decoded.value === "object" && decoded.value !== null
    && !Array.isArray(decoded.value) && Object.keys(decoded.value).length === 0;
}
