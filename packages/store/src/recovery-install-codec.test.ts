import { describe, expect, it } from "vitest";

import {
  RECOVERY_BINDING_CODEC_LAYER,
  RECOVERY_BINDING_CODEC_VERSION,
  RECOVERY_BINDING_SLOTS,
} from "./recovery-install-contracts.js";
import type { RecoveryInstallReasonCode } from "./recovery-install-contracts.js";
import {
  decodeRecoveryBinding,
  encodeRecoveryBinding,
  recoveryBindingDigest,
} from "./recovery-install-codec.js";

const encoder = new TextEncoder();
const INCARNATION_REF = "a1".repeat(32);
const KEY_EPOCH_REF = "b2".repeat(32);
const OTHER_REF = "c3".repeat(32);

function record(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
    incarnationRef: INCARNATION_REF,
    installedAt: "2026-08-11T09:00:00.000Z",
    keyEpochRef: KEY_EPOCH_REF,
    payload: encoder.encode("opaque-daemon-supplied-binding"),
    slot: "ACTIVE",
    ...overrides,
  };
}

function withoutKey(key: string): Record<string, unknown> {
  const value = record();
  delete value[key];
  return value;
}

function encodedBytes(overrides: Readonly<Record<string, unknown>> = {}): Uint8Array {
  const encoded = encodeRecoveryBinding(record(overrides));
  if (!encoded.ok) throw new Error(`fixture failed to encode: ${encoded.code}`);
  return encoded.bytes;
}

type RefusalCase = readonly [string, unknown, RecoveryInstallReasonCode];

const ENCODE_REFUSAL_CASES: readonly RefusalCase[] = [
  ["null", null, "RECOVERY_BINDING_SHAPE_INVALID"],
  ["array", [], "RECOVERY_BINDING_SHAPE_INVALID"],
  ["string", "binding", "RECOVERY_BINDING_SHAPE_INVALID"],
  ["missing slot", withoutKey("slot"), "RECOVERY_BINDING_SHAPE_INVALID"],
  ["missing payload", withoutKey("payload"), "RECOVERY_BINDING_SHAPE_INVALID"],
  ["extra key", record({ authority: "GRANTED" }), "RECOVERY_BINDING_SHAPE_INVALID"],
  [
    "unsupported codec version",
    record({ bindingCodecVersion: "moe-recovery-binding/2" }),
    "RECOVERY_BINDING_CODEC_VERSION_UNSUPPORTED",
  ],
  ["unknown slot", record({ slot: "ARCHIVE" }), "RECOVERY_BINDING_FIELD_INVALID"],
  ["uppercase incarnation ref", record({ incarnationRef: "A1".repeat(32) }), "RECOVERY_BINDING_FIELD_INVALID"],
  ["short key epoch ref", record({ keyEpochRef: "b".repeat(63) }), "RECOVERY_BINDING_FIELD_INVALID"],
  ["timestamp without milliseconds", record({ installedAt: "2026-08-11T09:00:00Z" }), "RECOVERY_BINDING_FIELD_INVALID"],
  ["empty payload", record({ payload: new Uint8Array() }), "RECOVERY_BINDING_FIELD_INVALID"],
  ["payload that is not bytes", record({ payload: "not-bytes" }), "RECOVERY_BINDING_FIELD_INVALID"],
];

/** Hand-written, so dropping a case from the table above fails rather than shrinking the suite. */
const ENCODE_REFUSAL_NAMES: readonly string[] = [
  "null", "array", "string", "missing slot", "missing payload", "extra key",
  "unsupported codec version", "unknown slot", "uppercase incarnation ref",
  "short key epoch ref", "timestamp without milliseconds", "empty payload",
  "payload that is not bytes",
];

