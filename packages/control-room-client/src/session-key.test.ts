import { canonicalSessionProofBytes } from "@moe/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const DAEMON_PROTOCOL_URL = new URL(
  "../../../apps/daemon/src/identity/session-authority-protocol.js",
  import.meta.url,
).href;

interface DaemonProtocol {
  readonly sessionAuthorityRequestDigest: (value: unknown) => string;
  readonly sessionClientKeyId: (publicKeySpkiHex: unknown) => string | null;
  readonly verifySessionProofOverChallenge: (
    publicKeySpkiHex: unknown, fields: Record<string, unknown>, signatureHex: unknown,
  ) => boolean;
}

const DAEMON_PROTOCOL_MEMBERS = [
  "sessionAuthorityRequestDigest", "sessionClientKeyId", "verifySessionProofOverChallenge",
] as const;

function isDaemonProtocol(value: unknown): value is DaemonProtocol {
  return typeof value === "object" && value !== null
    && DAEMON_PROTOCOL_MEMBERS.every((member) => member in value
      && typeof (value as Record<string, unknown>)[member] === "function");
}

async function loadDaemonProtocol(): Promise<DaemonProtocol> {
  const loaded: unknown = await import(/* @vite-ignore */ DAEMON_PROTOCOL_URL);
  if (!isDaemonProtocol(loaded)) throw new TypeError("daemon protocol export is unavailable");
  return loaded;
}

async function loadSessionKeyModule(): Promise<typeof import("./session-key.js")> {
  try {
    return await import("./session-key.js");
  } catch (error) {
    expect.fail(`session-key implementation is unavailable: ${String(error)}`);
  }
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function generatedKey() {
  const { generateSessionKey } = await loadSessionKeyModule();
  const result = await generateSessionKey();
  expect(result.ok).toBe(true);
  if (!result.ok) expect.fail(`key generation refused with ${result.code}`);
  return result;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generateSessionKey", () => {
  it("returns one non-extractable Ed25519 key with canonical public identifiers", async () => {
    const result = await generatedKey();

    expect(result.publicKeySpkiHex).toMatch(/^[0-9a-f]{88}$/u);
    expect(result.clientKeyId).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.privateKey.type).toBe("private");
    expect(result.privateKey.extractable).toBe(false);
    expect(result.privateKey.algorithm.name).toBe("Ed25519");
  });

  it("derives the same client key id as the daemon from the same public key", async () => {
    const result = await generatedKey();
    const daemon = await loadDaemonProtocol();

    expect(daemon.sessionClientKeyId(result.publicKeySpkiHex)).toBe(result.clientKeyId);
  });

  it("hashes the SPKI bytes rather than their lowercase-hex spelling", async () => {
    const result = await generatedKey();
    const wrongOperand = new TextEncoder().encode(result.publicKeySpkiHex);
    const wrongDigest = hex(await crypto.subtle.digest("SHA-256", wrongOperand));

    expect(wrongDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(wrongDigest).not.toBe(result.clientKeyId);
  });

  it("makes the private key non-extractable while the public-key export path works", async () => {
    const result = await generatedKey();
    const publicSpki = await crypto.subtle.exportKey("spki", result.publicKey);
    const privateExport = await crypto.subtle.exportKey("pkcs8", result.privateKey).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ error, ok: false as const }),
    );

    expect(publicSpki.byteLength).toBe(44);
    expect(privateExport.ok).toBe(false);
    if (privateExport.ok) return;
    expect(privateExport.error).toBeInstanceOf(DOMException);
    expect((privateExport.error as DOMException).name).toBe("InvalidAccessException");
  });

  it("returns a stable browser-crypto refusal when Ed25519 is unavailable", async () => {
    const { generateSessionKey } = await loadSessionKeyModule();
    const generateKey = vi.fn(() => Promise.reject(
      new DOMException("Ed25519 is unavailable", "NotSupportedError"),
    ));
    vi.stubGlobal("crypto", { subtle: { generateKey } });

    expect(await generateSessionKey()).toStrictEqual({
      code: "SESSION_KEY_ALGORITHM_UNSUPPORTED",
      layer: "CONTROL_ROOM_SESSION_KEY",
      ok: false,
    });
    expect(generateKey).toHaveBeenCalledTimes(1);
  });

  it("refuses a non-keypair before otherwise-valid export and digest operations", async () => {
    const { generateSessionKey } = await loadSessionKeyModule();
    const generateKey = vi.fn(async () => Object.freeze({ privateKey: Object.freeze({}) }));
    const exportKey = vi.fn(async () => new Uint8Array(44).buffer);
    const digest = vi.fn(async () => new Uint8Array(32).buffer);
    vi.stubGlobal("crypto", { subtle: { digest, exportKey, generateKey } });

    const result = await generateSessionKey();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result).toStrictEqual({
      code: "SESSION_KEY_ALGORITHM_UNSUPPORTED",
      layer: "CONTROL_ROOM_SESSION_KEY",
      ok: false,
    });
    expect(generateKey).toHaveBeenCalledTimes(1);
    expect(exportKey).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled();
  });

  it("refuses a wrong-width SPKI before an otherwise-valid digest operation", async () => {
    const { generateSessionKey } = await loadSessionKeyModule();
    const generateKey = vi.fn(async () => Object.freeze({
      privateKey: Object.freeze({}),
      publicKey: Object.freeze({}),
    }));
    const exportKey = vi.fn(async () => new Uint8Array(43).buffer);
    const digest = vi.fn(async () => new Uint8Array(32).buffer);
    vi.stubGlobal("crypto", { subtle: { digest, exportKey, generateKey } });

    const result = await generateSessionKey();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result).toStrictEqual({
      code: "SESSION_KEY_ALGORITHM_UNSUPPORTED",
      layer: "CONTROL_ROOM_SESSION_KEY",
      ok: false,
    });
    expect(generateKey).toHaveBeenCalledTimes(1);
    expect(exportKey).toHaveBeenCalledTimes(1);
    expect(digest).not.toHaveBeenCalled();
  });
});

