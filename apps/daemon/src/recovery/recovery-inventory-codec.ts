import { createHash } from "node:crypto";

import {
  MAX_RECOVERY_RECONCILIATION_BYTES,
  recoveryInventoryRefusal,
} from "./recovery-inventory-contract.js";
import type {
  RecoveryInventoryRefusal,
  RecoveryInventoryUpstream,
  RecoveryReconciliationRecord,
} from "./recovery-inventory-contract.js";
import { readRecoveryReconciliationRecordBody } from "./recovery-inventory-reader.js";

/**
 * The strict canonical codec for a reconciliation record.
 *
 * Canonical means ONE byte string per record: fixed key order, no whitespace,
 * deterministic class/population/item order. Decoding therefore re-encodes what
 * it just validated and compares bytes, which is what stops whitespace, key
 * reordering, a duplicate key or a trailing extension from becoming a second
 * authoritative spelling of the same record. `recordDigest` is computed over
 * every body field EXCEPT itself and then appended, so a semantic byte change
 * that is still canonical is caught by the digest instead.
 *
 * Nothing here throws and nothing defaults: an unreadable record is a refusal
 * carrying the coordinator UNKNOWN answer plus its own upstream code.
 */
export type RecoveryReconciliationBody = Omit<RecoveryReconciliationRecord, "recordDigest">;

export interface RecoveryReconciliationDecoded {
  readonly ok: true;
  readonly outcome: "DECODED";
  readonly authority: "NONE";
  readonly record: RecoveryReconciliationRecord;
}

export type RecoveryReconciliationDecodeResult =
  | RecoveryReconciliationDecoded
  | RecoveryInventoryRefusal;


const upstreamBody = (
  upstream: RecoveryInventoryUpstream | null,
): { code: string; layer: string } | null =>
  upstream === null ? null : { code: upstream.code, layer: upstream.layer };

/** ONE fixed field order, built here and never from the caller's own object. */
function bodyObject(record: RecoveryReconciliationBody): Record<string, unknown> {
  return {
    schemaVersion: record.schemaVersion,
    projectId: record.projectId,
    projectTag: record.projectTag,
    backupCursor: record.backupCursor,
    backupGenerationDigest: record.backupGenerationDigest,
    incarnationRef: record.incarnationRef,
    keyEpochRef: record.keyEpochRef,
    anchorBindingDigest: record.anchorBindingDigest,
    configuredClasses: [...record.configuredClasses],
    proofs: record.proofs.map((proof) => ({
      class: proof.class,
      populations: [...proof.populations],
      truth: proof.truth,
      sourceProofDigest: proof.sourceProofDigest,
      itemCount: proof.itemCount,
      upstream: upstreamBody(proof.upstream),
    })),
    items: record.items.map((item) => ({
      class: item.class,
      population: item.population,
      identity: item.identity,
      disposition: item.disposition,
      sourceProofDigest: item.sourceProofDigest,
      terminalProofDigest: item.terminalProofDigest,
      restoredIntentRef: item.restoredIntentRef,
      restoredIntentDigest: item.restoredIntentDigest,
      quarantineRef: item.quarantineRef,
      upstream: upstreamBody(item.upstream),
    })),
    truth: record.truth,
    coordinator:
      record.coordinator === null
        ? null
        : { code: record.coordinator.code, layer: record.coordinator.layer },
    upstream: upstreamBody(record.upstream),
  };
}

export function recoveryReconciliationDigest(record: RecoveryReconciliationBody): string {
  return createHash("sha256").update(JSON.stringify(bodyObject(record)), "utf8").digest("hex");
}

export function encodeRecoveryReconciliationRecord(
  record: RecoveryReconciliationRecord,
): Uint8Array {
  const body = bodyObject(record);
  body["recordDigest"] = record.recordDigest;
  return new TextEncoder().encode(JSON.stringify(body));
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

export function decodeRecoveryReconciliationRecord(
  bytes: Uint8Array,
): RecoveryReconciliationDecodeResult {
  if (bytes.length === 0 || bytes.length > MAX_RECOVERY_RECONCILIATION_BYTES) return UNREADABLE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return UNREADABLE;
  }
  const record = readRecord(parsed);
  if (record === "NONCANONICAL") return NONCANONICAL;
  if (record === "INCOHERENT") return INCOHERENT;
  if (recoveryReconciliationDigest(record) !== record.recordDigest) return DIGEST_MISMATCH;
  if (!sameBytes(encodeRecoveryReconciliationRecord(record), bytes)) return NONCANONICAL;
  return Object.freeze({
    authority: "NONE" as const,
    ok: true as const,
    outcome: "DECODED" as const,
    record,
  });
}
