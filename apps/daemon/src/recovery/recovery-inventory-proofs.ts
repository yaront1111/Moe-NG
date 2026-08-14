import {
  RECOVERY_CLASS_POPULATION_ROWS,
  RECOVERY_PROOF_CLASSES,
  RECOVERY_UNKNOWN_PROOF_DIGEST,
  recoveryInventoryRefusal,
} from "./recovery-inventory-contract.js";
import type {
  RecoveryInventoryRefusal,
  RecoveryInventoryTruth,
  RecoveryInventoryUpstream,
  RecoveryProofClass,
  RecoveryReconciliationItem,
  RecoveryReconciliationProof,
} from "./recovery-inventory-contract.js";
import type { RecoveryConfiguredProof } from "./recovery-inventory-subject.js";

/**
 * The configured-proof side of the reconciliation contract: validate the rows a
 * caller actually supplied, then normalise them onto the frozen six-class
 * mapping.
 *
 * Split from `recovery-inventory-record.ts` deliberately. The first version of
 * that module validated the configured class NAMES and then read the proof rows
 * with `supplied.find`, which silently discarded every unmatched row — an
 * unknown seventh class and a duplicated row both disappeared while the record
 * still reported COMPLETE. A supplied row set is caller input like any other and
 * gets the same closed-vocabulary treatment, under its OWN reason codes so a
 * green test can tell which of the two guards refused.
 */
const local = (code: RecoveryInventoryUpstream["code"]): RecoveryInventoryUpstream =>
  Object.freeze({ code, layer: "RECOVERY_INVENTORY" as const });

const PROOF_REFUSALS = Object.freeze({
  DIGEST_RESERVED: recoveryInventoryRefusal(
    local("RECOVERY_INVENTORY_PROOF_DIGEST_RESERVED"),
    "A supplied proof claimed the digest reserved for an unbacked class slot.",
  ),
  ITEM_MISMATCH: recoveryInventoryRefusal(
    local("RECOVERY_INVENTORY_ITEM_PROOF_MISMATCH"),
    "A subject cited a source proof digest its configured class proof contradicts.",
  ),
  ROW_DUPLICATE: recoveryInventoryRefusal(
    local("RECOVERY_INVENTORY_PROOF_CLASS_DUPLICATE"),
    "A supplied proof class was presented more than once.",
  ),
  ROW_EXTRA: recoveryInventoryRefusal(
    local("RECOVERY_INVENTORY_PROOF_CLASS_EXTRA"),
    "More proof rows were supplied than the frozen mapping declares classes.",
  ),
  ROW_UNKNOWN: recoveryInventoryRefusal(
    local("RECOVERY_INVENTORY_PROOF_CLASS_UNKNOWN"),
    "A supplied proof named a class the frozen mapping does not declare.",
  ),
  TRUTH_CONTRADICTS: recoveryInventoryRefusal(
    local("RECOVERY_INVENTORY_PROOF_TRUTH_CONTRADICTS"),
    "A supplied proof asserted complete coverage while carrying an upstream refusal.",
  ),
});

export type RecoveryProofIndex = ReadonlyMap<RecoveryProofClass, RecoveryConfiguredProof>;

/**
 * Rows are a closed UNIQUE set, though an omitted row is legitimate: missing
 * evidence for a well-formed class is the canonical UNKNOWN slot below, whereas
 * an unknown or repeated row is a structural fault. Length is asked FIRST and
 * deliberately: with only six class names, an over-long list is always ALSO a
 * duplicate, so letting the duplicate guard answer first would leave the EXTRA
 * branch unreachable for every possible input while its test stayed green.
 */
