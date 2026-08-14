import {
  RECOVERY_INVENTORY_POPULATIONS,
  RECOVERY_PROOF_CLASSES,
  RECOVERY_UNKNOWN_PROOF_DIGEST,
} from "./recovery-inventory-contract.js";
import type {
  RecoveryInventoryPopulation,
  RecoveryInventoryTruth,
  RecoveryInventoryUpstream,
  RecoveryProofClass,
  RecoveryReconciliationItem,
  RecoveryReconciliationProof,
} from "./recovery-inventory-contract.js";

/**
 * The ONE place the semantic invariants of a reconciliation record live.
 *
 * Both sides of the durable boundary use these exact functions: the builder
 * EMITS with them, the decoder RE-DERIVES against them. That sharing is the
 * point. Reopen #2 found six forgeries that survived a strict decoder because
 * the decoder only checked shape, digest and byte spelling — a hostile record
 * whose `recordDigest` was recomputed over the forgery is perfectly canonical
 * and perfectly digested, so nothing but an independent re-derivation of what
 * the builder enforced can refuse it. Keeping one implementation also stops the
 * two sides drifting into disagreement about what "canonical" means.
 */
const classRank = (proofClass: RecoveryProofClass): number =>
  RECOVERY_PROOF_CLASSES.indexOf(proofClass);

const populationRank = (population: RecoveryInventoryPopulation): number =>
  RECOVERY_INVENTORY_POPULATIONS.indexOf(population);

/**
 * U+0000, built with `fromCharCode` rather than written into the source. A
 * literal NUL byte makes Git classify the whole TypeScript blob as binary and
 * kills line diff, blame and merge for the file, and the backslash-u escape for
 * it does not survive every editor and shell that touches this repo; computing
 * it leaves the source plain ASCII with the identical runtime value. A control
 * character is the correct separator because identity validation rejects every
 * `\p{Cc}`/`\p{Cf}` code point, so it can never occur inside an identity.
 */
const IDENTITY_SEPARATOR = String.fromCharCode(0);

/**
 * Class-scoped, never global: one external identity may legitimately appear in
 * two different proof classes, and the separator cannot occur inside a
 * validated identity, so no pair of distinct (class, identity) tuples can
 * collide onto one key.
 */
export const recoveryClassScopedIdentity = (proofClass: string, identity: string): string =>
  `${proofClass}${IDENTITY_SEPARATOR}${identity}`;

/**
 * Declared class order, then declared POPULATION order inside that class, then
 * identity. Population rank outranks identity deliberately: the mapping's row
 * order is the canonical order, so a class covering two populations lists them
 * as the contract declares them rather than however their identities sort.
 */
export function compareRecoveryReconciliationItems(
  left: RecoveryReconciliationItem,
  right: RecoveryReconciliationItem,
): number {
  const byClass = classRank(left.class) - classRank(right.class);
  if (byClass !== 0) return byClass;
  const byPopulation = populationRank(left.population) - populationRank(right.population);
  if (byPopulation !== 0) return byPopulation;
  return left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0;
}

export const orderRecoveryReconciliationItems = (
  items: readonly RecoveryReconciliationItem[],
): readonly RecoveryReconciliationItem[] => [...items].sort(compareRecoveryReconciliationItems);

/**
 * Strictly increasing AND class-scoped unique. Two separate faults share one
 * loop because both mean the same thing: this list is not the single ordered
 * sequence the builder would have produced for this set of items. Equality
 * compares to zero, so an exact repeat is caught by the ordering test and a
 * repeat that differs only by population is caught by the identity set.
 */
export function isCanonicalRecoveryItemSequence(
  items: readonly RecoveryReconciliationItem[],
): boolean {
  const seen = new Set<string>();
  let previous: RecoveryReconciliationItem | undefined;
  for (const item of items) {
    if (previous !== undefined && compareRecoveryReconciliationItems(previous, item) >= 0) {
      return false;
    }
    const key = recoveryClassScopedIdentity(item.class, item.identity);
    if (seen.has(key)) return false;
    seen.add(key);
    previous = item;
  }
  return true;
}

