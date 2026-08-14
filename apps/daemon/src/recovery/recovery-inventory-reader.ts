import {
  MAX_RECOVERY_RECONCILIATION_ITEMS,
  RECOVERY_CLASS_POPULATION_ROWS,
  RECOVERY_INVENTORY_DISPOSITIONS,
  RECOVERY_INVENTORY_UPSTREAM_CODES,
  RECOVERY_INVENTORY_UPSTREAM_LAYERS,
  RECOVERY_PROOF_CLASSES,
  RECOVERY_RECONCILIATION_SCHEMA_VERSION,
  RECOVERY_UNKNOWN_PROOF_DIGEST,
  exactDataRecord,
} from "./recovery-inventory-contract.js";
import type {
  RecoveryInventoryUpstream,
  RecoveryReconciliationItem,
  RecoveryReconciliationProof,
  RecoveryReconciliationRecord,
} from "./recovery-inventory-contract.js";
import {
  deriveRecoveryReconciliationTruth,
  isCanonicalRecoveryItemSequence,
  isCanonicalRecoveryItemShape,
  isCanonicalRecoveryProofSlot,
  sameRecoveryUpstream,
} from "./recovery-inventory-invariants.js";

/**
 * The strict structural reader for stored reconciliation bytes.
 *
 * Split out of `recovery-inventory-codec.ts` so that module keeps only the byte
 * boundary — canonical field order, digest, encode, decode entry — while every
 * "is this actually a record, and can it possibly be true" question lives here.
 * Nothing in this file throws and nothing defaults: a value that fails any rule
 * becomes a typed fault the codec turns into a stable refusal.
 */
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

/**
 * Which of the two structural guards refused. Kept apart on purpose:
 * NONCANONICAL means the bytes are not a well-formed spelling of a record,
 * INCOHERENT means they are perfectly well-formed and still assert something
 * the builder could never have produced. Collapsing them would let a green test
 * claim a semantic invariant was enforced when only the shape reader answered.
 */
export type RecoveryRecordReadFault = "INCOHERENT" | "NONCANONICAL";

export const isRecoveryRecordReadFault = (
  value: unknown,
): value is RecoveryRecordReadFault =>
  value === "INCOHERENT" || value === "NONCANONICAL";
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
function readProofs(value: unknown): readonly RecoveryReconciliationProof[] | RecoveryRecordReadFault {
  if (!Array.isArray(value) || value.length !== RECOVERY_CLASS_POPULATION_ROWS.length) {
    return "NONCANONICAL";
  }
  const proofs: RecoveryReconciliationProof[] = [];
  for (const [index, entry] of value.entries()) {
    const row = RECOVERY_CLASS_POPULATION_ROWS[index];
    const raw = orderedKeys(entry, PROOF_KEYS);
    if (raw === null || row === undefined || raw["class"] !== row.class) return "NONCANONICAL";
    const populations = raw["populations"];
    if (!Array.isArray(populations) || populations.length !== row.populations.length) {
      return "NONCANONICAL";
    }
    if (populations.some((name, at) => name !== row.populations[at])) return "NONCANONICAL";
    const truth = raw["truth"];
    if (truth !== "COMPLETE" && truth !== "UNKNOWN") return "NONCANONICAL";
    if (!isHex64(raw["sourceProofDigest"])) return "NONCANONICAL";
    const itemCount = raw["itemCount"];
    if (!Number.isSafeInteger(itemCount) || (itemCount as number) < 0) return "NONCANONICAL";
    const upstream = readUpstream(raw["upstream"]);
    if (upstream === false) return "NONCANONICAL";
    // A refusal and a completeness claim cannot both be true of one proof, and
    // this is the decode-side twin of the builder's TRUTH_CONTRADICTS refusal.
    if ((truth === "UNKNOWN") !== (upstream !== null)) return "INCOHERENT";
    const proof = Object.freeze({
      class: row.class, itemCount: itemCount as number, populations: row.populations,
      sourceProofDigest: raw["sourceProofDigest"], truth, upstream,
    });
    // The reserved sentinel is the record's way of saying "nothing backed this
    // class". Left unchecked, hostile bytes could hand it a COMPLETE truth and
    // present an unbacked class as proven while carrying no proof digest.
    if (!isCanonicalRecoveryProofSlot(proof)) return "INCOHERENT";
    proofs.push(proof);
  }
  return Object.freeze(proofs);
}

