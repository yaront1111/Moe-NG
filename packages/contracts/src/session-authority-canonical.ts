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

export const SESSION_PROOF_PROTOCOL_VERSION = 1 as const;
export const SESSION_PROOF_ALGORITHM = "Ed25519" as const;
export const SESSION_PROOF_DOMAIN = "moe.session-proof.v1" as const;

export type SessionProofChallengeFields = Readonly<{
  principalId: string;
  projectId: string;
  recoveryIncarnationRef: string;
  keyEpochRef: string;
  sessionId: string;
  credentialId: string;
  generation: number;
  clientKeyId: string;
  transportId: string;
  requestId: string;
  requestDigest: string;
  issuedAt: number;
  nonce: string;
}>;

const SESSION_PROOF_FIELDS = [
  "principalId",
  "projectId",
  "recoveryIncarnationRef",
  "keyEpochRef",
  "sessionId",
  "credentialId",
  "generation",
  "clientKeyId",
  "transportId",
  "requestId",
  "requestDigest",
  "issuedAt",
  "nonce",
] as const satisfies readonly (keyof SessionProofChallengeFields)[];

type SessionProofField = (typeof SESSION_PROOF_FIELDS)[number];

const SESSION_PROOF_UTF8 = new TextEncoder();

function readSessionProofValues(value: unknown): readonly unknown[] | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const actual = Reflect.ownKeys(value);
    if (
      actual.length !== SESSION_PROOF_FIELDS.length
      || !actual.every((key) =>
        typeof key === "string" && SESSION_PROOF_FIELDS.includes(key as SessionProofField))
    ) {
      return null;
    }
    const values: unknown[] = [];
    for (const field of SESSION_PROOF_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
      values.push(descriptor.value);
    }
    return values;
  } catch {
    return null;
  }
}

function sessionProofScalar(field: SessionProofField, value: unknown): string {
  if (field === "generation" || field === "issuedAt") {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`invalid ${field}`);
    }
    return String(value);
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`invalid ${field}`);
  }
  return value;
}

function frameSessionProofScalar(value: string): Uint8Array {
  const bytes = SESSION_PROOF_UTF8.encode(value);
  const framed = new Uint8Array(4 + bytes.byteLength);
  new DataView(framed.buffer, framed.byteOffset, 4).setUint32(0, bytes.byteLength, false);
  framed.set(bytes, 4);
  return framed;
}

/**
 * Produces the exact browser-safe bytes signed by a session proof.
 *
 * The domain is deliberately unframed. Each following field is encoded in the
 * fixed protocol order as a four-byte big-endian UTF-8 byte length and its bytes.
 */
export function canonicalSessionProofBytes(fields: SessionProofChallengeFields): Uint8Array {
  const values = readSessionProofValues(fields);
  if (values === null) throw new TypeError("invalid session proof challenge fields");

  const domain = SESSION_PROOF_UTF8.encode(SESSION_PROOF_DOMAIN);
  const frames = SESSION_PROOF_FIELDS.map((field, index) =>
    frameSessionProofScalar(sessionProofScalar(field, values[index])));
  const output = new Uint8Array(
    domain.byteLength + frames.reduce((total, frame) => total + frame.byteLength, 0),
  );
  output.set(domain);
  let offset = domain.byteLength;
  for (const frame of frames) {
    output.set(frame, offset);
    offset += frame.byteLength;
  }
  return output;
}
