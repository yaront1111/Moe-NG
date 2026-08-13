import { createHash } from "node:crypto";

import {
  MAX_RECOVERY_RECONCILIATION_BYTES,
  MAX_RECOVERY_RECONCILIATION_ITEMS,
  RECOVERY_CLASS_POPULATION_ROWS,
  RECOVERY_INVENTORY_DISPOSITIONS,
  RECOVERY_INVENTORY_UPSTREAM_CODES,
  RECOVERY_INVENTORY_UPSTREAM_LAYERS,
  RECOVERY_PROOF_CLASSES,
  RECOVERY_RECONCILIATION_SCHEMA_VERSION,
  exactDataRecord,
  recoveryInventoryRefusal,
} from "./recovery-inventory-contract.js";
import type {
  RecoveryInventoryRefusal,
  RecoveryInventoryUpstream,
  RecoveryReconciliationItem,
  RecoveryReconciliationProof,
  RecoveryReconciliationRecord,
} from "./recovery-inventory-contract.js";

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

const RECORD_KEYS = Object.freeze([
  "schemaVersion", "projectId", "projectTag", "backupCursor", "backupGenerationDigest",
  "incarnationRef", "keyEpochRef", "anchorBindingDigest", "configuredClasses", "proofs",
  "items", "truth", "coordinator", "upstream", "recordDigest",
]);
const PROOF_KEYS = Object.freeze([
  "class", "populations", "truth", "sourceProofDigest", "itemCount", "upstream",
]);
const ITEM_KEYS = Object.freeze([
  "class", "population", "identity", "disposition", "sourceProofDigest",
  "terminalProofDigest", "restoredIntentRef", "restoredIntentDigest", "quarantineRef",
  "upstream",
]);

const local = (code: RecoveryInventoryUpstream["code"]): RecoveryInventoryUpstream =>
  Object.freeze({ code, layer: "RECOVERY_INVENTORY" as const });

const UNREADABLE = recoveryInventoryRefusal(
  local("RECOVERY_INVENTORY_RECORD_UNREADABLE"),
  "The stored reconciliation bytes are not decodable as a record.",
);
const NONCANONICAL = recoveryInventoryRefusal(
  local("RECOVERY_INVENTORY_RECORD_NONCANONICAL"),
  "The stored bytes are not the one canonical spelling of the record they claim.",
);
const DIGEST_MISMATCH = recoveryInventoryRefusal(
  local("RECOVERY_INVENTORY_RECORD_DIGEST_MISMATCH"),
  "The record digest does not cover the record body it is stored with.",
);

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

const HEX64 = /^[0-9a-f]{64}$/u;
const isHex64 = (value: unknown): value is string =>
  typeof value === "string" && HEX64.test(value);
const isNullableHex64 = (value: unknown): value is string | null =>
  value === null || isHex64(value);
const isNullableText = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && value.length > 0);

/** Key ORDER, not merely the key set: a reordered body is a different spelling. */
function orderedKeys(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const record = exactDataRecord(value, keys);
  if (record === null) return null;
  const actual = Object.keys(value as object);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    return null;
  }
  return { ...record };
}

function readUpstream(value: unknown): RecoveryInventoryUpstream | null | false {
  if (value === null) return null;
  const raw = orderedKeys(value, ["code", "layer"]);
  if (raw === null) return false;
  const code = raw["code"];
  const layer = raw["layer"];
  if (typeof code !== "string" || !(RECOVERY_INVENTORY_UPSTREAM_CODES as readonly string[]).includes(code)) return false;
  if (typeof layer !== "string" || !(RECOVERY_INVENTORY_UPSTREAM_LAYERS as readonly string[]).includes(layer)) return false;
  return Object.freeze({
    code: code as RecoveryInventoryUpstream["code"],
    layer: layer as RecoveryInventoryUpstream["layer"],
  });
}

/** Its own closed vocabulary of exactly ONE pair, deliberately not the upstream one. */
function readCoordinator(
  value: unknown,
): RecoveryReconciliationRecord["coordinator"] | false {
  if (value === null) return null;
  const raw = orderedKeys(value, ["code", "layer"]);
  if (raw === null) return false;
  if (raw["code"] !== "UNKNOWN_TRUTH" || raw["layer"] !== "RECOVERY_INVENTORY") return false;
  return Object.freeze({ code: "UNKNOWN_TRUTH" as const, layer: "RECOVERY_INVENTORY" as const });
}

/** Re-derives the frozen six-to-seven mapping instead of trusting stored rows. */
function readProofs(value: unknown): readonly RecoveryReconciliationProof[] | null {
  if (!Array.isArray(value) || value.length !== RECOVERY_CLASS_POPULATION_ROWS.length) return null;
  const proofs: RecoveryReconciliationProof[] = [];
  for (const [index, entry] of value.entries()) {
    const row = RECOVERY_CLASS_POPULATION_ROWS[index];
    const raw = orderedKeys(entry, PROOF_KEYS);
    if (raw === null || row === undefined || raw["class"] !== row.class) return null;
    const populations = raw["populations"];
    if (!Array.isArray(populations) || populations.length !== row.populations.length) return null;
    if (populations.some((name, at) => name !== row.populations[at])) return null;
    const truth = raw["truth"];
    if (truth !== "COMPLETE" && truth !== "UNKNOWN") return null;
    if (!isHex64(raw["sourceProofDigest"])) return null;
    const itemCount = raw["itemCount"];
    if (!Number.isSafeInteger(itemCount) || (itemCount as number) < 0) return null;
    const upstream = readUpstream(raw["upstream"]);
    if (upstream === false) return null;
    if ((truth === "UNKNOWN") !== (upstream !== null)) return null;
    proofs.push(Object.freeze({
      class: row.class, itemCount: itemCount as number, populations: row.populations,
      sourceProofDigest: raw["sourceProofDigest"], truth, upstream,
    }));
  }
  return Object.freeze(proofs);
}