export function indexConfiguredProofs(
  supplied: readonly RecoveryConfiguredProof[],
): RecoveryProofIndex | RecoveryInventoryRefusal {
  if (supplied.length > RECOVERY_PROOF_CLASSES.length) return PROOF_REFUSALS.ROW_EXTRA;
  const index = new Map<RecoveryProofClass, RecoveryConfiguredProof>();
  for (const proof of supplied) {
    if (!(RECOVERY_PROOF_CLASSES as readonly string[]).includes(proof.class)) {
      return PROOF_REFUSALS.ROW_UNKNOWN;
    }
    const proofClass = proof.class as RecoveryProofClass;
    if (index.has(proofClass)) return PROOF_REFUSALS.ROW_DUPLICATE;
    if (proof.sourceProofDigest === RECOVERY_UNKNOWN_PROOF_DIGEST) {
      return PROOF_REFUSALS.DIGEST_RESERVED;
    }
    // COMPLETE means "this adapter enumerated the whole population and proved
    // it". A row asserting that WHILE reporting an upstream refusal states two
    // facts that cannot both hold, and the normalisation below would have
    // resolved it by keeping COMPLETE and dropping the refusal on the floor —
    // laundering an adapter's own admission of incomplete coverage into proof.
    if (proof.truth === "COMPLETE" && proof.upstream !== null) {
      return PROOF_REFUSALS.TRUTH_CONTRADICTS;
    }
    index.set(proofClass, proof);
  }
  return index;
}

/**
 * Provenance must agree with itself. A subject citing a digest its own class
 * proof contradicts binds two incompatible origins into one record, so it is a
 * structural refusal rather than a per-item downgrade: the caller supplied a
 * fact and a proof that cannot both be true.
 */
export function refuseContradictingProof(
  proofs: RecoveryProofIndex,
  mapped: RecoveryProofClass,
  sourceProofDigest: string,
): RecoveryInventoryRefusal | null {
  const proof = proofs.get(mapped);
  if (proof === undefined) return null;
  return proof.sourceProofDigest === sourceProofDigest ? null : PROOF_REFUSALS.ITEM_MISMATCH;
}

/**
 * An item under a class with NO configured proof keeps its own reported digest —
 * provenance is retained, never restamped — but cannot hold a positive
 * disposition: nothing configured backs the evidence it was adjudicated from.
 */
export function unbackedItem(
  item: RecoveryReconciliationItem,
  proofs: RecoveryProofIndex,
): RecoveryReconciliationItem {
  if (proofs.has(item.class) || item.disposition === "UNKNOWN") return item;
  return Object.freeze({
    ...item,
    disposition: "UNKNOWN" as const,
    upstream: local("RECOVERY_INVENTORY_PROOF_MISSING"),
  });
}

/**
 * Every configured class gets a proof row. A class the caller supplied no proof
 * for becomes a canonical UNKNOWN slot rather than disappearing: an absent row
 * would silently shrink the mapping, which is exactly the failure this contract
 * exists to prevent. No path here can raise a slot to COMPLETE.
 */
export function normaliseProofs(
  proofs: RecoveryProofIndex,
  items: readonly RecoveryReconciliationItem[],
): readonly RecoveryReconciliationProof[] {
  return RECOVERY_CLASS_POPULATION_ROWS.map((row) => {
    const match = proofs.get(row.class);
    const itemCount = items.filter((item) => item.class === row.class).length;
    if (match === undefined) {
      return Object.freeze({
        class: row.class,
        itemCount,
        populations: row.populations,
        sourceProofDigest: RECOVERY_UNKNOWN_PROOF_DIGEST,
        truth: "UNKNOWN" as const,
        upstream: local("RECOVERY_INVENTORY_PROOF_MISSING"),
      });
    }
    const truth: RecoveryInventoryTruth = match.truth === "COMPLETE" ? "COMPLETE" : "UNKNOWN";
    return Object.freeze({
      class: row.class,
      itemCount,
      populations: row.populations,
      sourceProofDigest: match.sourceProofDigest,
      truth,
      upstream:
        truth === "UNKNOWN"
          ? Object.freeze(match.upstream ?? local("RECOVERY_INVENTORY_PROOF_INCOMPLETE"))
          : null,
    });
  });
}