function readItems(value: unknown): readonly RecoveryReconciliationItem[] | RecoveryRecordReadFault {
  if (!Array.isArray(value) || value.length > MAX_RECOVERY_RECONCILIATION_ITEMS) {
    return "NONCANONICAL";
  }
  const items: RecoveryReconciliationItem[] = [];
  for (const entry of value) {
    const raw = orderedKeys(entry, ITEM_KEYS);
    if (raw === null) return "NONCANONICAL";
    const disposition = raw["disposition"];
    const population = raw["population"];
    if (typeof disposition !== "string") return "NONCANONICAL";
    if (!(RECOVERY_INVENTORY_DISPOSITIONS as readonly string[]).includes(disposition)) {
      return "NONCANONICAL";
    }
    const row = RECOVERY_CLASS_POPULATION_ROWS.find((entryRow) => entryRow.class === raw["class"]);
    if (row === undefined || typeof population !== "string") return "NONCANONICAL";
    if (!(row.populations as readonly string[]).includes(population)) return "NONCANONICAL";
    if (typeof raw["identity"] !== "string" || raw["identity"].length === 0) return "NONCANONICAL";
    if (!isHex64(raw["sourceProofDigest"])) return "NONCANONICAL";
    if (!isNullableHex64(raw["terminalProofDigest"])) return "NONCANONICAL";
    if (!isNullableHex64(raw["restoredIntentDigest"])) return "NONCANONICAL";
    if (!isNullableText(raw["restoredIntentRef"]) || !isNullableText(raw["quarantineRef"])) {
      return "NONCANONICAL";
    }
    const upstream = readUpstream(raw["upstream"]);
    if (upstream === false) return "NONCANONICAL";
    const item = Object.freeze({
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
    });
    // The EXACT field combination the adjudicator emits for this disposition.
    // Field-by-field type checks alone accepted ABSENT with no terminal proof
    // and ADOPTED with no restored intent — dispositions claiming an authority
    // nothing else in the record backs.
    if (!isCanonicalRecoveryItemShape(item)) return "INCOHERENT";
    items.push(item);
  }
  // One record, ONE item sequence. Any other permutation, and any repeat of a
  // class-scoped identity, is a second spelling of the same facts that the
  // builder would never have written.
  if (!isCanonicalRecoveryItemSequence(items)) return "INCOHERENT";
  return Object.freeze(items);
}

export function readRecoveryReconciliationRecordBody(parsed: unknown): RecoveryReconciliationRecord | RecoveryRecordReadFault {
  const raw = orderedKeys(parsed, RECORD_KEYS);
  if (raw === null) return "NONCANONICAL";
  if (raw["schemaVersion"] !== RECOVERY_RECONCILIATION_SCHEMA_VERSION) return "NONCANONICAL";
  const configured = raw["configuredClasses"];
  if (!Array.isArray(configured) || configured.length !== RECOVERY_PROOF_CLASSES.length) {
    return "NONCANONICAL";
  }
  if (configured.some((name, index) => name !== RECOVERY_PROOF_CLASSES[index])) {
    return "NONCANONICAL";
  }
  const truth = raw["truth"];
  if (truth !== "COMPLETE" && truth !== "UNKNOWN") return "NONCANONICAL";
  for (const key of ["projectId", "projectTag", "backupCursor"]) {
    if (typeof raw[key] !== "string" || (raw[key] as string).length === 0) return "NONCANONICAL";
  }
  for (const key of ["backupGenerationDigest", "incarnationRef", "keyEpochRef",
    "anchorBindingDigest", "recordDigest"]) {
    if (!isHex64(raw[key])) return "NONCANONICAL";
  }
  const proofs = readProofs(raw["proofs"]);
  if (isRecoveryRecordReadFault(proofs)) return proofs;
  const items = readItems(raw["items"]);
  if (isRecoveryRecordReadFault(items)) return items;
  const upstream = readUpstream(raw["upstream"]);
  if (upstream === false) return "NONCANONICAL";
  // The coordinator answer is the ONE pair this area may persist, and it exists
  // exactly when the truth is UNKNOWN: neither can be present without the other.
  // It is read on its OWN vocabulary, not the upstream one — `UNKNOWN_TRUTH` is
  // not an upstream code, and reusing that reader would admit any of the 24.
  const coordinator = readCoordinator(raw["coordinator"]);
  if (coordinator === false) return "NONCANONICAL";
  if ((truth === "UNKNOWN") !== (coordinator !== null)) return "INCOHERENT";
  // Record truth is a FUNCTION of the children, so it is RECOMPUTED here rather
  // than believed. Trusting the stored field let a record claim COMPLETE while
  // carrying an UNKNOWN proof or an unresolved item, and let the retained code
  // name the wrong cause. Both survived a recomputed digest untouched.
  const derived = deriveRecoveryReconciliationTruth(proofs, items);
  if (derived.truth !== truth) return "INCOHERENT";
  if (!sameRecoveryUpstream(derived.upstream, upstream)) return "INCOHERENT";
  // Re-derived, not trusted: an item's provenance must agree with its class
  // proof, and an item under the reserved unbacked slot cannot hold a positive
  // disposition. Checked HERE, ahead of the digest comparison, so a forged
  // record whose digest was recomputed over the forgery is still refused.
  for (const proof of proofs) {
    const owned = items.filter((item) => item.class === proof.class);
    if (proof.itemCount !== owned.length) return "INCOHERENT";
    const unbacked = proof.sourceProofDigest === RECOVERY_UNKNOWN_PROOF_DIGEST;
    if (owned.some((item) => (unbacked
      ? item.disposition !== "UNKNOWN"
      : item.sourceProofDigest !== proof.sourceProofDigest))) return "INCOHERENT";
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

