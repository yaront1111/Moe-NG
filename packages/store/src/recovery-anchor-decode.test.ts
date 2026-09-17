import { describe, expect, it } from "vitest";

import {
  RECOVERY_ANCHOR_CODEC_VERSION, RECOVERY_ANCHOR_REASON_CODES,
} from "./recovery-anchor-contracts.js";
import type { RecoveryAnchorRecord } from "./recovery-anchor-contracts.js";
import { decodeAnchorRecord, encodeAnchorRecord, sealAnchorRecord } from "./recovery-anchor-record.js";

/**
 * A TRUNCATED ANCHOR IS NOT A TAMPERED ONE.
 *
 * `decodeAnchorRecord` answered RECOVERY_ANCHOR_DIGEST_MISMATCH — "these bytes were altered" —
 * for three unrelated states: a zero-byte anchor (a crash between open-truncate and write), a
 * truncated anchor (ENOSPC part-way through), and bytes that are not valid UTF-8. The parse
 * error, the only thing that would have said "the file is 0 bytes" or "unexpected end of JSON
 * input at position 412", was discarded by a bare catch.
 *
 * The cost is the operator's reading of it. A digest mismatch on a recovery anchor is a
 * corruption or security incident: the slot is not to be trusted and the incident is escalated.
 * A truncated write is a torn file that the next atomic publish fixes. The repairs have nothing
 * in common, and the code said the first when it meant the second.
 *
 * This module already draws the same distinction one level up — RECOVERY_ANCHOR_UNREADABLE
 * exists precisely so "exists but could not be read" cannot read as absence.
 */

const draft: Omit<RecoveryAnchorRecord, "anchorDigest"> = {
  anchorCodecVersion: RECOVERY_ANCHOR_CODEC_VERSION,
  currentSlot: "ACTIVE",
  databaseDigest: "d".repeat(64),
  generationDigest: "g".repeat(64),
  incarnationRef: "incarnation-1",
  keyEpochRef: "epoch-1",
  payloadDigests: { "store.sqlite": "p".repeat(64) },
  preparedAt: "2026-09-17T00:00:00.000Z",
  preparedIdentity: "operator-local",
  projectId: "project-1",
  restoreCommandId: "cmd-restore-1",
  restoredAuthorityRevoked: true,
  restoredLifecycle: "QUIESCED",
  restoredReadiness: "RECOVERY_REQUIRED",
  state: "PREPARED",
  targetSlot: "PENDING",
};

const sealed = (): RecoveryAnchorRecord => sealAnchorRecord(draft);
const codeOf = (value: unknown): unknown => (value as { readonly code?: unknown }).code;

describe("decodeAnchorRecord", () => {
  it("round-trips a sealed record", () => {
    const record = sealed();

    expect(decodeAnchorRecord(encodeAnchorRecord(record))).toEqual(record);
  });

  it("calls a zero-byte anchor malformed, not tampered", () => {
    expect(codeOf(decodeAnchorRecord(new Uint8Array(0))))
      .toBe("RECOVERY_ANCHOR_BYTES_MALFORMED");
  });

  it("calls a truncated anchor malformed, which is the ENOSPC case", () => {
    const whole = encodeAnchorRecord(sealed());

    expect(codeOf(decodeAnchorRecord(whole.subarray(0, Math.floor(whole.length / 2)))))
      .toBe("RECOVERY_ANCHOR_BYTES_MALFORMED");
  });

  it("calls bytes that are not valid UTF-8 malformed", () => {
    expect(codeOf(decodeAnchorRecord(Uint8Array.from([0xff, 0xfe, 0xff, 0xfe]))))
      .toBe("RECOVERY_ANCHOR_BYTES_MALFORMED");
  });

  it("calls well-formed JSON that is not an object malformed", () => {
    for (const text of ["[1,2,3]", "3", "null", '"a string"']) {
      expect(codeOf(decodeAnchorRecord(new TextEncoder().encode(text))), text)
        .toBe("RECOVERY_ANCHOR_BYTES_MALFORMED");
    }
  });

  it("STILL calls an altered record a digest mismatch, which is the real incident", () => {
    const record = { ...sealed(), projectId: "project-somebody-else" };

    expect(codeOf(decodeAnchorRecord(encodeAnchorRecord(record as RecoveryAnchorRecord))))
      .toBe("RECOVERY_ANCHOR_DIGEST_MISMATCH");
  });

  it("still separates an unsupported codec version from both", () => {
    const record = { ...sealed(), anchorCodecVersion: "moe-recovery-anchor/999" };

    expect(codeOf(decodeAnchorRecord(encodeAnchorRecord(record as unknown as RecoveryAnchorRecord))))
      .toBe("RECOVERY_ANCHOR_CODEC_VERSION_UNSUPPORTED");
  });

  it("keeps the new code in the closed roster", () => {
    expect([...RECOVERY_ANCHOR_REASON_CODES]).toContain("RECOVERY_ANCHOR_BYTES_MALFORMED");
    expect(new Set(RECOVERY_ANCHOR_REASON_CODES).size)
      .toBe(RECOVERY_ANCHOR_REASON_CODES.length);
  });

  it("carries no filesystem text into evidence, as every anchor refusal promises", () => {
    const refused = decodeAnchorRecord(new Uint8Array(0)) as { readonly reason: string };

    expect(refused.reason).not.toContain("JSON");
    expect(refused.reason).not.toContain("position");
  });
});