describe("recovery binding codec", () => {
  it("round-trips a binding and derives a stable digest", () => {
    const encoded = encodeRecoveryBinding(record());
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.digest).toBe(recoveryBindingDigest(encoded.bytes));
    expect(encoded.digest).toMatch(/^[0-9a-f]{64}$/u);

    const decoded = decodeRecoveryBinding(encoded.bytes, encoded.digest);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.binding).toEqual({
      bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
      incarnationRef: INCARNATION_REF,
      installedAt: "2026-08-11T09:00:00.000Z",
      keyEpochRef: KEY_EPOCH_REF,
      payload: encoder.encode("opaque-daemon-supplied-binding"),
      slot: "ACTIVE",
    });
    expect(Object.isFrozen(decoded.binding)).toBe(true);
  });

  it("encodes byte-identically for equal records and differently per slot", () => {
    expect(encodedBytes()).toEqual(encodedBytes());
    expect(encodedBytes({ slot: "PENDING" })).not.toEqual(encodedBytes());
    expect(RECOVERY_BINDING_SLOTS).toEqual(["ACTIVE", "PENDING"]);
  });

  it("refuses every declared malformed record at the codec layer with its exact code", () => {
    expect(ENCODE_REFUSAL_CASES.length).toBe(ENCODE_REFUSAL_NAMES.length);
    expect(ENCODE_REFUSAL_CASES.map(([name]) => name)).toEqual(ENCODE_REFUSAL_NAMES);
    expect(ENCODE_REFUSAL_CASES.length).toBeGreaterThan(0);

    for (const [name, input, code] of ENCODE_REFUSAL_CASES) {
      const result = encodeRecoveryBinding(input);
      expect(result.ok, name).toBe(false);
      if (result.ok) continue;
      expect(result.code, name).toBe(code);
      expect(result.layer, name).toBe(RECOVERY_BINDING_CODEC_LAYER);
      expect(result.truth, name).toBe("UNKNOWN");
    }
  });

  it("answers a stale digest before it parses, and says so", () => {
    const bytes = encodedBytes();
    const stale = decodeRecoveryBinding(bytes.subarray(0, bytes.length - 1), recoveryBindingDigest(bytes));
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.code).toBe("RECOVERY_BINDING_DIGEST_MISMATCH");
    expect(stale.layer).toBe(RECOVERY_BINDING_CODEC_LAYER);
  });

  it("refuses every generated truncation once its digest is recomputed", () => {
    const bytes = encodedBytes();
    const truncations = Array.from({ length: bytes.length }, (_unused, end) => bytes.subarray(0, end));
    expect(truncations.length).toBe(bytes.length);
    expect(truncations.length).toBeGreaterThan(0);

    const codes = new Set<RecoveryInstallReasonCode>();
    for (const truncation of truncations) {
      const result = decodeRecoveryBinding(truncation, recoveryBindingDigest(truncation));
      expect(result.ok, `truncation to ${truncation.length} bytes`).toBe(false);
      if (result.ok) continue;
      expect(result.layer).toBe(RECOVERY_BINDING_CODEC_LAYER);
      codes.add(result.code);
    }
    expect(codes.has("RECOVERY_BINDING_BYTES_MALFORMED")).toBe(true);
    expect(codes.has("RECOVERY_BINDING_CODEC_VERSION_UNSUPPORTED")).toBe(true);
  });

  it("refuses every generated header corruption as an unsupported codec version", () => {
    const bytes = encodedBytes();
    const headerLength = encoder.encode(`${RECOVERY_BINDING_CODEC_VERSION}\n`).length;
    expect(headerLength).toBeGreaterThan(0);

    let generated = 0;
    for (let index = 0; index < headerLength; index += 1) {
      const corrupted = Uint8Array.from(bytes);
      corrupted[index] = (corrupted[index]! ^ 0x20) & 0xff;
      const result = decodeRecoveryBinding(corrupted, recoveryBindingDigest(corrupted));
      expect(result.ok, `header byte ${index}`).toBe(false);
      if (result.ok) continue;
      expect(result.code, `header byte ${index}`).toBe("RECOVERY_BINDING_CODEC_VERSION_UNSUPPORTED");
      expect(result.layer).toBe(RECOVERY_BINDING_CODEC_LAYER);
      generated += 1;
    }
    expect(generated).toBe(headerLength);
    expect(generated).toBeGreaterThan(0);
  });

  it("never repairs trailing bytes and never truncates a long payload frame", () => {
    const bytes = encodedBytes();
    let generated = 0;
    for (const extra of [1, 2, 8] as const) {
      const padded = new Uint8Array(bytes.length + extra);
      padded.set(bytes, 0);
      const result = decodeRecoveryBinding(padded, recoveryBindingDigest(padded));
      expect(result.ok, `${extra} trailing bytes`).toBe(false);
      if (result.ok) continue;
      expect(result.code, `${extra} trailing bytes`).toBe("RECOVERY_BINDING_BYTES_MALFORMED");
      expect(result.layer).toBe(RECOVERY_BINDING_CODEC_LAYER);
      generated += 1;
    }
    expect(generated).toBe(3);
  });

  it("refuses every generated digest deviation", () => {
    const bytes = encodedBytes();
    const digest = recoveryBindingDigest(bytes);
    let generated = 0;
    for (let index = 0; index < digest.length; index += 1) {
      const replacement = digest[index] === "0" ? "1" : "0";
      const deviated = `${digest.slice(0, index)}${replacement}${digest.slice(index + 1)}`;
      const result = decodeRecoveryBinding(bytes, deviated);
      expect(result.ok, `digest position ${index}`).toBe(false);
      if (result.ok) continue;
      expect(result.code, `digest position ${index}`).toBe("RECOVERY_BINDING_DIGEST_MISMATCH");
      expect(result.layer).toBe(RECOVERY_BINDING_CODEC_LAYER);
      generated += 1;
    }
    expect(generated).toBe(64);
    expect(generated).toBeGreaterThan(0);
  });

  it("refuses a decode whose bytes are not bytes and whose digest is not a digest", () => {
    for (const [name, bytes, digest, code] of [
      ["string bytes", "not-bytes", recoveryBindingDigest(encodedBytes()), "RECOVERY_BINDING_BYTES_MALFORMED"],
      ["empty bytes", new Uint8Array(), recoveryBindingDigest(new Uint8Array()), "RECOVERY_BINDING_BYTES_MALFORMED"],
      ["non-hex digest", encodedBytes(), "not-a-digest", "RECOVERY_BINDING_DIGEST_MISMATCH"],
      ["null digest", encodedBytes(), null, "RECOVERY_BINDING_DIGEST_MISMATCH"],
    ] as const) {
      const result = decodeRecoveryBinding(bytes, digest);
      expect(result.ok, name).toBe(false);
      if (result.ok) continue;
      expect(result.code, name).toBe(code);
      expect(result.layer, name).toBe(RECOVERY_BINDING_CODEC_LAYER);
    }
  });

  it("decodes a record whose field bytes changed only when the record is still well formed", () => {
    const pending = encodedBytes({ slot: "PENDING", incarnationRef: OTHER_REF });
    const decoded = decodeRecoveryBinding(pending, recoveryBindingDigest(pending));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.binding.slot).toBe("PENDING");
    expect(decoded.binding.incarnationRef).toBe(OTHER_REF);
  });
});
