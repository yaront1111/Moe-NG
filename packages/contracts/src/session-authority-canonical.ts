/**
 * The canonical byte-string every session-authority v1 digest is computed over.
 *
 * EXTRACTED, NOT REWRITTEN. This is `canonicalJson` moved verbatim out of
 * `apps/daemon/src/identity/session-authority-protocol.ts`, which now composes it
 * rather than keeping a copy. It lives here because a browser must produce the same
 * bytes the daemon does in order to sign an OPEN_SESSION request, and `apps/daemon`
 * is an application: `apps/control-room` cannot import from it, and this repo has no
 * tsconfig `paths` and no project references, so there was no edge to compose across.
 *
 * IT RETURNS THE STRING AND DOES NOT HASH, deliberately. Hashing is per-platform —
 * `node:crypto` in the daemon, `crypto.subtle.digest` in the browser — and
 * `crypto.subtle` is asynchronous while every existing daemon caller of
 * `sessionAuthorityRequestDigest` is synchronous. Exporting an async digest from here
 * would push that asynchrony into callers this extraction is supposed to be invisible to.
 *
 * THIS MODULE MUST STAY FREE OF `node:` IMPORTS. It is loaded by the browser bundle.
 *
 * It is also NOT interchangeable with the canonicaliser in
 * `distribution/distribution-contract.ts`, despite the shared name and package: that one
 * has no depth cap and no safe-integer refusal, so it accepts inputs this one rejects and
 * would produce different bytes for them. Swapping either for the other silently
 * re-canonicalises — and therefore invalidates — every signature already persisted under
 * the old bytes. Ten independent per-domain canonicalisers exist across this repo; that
 * separation is deliberate.
 */

/** Mirrors `SESSION_AUTHORITY_SCHEMA_VERSION` in the daemon's session-authority contracts. */
export const SESSION_AUTHORITY_SCHEMA_VERSION = "moe.session-authority.v1" as const;

const MAX_CANONICAL_DEPTH = 8;

function canonicalJson(value: unknown, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH) throw new TypeError("canonical value nested too deeply");
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("canonical numbers are safe integers");
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("unsupported canonical value");
}

/**
 * The exact string a session-authority digest hashes.
 *
 * Object key order is normalised and array order is preserved, so a caller and the daemon
 * cannot disagree about a digest merely by constructing a record differently — while a
 * reordered array stays a different request, because order is meaningful there.
 *
 * Unrepresentable values throw rather than being dropped: a silent drop would let two
 * materially different requests canonicalise to the same bytes and therefore share one
 * signature.
 */
export function sessionAuthorityCanonicalString(value: unknown): string {
  return `${SESSION_AUTHORITY_SCHEMA_VERSION}:${canonicalJson(value, 0)}`;
}