function readItems(value: unknown): readonly RecoveryReconciliationItem[] | null {
  if (!Array.isArray(value) || value.length > MAX_RECOVERY_RECONCILIATION_ITEMS) return null;
  const items: RecoveryReconciliationItem[] = [];
  for (const entry of value) {
    const raw = orderedKeys(entry, ITEM_KEYS);
    if (raw === null) return null;
    const disposition = raw["disposition"];
    const population = raw["population"];
    if (typeof disposition !== "string") return null;
    if (!(RECOVERY_INVENTORY_DISPOSITIONS as readonly string[]).includes(disposition)) return null;
    const row = RECOVERY_CLASS_POPULATION_ROWS.find((entryRow) => entryRow.class === raw["class"]);
    if (row === undefined || typeof population !== "string") return null;
    if (!(row.populations as readonly string[]).includes(population)) return null;
    if (typeof raw["identity"] !== "string" || raw["identity"].length === 0) return null;
    if (!isHex64(raw["sourceProofDigest"])) return null;
    if (!isNullableHex64(raw["terminalProofDigest"])) return null;
    if (!isNullableHex64(raw["restoredIntentDigest"])) return null;
    if (!isNullableText(raw["restoredIntentRef"]) || !isNullableText(raw["quarantineRef"])) return null;
    const upstream = readUpstream(raw["upstream"]);
    if (upstream === false) return null;
    if (disposition === "ADOPTED" && raw["restoredIntentRef"] === null) return null;
    if (disposition === "UNKNOWN" && upstream === null) return null;
    items.push(Object.freeze({
      class: row.class,
      disposition: disposition as RecoveryReconciliationItem["disposition"],
      identity: raw["identity"],
      population: population as RecoveryReconciliationItem["population"],
      quarantineRef: raw["quarantineRef"] as string | null,
      restoredIntentDigest: raw["restoredIntentDigest"] as string | null,
      restoredIntentRef: raw["restoredIntentRef"] as string | null,
      sourceProofDigest: raw["sourceProofDigest"],
      terminalProofDigest: raw["terminalProofDigest"] as string | null,
      upstream,
    }));
  }
  return Object.freeze(items);
}

function readRecord(parsed: unknown): RecoveryReconciliationRecord | null {
  const raw = orderedKeys(parsed, RECORD_KEYS);
  if (raw === null) return null;
  if (raw["schemaVersion"] !== RECOVERY_RECONCILIATION_SCHEMA_VERSION) return null;
  const configured = raw["configuredClasses"];
  if (!Array.isArray(configured) || configured.length !== RECOVERY_PROOF_CLASSES.length) return null;
  if (configured.some((name, index) => name !== RECOVERY_PROOF_CLASSES[index])) return null;
  const truth = raw["truth"];
  if (truth !== "COMPLETE" && truth !== "UNKNOWN") return null;
  for (const key of ["projectId", "projectTag", "backupCursor"]) {
    if (typeof raw[key] !== "string" || (raw[key] as string).length === 0) return null;
  }
  for (const key of ["backupGenerationDigest", "incarnationRef", "keyEpochRef",
    "anchorBindingDigest", "recordDigest"]) {
    if (!isHex64(raw[key])) return null;
  }
  const proofs = readProofs(raw["proofs"]);
  const items = readItems(raw["items"]);
  if (proofs === null || items === null) return null;
  const upstream = readUpstream(raw["upstream"]);
  if (upstream === false) return null;
  // The coordinator answer is the ONE pair this area may persist, and it exists
  // exactly when the truth is UNKNOWN: neither can be present without the other.
  // It is read on its OWN vocabulary, not the upstream one — `UNKNOWN_TRUTH` is
  // not an upstream code, and reusing that reader would admit any of the 24.
  const coordinator = readCoordinator(raw["coordinator"]);
  if (coordinator === false) return null;
  if ((truth === "UNKNOWN") !== (coordinator !== null)) return null;
  if ((truth === "UNKNOWN") !== (upstream !== null)) return null;
  for (const proof of proofs) {
    if (proof.itemCount !== items.filter((item) => item.class === proof.class).length) return null;
  }
  return Object.freeze({
    anchorBindingDigest: raw["anchorBindingDigest"] as string,
    backupCursor: raw["backupCursor"] as string,
    backupGenerationDigest: raw["backupGenerationDigest"] as string,
    configuredClasses: Object.freeze([...RECOVERY_PROOF_CLASSES]),
    coordinator,
    incarnationRef: raw["incarnationRef"] as string,
    items,
    keyEpochRef: raw["keyEpochRef"] as string,
    projectId: raw["projectId"] as string,
    projectTag: raw["projectTag"] as string,
    proofs,
    recordDigest: raw["recordDigest"] as string,
    schemaVersion: RECOVERY_RECONCILIATION_SCHEMA_VERSION,
    truth,
    upstream,
  });
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
  if (record === null) return NONCANONICAL;
  if (recoveryReconciliationDigest(record) !== record.recordDigest) return DIGEST_MISMATCH;
  if (!sameBytes(encodeRecoveryReconciliationRecord(record), bytes)) return NONCANONICAL;
  return Object.freeze({
    authority: "NONE" as const,
    ok: true as const,
    outcome: "DECODED" as const,
    record,
  });
}
