import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT_SEAL_HEADER_BYTES,
  ENVIRONMENT_SEAL_VERSION,
  openEnvironmentValue,
  sealEnvironmentValue,
} from "./environment-cipher.js";

/**
 * The AEAD that makes a copied store useless. Every arm drives the PRODUCTION seal/open pair.
 *
 * The load-bearing arm is "two seals of the same plaintext differ". A round-trip-only suite
 * passes with a HARD-CODED NONCE, and a repeated nonce under one key breaks AES-GCM
 * catastrophically (two ciphertexts under the same nonce leak their XOR, and the authentication
 * key itself becomes recoverable). So the nonce discipline needs its own assertion, not a
 * corollary of round-tripping.
 */

const CREDENTIAL = "daemon-credential-fixture-alpha";
const OTHER_CREDENTIAL = "daemon-credential-fixture-beta";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function plaintext(value: string): Uint8Array {
  return encoder.encode(value);
}

describe("sealEnvironmentValue / openEnvironmentValue", () => {
  it("round trips a value under the credential it was sealed with", () => {
    const sealed = sealEnvironmentValue(CREDENTIAL, plaintext("s3cret-value"));
    const opened = openEnvironmentValue(CREDENTIAL, sealed);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("unreachable");
    expect(decoder.decode(opened.plaintext)).toBe("s3cret-value");
  });

  it("round trips an EMPTY value, which is a legal variable value", () => {
    const sealed = sealEnvironmentValue(CREDENTIAL, plaintext(""));
    const opened = openEnvironmentValue(CREDENTIAL, sealed);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("unreachable");
    expect(opened.plaintext.byteLength).toBe(0);
  });

  it("stamps the version byte and the fixed-width header", () => {
    const sealed = sealEnvironmentValue(CREDENTIAL, plaintext("abc"));
    expect(sealed[0]).toBe(ENVIRONMENT_SEAL_VERSION);
    expect(sealed.byteLength).toBe(ENVIRONMENT_SEAL_HEADER_BYTES + 3);
  });

  it("never lets the plaintext appear in the sealed bytes", () => {
    const sealed = sealEnvironmentValue(CREDENTIAL, plaintext("MOE-PLAINTEXT-MARKER"));
    expect(Buffer.from(sealed).includes("MOE-PLAINTEXT-MARKER")).toBe(false);
  });

  it("produces DIFFERENT bytes for two seals of the SAME plaintext under the SAME credential", () => {
    const first = sealEnvironmentValue(CREDENTIAL, plaintext("identical"));
    const second = sealEnvironmentValue(CREDENTIAL, plaintext("identical"));
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
    // Salt AND nonce must both move: pinning either one alone still repeats a (key, nonce) pair.
    const saltStart = 1;
    const nonceStart = saltStart + 16;
    expect(Buffer.from(first.subarray(saltStart, nonceStart))
      .equals(Buffer.from(second.subarray(saltStart, nonceStart)))).toBe(false);
    expect(Buffer.from(first.subarray(nonceStart, nonceStart + 12))
      .equals(Buffer.from(second.subarray(nonceStart, nonceStart + 12)))).toBe(false);
    // ...and both still open, so the differing bytes are entropy, not corruption.
    const openedFirst = openEnvironmentValue(CREDENTIAL, first);
    const openedSecond = openEnvironmentValue(CREDENTIAL, second);
    expect(openedFirst.ok && openedSecond.ok).toBe(true);
  });

  it("FAILS AUTHENTICATION under a different credential rather than returning garbage", () => {
    const sealed = sealEnvironmentValue(CREDENTIAL, plaintext("s3cret-value"));
    const opened = openEnvironmentValue(OTHER_CREDENTIAL, sealed);
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error("unreachable");
    expect(opened.reason).toBe("AUTHENTICATION_FAILED");
    expect(Object.keys(opened).sort()).toEqual(["ok", "reason"]);
  });

  it("FAILS AUTHENTICATION under an EMPTY credential", () => {
    const sealed = sealEnvironmentValue(CREDENTIAL, plaintext("s3cret-value"));
    const opened = openEnvironmentValue("", sealed);
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error("unreachable");
    expect(opened.reason).toBe("AUTHENTICATION_FAILED");
  });

  it.each([
    ["ciphertext", ENVIRONMENT_SEAL_HEADER_BYTES],
    ["tag", 1 + 16 + 12],
    ["nonce", 1 + 16],
    ["salt", 1],
  ])("FAILS AUTHENTICATION when the %s byte is flipped", (_part, offset) => {
    const sealed = sealEnvironmentValue(CREDENTIAL, plaintext("s3cret-value"));
    const tampered = Uint8Array.from(sealed);
    tampered[offset] = (tampered[offset] ?? 0) ^ 0x01;
    const opened = openEnvironmentValue(CREDENTIAL, tampered);
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error("unreachable");
    expect(opened.reason).toBe("AUTHENTICATION_FAILED");
  });

  it("reports MALFORMED, not AUTHENTICATION_FAILED, on a truncated blob", () => {
    const sealed = sealEnvironmentValue(CREDENTIAL, plaintext("s3cret-value"));
    const opened = openEnvironmentValue(CREDENTIAL, sealed.subarray(0, ENVIRONMENT_SEAL_HEADER_BYTES - 1));
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error("unreachable");
    expect(opened.reason).toBe("MALFORMED");
  });

  it("reports MALFORMED on an unknown version byte", () => {
    const sealed = sealEnvironmentValue(CREDENTIAL, plaintext("s3cret-value"));
    const tampered = Uint8Array.from(sealed);
    tampered[0] = ENVIRONMENT_SEAL_VERSION + 1;
    const opened = openEnvironmentValue(CREDENTIAL, tampered);
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error("unreachable");
    expect(opened.reason).toBe("MALFORMED");
  });

  it("carries no plaintext and no credential on the failure result", () => {
    const sealed = sealEnvironmentValue(CREDENTIAL, plaintext("MOE-PLAINTEXT-MARKER"));
    const opened = openEnvironmentValue(OTHER_CREDENTIAL, sealed);
    const serialised = JSON.stringify(opened);
    expect(serialised).not.toContain("MOE-PLAINTEXT-MARKER");
    expect(serialised).not.toContain(CREDENTIAL);
    expect(serialised).not.toContain(OTHER_CREDENTIAL);
  });

  it("derives a DIFFERENT key per salt: a replayed salt from another seal does not open it", () => {
    const first = sealEnvironmentValue(CREDENTIAL, plaintext("first-value"));
    const second = sealEnvironmentValue(CREDENTIAL, plaintext("second-value"));
    const spliced = Uint8Array.from(second);
    spliced.set(first.subarray(1, 17), 1);
    const opened = openEnvironmentValue(CREDENTIAL, spliced);
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error("unreachable");
    expect(opened.reason).toBe("AUTHENTICATION_FAILED");
  });
});