/**
 * DIGEST AND SIGNATURE (DoD 3).
 *
 * Every arm below compares TWO COMPUTED VALUES — the browser's and the daemon's — over the
 * same field set. No hex literal appears anywhere: a spelled digest would pin today's
 * canonicalisation and would keep passing if BOTH sides drifted together, which is exactly
 * the failure a "the browser matches the daemon" claim has to exclude.
 */
const OPEN_FIELDS = Object.freeze({
  credentialId: "credential-session-key-arm",
  generation: 1,
  kind: "OPEN_SESSION",
  principalId: "principal-session-key-arm",
  profileRevisionId: "profile-revision-session-key-arm",
  projectId: "project-session-key-arm",
  sessionId: "session-session-key-arm",
  transportId: "coordination.v1",
  transportIds: Object.freeze(["coordination.v1", "terminal.v1"]),
});

async function openFieldsFor(key: { clientKeyId: string; publicKeySpkiHex: string }) {
  return { ...OPEN_FIELDS, clientKeyId: key.clientKeyId, publicKeySpkiHex: key.publicKeySpkiHex };
}

describe("openSessionRequestDigest", () => {
  it("computes the SAME digest the daemon computes for the identical field set", async () => {
    const { openSessionRequestDigest } = await loadSessionKeyModule();
    const key = await generatedKey();
    const daemon = await loadDaemonProtocol();
    const fields = await openFieldsFor(key);

    const browser = await openSessionRequestDigest(fields);
    expect(browser).toMatch(/^[0-9a-f]{64}$/u);
    // Both sides COMPUTED, never spelled.
    expect(browser).toBe(daemon.sessionAuthorityRequestDigest(fields));
  });

  it("CAN FAIL: perturbing one field moves the browser digest away from the daemon's", async () => {
    // Without this the equality above is satisfied by any two functions that agree on one
    // input — including two that ignore their arguments entirely.
    const { openSessionRequestDigest } = await loadSessionKeyModule();
    const key = await generatedKey();
    const daemon = await loadDaemonProtocol();
    const fields = await openFieldsFor(key);

    const perturbed = await openSessionRequestDigest({ ...fields, sessionId: "session-other" });
    expect(perturbed).toMatch(/^[0-9a-f]{64}$/u);
    expect(perturbed).not.toBe(daemon.sessionAuthorityRequestDigest(fields));
    // And it still agrees with the daemon on the PERTURBED set, so the divergence above is
    // the field changing rather than the two implementations parting company.
    expect(perturbed)
      .toBe(daemon.sessionAuthorityRequestDigest({ ...fields, sessionId: "session-other" }));
  });
});

describe("signSessionChallenge", () => {
  it("produces a signature the DAEMON's verifier accepts for the paired key", async () => {
    const { signSessionChallenge } = await loadSessionKeyModule();
    const key = await generatedKey();
    const daemon = await loadDaemonProtocol();
    const fields = await openFieldsFor(key);
    const challengeFields = {
      clientKeyId: key.clientKeyId,
      credentialId: fields.credentialId,
      generation: 1,
      issuedAt: 1_756_540_800_000,
      keyEpochRef: "72".repeat(32),
      nonce: "12".repeat(16),
      principalId: fields.principalId,
      projectId: fields.projectId,
      recoveryIncarnationRef: "71".repeat(32),
      requestDigest: await openSessionRequestDigestOf(fields),
      requestId: "command-session-key-arm",
      sessionId: fields.sessionId,
      transportId: fields.transportId,
    };

    const signatureHex = await signSessionChallenge(
      key.privateKey, canonicalSessionProofBytes(challengeFields),
    );
    expect(signatureHex).toMatch(/^[0-9a-f]{128}$/u);
    expect(daemon.verifySessionProofOverChallenge(
      key.publicKeySpkiHex, challengeFields, signatureHex,
    )).toBe(true);
  });

  it("CAN FAIL: a signature from a DIFFERENT key is refused by the same verifier", async () => {
    const { signSessionChallenge } = await loadSessionKeyModule();
    const paired = await generatedKey();
    const other = await generatedKey();
    const daemon = await loadDaemonProtocol();
    const fields = await openFieldsFor(paired);
    const challengeFields = {
      clientKeyId: paired.clientKeyId,
      credentialId: fields.credentialId,
      generation: 1,
      issuedAt: 1_756_540_800_000,
      keyEpochRef: "72".repeat(32),
      nonce: "12".repeat(16),
      principalId: fields.principalId,
      projectId: fields.projectId,
      recoveryIncarnationRef: "71".repeat(32),
      requestDigest: await openSessionRequestDigestOf(fields),
      requestId: "command-session-key-arm",
      sessionId: fields.sessionId,
      transportId: fields.transportId,
    };

    const wrong = await signSessionChallenge(
      other.privateKey, canonicalSessionProofBytes(challengeFields),
    );
    expect(wrong).toMatch(/^[0-9a-f]{128}$/u);
    expect(daemon.verifySessionProofOverChallenge(
      paired.publicKeySpkiHex, challengeFields, wrong,
    )).toBe(false);
  });
});

async function openSessionRequestDigestOf(fields: Record<string, unknown>): Promise<string> {
  const { openSessionRequestDigest } = await loadSessionKeyModule();
  return await openSessionRequestDigest(fields);
}