const present = (value: string | null): boolean => value !== null;

const provenanceArms = (item: RecoveryReconciliationItem): number =>
  [present(item.terminalProofDigest), present(item.quarantineRef), present(item.restoredIntentRef)]
    .filter(Boolean).length;

/**
 * Exactly the field combinations the adjudicator can emit — required fields
 * present, forbidden fields absent. Without this, hostile bytes could assert
 * ABSENT with no terminal proof or ADOPTED with no restored intent, which is a
 * disposition claiming an authority nothing in the record backs.
 */
export function isCanonicalRecoveryItemShape(item: RecoveryReconciliationItem): boolean {
  const intentPaired = present(item.restoredIntentRef) === present(item.restoredIntentDigest);
  if (!intentPaired) return false;
  if (item.disposition === "ABSENT" || item.disposition === "CANCELLED") {
    return present(item.terminalProofDigest) && provenanceArms(item) === 1 &&
      item.upstream === null;
  }
  if (item.disposition === "ADOPTED") {
    return present(item.restoredIntentRef) && provenanceArms(item) === 1 && item.upstream === null;
  }
  if (item.disposition === "QUARANTINED") {
    // Orphaned state gets a quarantine reference; a rejected adoption gets the
    // refusal that rejected it. Exactly one, never both and never neither.
    return present(item.quarantineRef) !== (item.upstream !== null) &&
      !present(item.terminalProofDigest) && !present(item.restoredIntentRef);
  }
  // UNKNOWN always states WHY, and RETAINS at most the one provenance arm it
  // was downgraded from: an unbacked ABSENT keeps its terminal proof, an
  // unbacked ADOPTED keeps its intent pair, and neither becomes evidence again.
  return item.upstream !== null && provenanceArms(item) <= 1;
}

/**
 * The reserved sentinel means "no configured proof backed this class". A slot
 * spelling it may only ever be UNKNOWN with the missing-proof code: otherwise a
 * record could present an unbacked class as proven complete while carrying no
 * proof digest at all.
 */
export function isCanonicalRecoveryProofSlot(proof: RecoveryReconciliationProof): boolean {
  if (proof.sourceProofDigest !== RECOVERY_UNKNOWN_PROOF_DIGEST) return true;
  return proof.truth === "UNKNOWN" &&
    proof.upstream?.code === "RECOVERY_INVENTORY_PROOF_MISSING" &&
    proof.upstream.layer === "RECOVERY_INVENTORY";
}

export interface RecoveryDerivedTruth {
  readonly truth: RecoveryInventoryTruth;
  readonly upstream: RecoveryInventoryUpstream | null;
}

const upstream = (
  code: RecoveryInventoryUpstream["code"],
): RecoveryInventoryUpstream => Object.freeze({ code, layer: "RECOVERY_INVENTORY" as const });

/**
 * Record truth is a FUNCTION of the children, never an independent field. One
 * incomplete proof or one unresolved item drags the whole record to UNKNOWN,
 * and the retained code says which of the two caused it.
 */
export function deriveRecoveryReconciliationTruth(
  proofs: readonly RecoveryReconciliationProof[],
  items: readonly RecoveryReconciliationItem[],
): RecoveryDerivedTruth {
  const proofUnknown = proofs.some((proof) => proof.truth === "UNKNOWN");
  const itemUnknown = items.some((item) => item.disposition === "UNKNOWN");
  if (proofUnknown) {
    return Object.freeze({
      truth: "UNKNOWN" as const,
      upstream: upstream("RECOVERY_INVENTORY_PROOF_INCOMPLETE"),
    });
  }
  if (itemUnknown) {
    return Object.freeze({
      truth: "UNKNOWN" as const,
      upstream: upstream("RECOVERY_INVENTORY_ITEM_UNRESOLVED"),
    });
  }
  return Object.freeze({ truth: "COMPLETE" as const, upstream: null });
}

export const sameRecoveryUpstream = (
  left: RecoveryInventoryUpstream | null,
  right: RecoveryInventoryUpstream | null,
): boolean =>
  left === null || right === null
    ? left === right
    : left.code === right.code && left.layer === right.layer;
