/**
 * THE BROWSER'S SESSION KEY.
 *
 * A Control Room tab generates its own Ed25519 keypair, presents the public half at the
 * pairing claim, and later proves possession by signing the daemon's challenge. Everything
 * here runs on Web Crypto and nothing else: there is no `node:` import in this module and
 * none may be added, because the package root must stay loadable in a browser.
 *
 * THE PRIVATE KEY IS GENERATED NON-EXTRACTABLE. That is stronger than a convention that
 * nobody exports it — with `extractable: false` the material cannot be exported at all,
 * even by a caller who wants to, so "the private key never leaves the browser" is enforced
 * by the platform rather than by our own discipline. (The public half of an asymmetric
 * pair is always exportable regardless of that flag, which is what lets us publish the
 * SPKI below.)
 */

import { sessionAuthorityCanonicalString } from "@moe/contracts";

/** DER SubjectPublicKeyInfo for Ed25519 is 44 bytes, i.e. 88 lowercase hex characters. */
const SPKI_BYTES = 44;

/**
 * KEY TYPES DERIVED FROM THE PLATFORM'S OWN SIGNATURES rather than named.
 *
 * `CryptoKey` and `CryptoKeyPair` are only global TYPES when the `DOM` lib is loaded, and
 * this package compiles under `lib: ["ES2024"]`. Naming them would mean either widening the
 * package's lib or importing from `node:crypto` — and a `node:` import here would break the
 * browser-loadable root that DoD 2 pins. Reading the types off `crypto.subtle` instead keeps
 * them EXACTLY whatever this toolchain says they are, so they cannot drift from the values
 * actually passed back into `exportKey` and `sign`.
 */
type GeneratedKeyMaterial = Awaited<ReturnType<typeof crypto.subtle.generateKey>>;
/**
 * WHAT THIS TOOLCHAIN'S `sign` ACTUALLY ACCEPTS, for the same reason as the key types.
 * A bare `Uint8Array` is `Uint8Array<ArrayBufferLike>`, which the DOM lib's `BufferSource`
 * rejects because a `SharedArrayBuffer` cannot back it — so the client package typechecks
 * (no DOM lib) while `apps/control-room` does not. Reading the parameter off `subtle.sign`
 * makes the signature identical under BOTH tsconfigs.
 */
type SignableBytes = Parameters<typeof crypto.subtle.sign>[2];
type SessionCryptoKeyPair = Extract<GeneratedKeyMaterial, { privateKey: unknown }>;
export type SessionCryptoKey = SessionCryptoKeyPair["privateKey"];

export const SESSION_KEY_LAYER = "CONTROL_ROOM_SESSION_KEY" as const;

/**
 * ONE code, and it is about the HOST rather than about a caller. Nothing here takes an
 * argument, so there is no input to refuse; the only way this can fail is a browser whose
 * Web Crypto has no Ed25519, and a caller needs to tell that apart from a bug.
 */
export const SESSION_KEY_REFUSAL_CODES = Object.freeze([
  "SESSION_KEY_ALGORITHM_UNSUPPORTED",
] as const);

export type SessionKeyRefusalCode = (typeof SESSION_KEY_REFUSAL_CODES)[number];

export interface SessionKeyRefused {
  readonly code: SessionKeyRefusalCode;
  readonly layer: typeof SESSION_KEY_LAYER;
  readonly ok: false;
}

export interface SessionKeyGenerated {
  /**
   * SHA-256 over the DER BYTES, hex-encoded — the same operand and the same algorithm as
   * the daemon's `sessionClientKeyId`. Hashing the hex SPELLING instead would produce a
   * well-formed 64-hex value that no daemon would ever match, which is exactly the kind of
   * wrong-operand bug a shape assertion cannot see.
   */
  readonly clientKeyId: string;
  readonly ok: true;
  readonly privateKey: SessionCryptoKey;
  readonly publicKey: SessionCryptoKey;
  readonly publicKeySpkiHex: string;
}

export type SessionKeyResult = SessionKeyGenerated | SessionKeyRefused;

function refuse(): SessionKeyRefused {
  return Object.freeze({
    code: "SESSION_KEY_ALGORITHM_UNSUPPORTED" as const,
    layer: SESSION_KEY_LAYER,
    ok: false as const,
  });
}

function isKeyPair(value: unknown): value is SessionCryptoKeyPair {
  return typeof value === "object" && value !== null
    && "privateKey" in value && "publicKey" in value;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generates one session keypair and its public identifiers.
 *
 * Refuses only when the host cannot produce an Ed25519 key. Everything after that point —
 * exporting the public SPKI and digesting it — is arithmetic on bytes the platform just
 * handed us, so a failure there is a defect rather than an unsupported browser and is left
 * to throw instead of being folded into the same code.
 */
export async function generateSessionKey(): Promise<SessionKeyResult> {
  let material: unknown;
  try {
    material = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  } catch {
    return refuse();
  }
  // NARROWED, NOT CAST. `generateKey` is overloaded and this toolchain resolves the bare
  // `{name}` form to the SYMMETRIC single-key return, so a cast would be us overruling the
  // compiler about what the platform handed back. Checking instead turns "this host returned
  // something that is not a keypair" into the same coded refusal as "this host has no
  // Ed25519", which is what a caller can actually act on.
  if (!isKeyPair(material)) return refuse();
  const pair = material;
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  if (spki.byteLength !== SPKI_BYTES) return refuse();
  return Object.freeze({
    clientKeyId: toHex(await crypto.subtle.digest("SHA-256", spki)),
    ok: true as const,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeySpkiHex: toHex(spki),
  });
}

/**
 * The OPEN_SESSION request digest, computed the way the daemon computes it.
 *
 * COMPOSED, NEVER REIMPLEMENTED. `sessionAuthorityCanonicalString` arrives by bare specifier
 * from `@moe/contracts` — the same function `sessionAuthorityRequestDigest` calls on the
 * daemon side. A second canonicalisation here would be a copy free to drift, and it would
 * drift at a layer with no arm: the daemon would simply refuse BINDING and no test on either
 * side would say why.
 */
export async function openSessionRequestDigest(fields: unknown): Promise<string> {
  const canonical = new TextEncoder().encode(sessionAuthorityCanonicalString(fields));
  return toHex(await crypto.subtle.digest("SHA-256", canonical));
}

/**
 * Signs one challenge with the session private key.
 *
 * Takes the challenge BYTES rather than the fields, because the canonical proof encoding is
 * the daemon's to define; this function's only job is to apply the key. Keeping the two
 * apart is what lets an arm feed the daemon's own `canonicalSessionProofBytes` in and check
 * the daemon's own verifier accepts what comes out — an end-to-end agreement neither side
 * could claim alone.
 */
export async function signSessionChallenge(
  privateKey: SessionCryptoKey, challenge: SignableBytes,
): Promise<string> {
  return toHex(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, challenge));
}
