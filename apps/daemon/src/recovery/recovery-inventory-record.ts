import {
  MAX_RECOVERY_RECONCILIATION_BYTES,
  RECOVERY_PROOF_CLASSES,
  RECOVERY_RECONCILIATION_SCHEMA_VERSION,
  exactDataRecord,
  recoveryInventoryRefusal,
  recoveryPopulationClass,
} from "./recovery-inventory-contract.js";
import type {
  RecoveryInventoryUpstream,
  RecoveryProofClass,
  RecoveryReconciliationItem,
  RecoveryReconciliationRecord,
  RecoveryInventoryRefusal,
} from "./recovery-inventory-contract.js";
import {
  encodeRecoveryReconciliationRecord,
  recoveryReconciliationDigest,
} from "./recovery-inventory-codec.js";
import {
  deriveRecoveryReconciliationTruth,
  orderRecoveryReconciliationItems,
  recoveryClassScopedIdentity,
} from "./recovery-inventory-invariants.js";
import {
  indexConfiguredProofs,
  normaliseProofs,
  refuseContradictingProof,
  unbackedItem,
} from "./recovery-inventory-proofs.js";
import {
  adjudicateSubject,
  snapshotBuildInput,
} from "./recovery-inventory-subject.js";
import type { RecoveryReconciliationBuildInput } from "./recovery-inventory-subject.js";

export type {
  RecoveryConfiguredProof,
  RecoveryReconciliationBuildInput,
  RecoveryReconciliationSelectedRefs,
  RecoveryReconciliationSubject,
  RecoverySubjectEvidence,
} from "./recovery-inventory-subject.js";

export interface RecoveryReconciliationBuilt {
  readonly ok: true;
  readonly outcome: "RECONCILED";
  readonly authority: "NONE";
  readonly record: RecoveryReconciliationRecord;
}

export type RecoveryReconciliationResult =
  | RecoveryReconciliationBuilt
  | RecoveryInventoryRefusal;

const local = (code: RecoveryInventoryUpstream["code"]): RecoveryInventoryUpstream =>
  Object.freeze({ code, layer: "RECOVERY_INVENTORY" as const });

const REFUSALS = Object.freeze({
  CLASS_DUPLICATE: recoveryInventoryRefusal(
    local("RECOVERY_INVENTORY_CLASS_DUPLICATE"),
    "A configured proof class was named more than once.",
  ),
  CLASS_EXTRA: recoveryInventoryRefusal(
    local("RECOVERY_INVENTORY_CLASS_EXTRA"),
    "The configured class set carries more classes than the frozen mapping declares.",
  ),
  CLASS_OMITTED: recoveryInventoryRefusal(
    local("RECOVERY_INVENTORY_CLASS_OMITTED"),
    "The configured class set omits a class the frozen mapping requires.",
  ),
  CLASS_UNKNOWN: recoveryInventoryRefusal(
    local("RECOVERY_INVENTORY_CLASS_UNKNOWN"),
    "The configured class set names a class the frozen mapping does not declare.",
  ),
  INPUT_INVALID: recoveryInventoryRefusal(
    local("RECOVERY_INVENTORY_INPUT_INVALID"),
    "The reconciliation input did not present the exact expected data fields.",
  ),
  POPULATION_UNMAPPED: recoveryInventoryRefusal(
    local("RECOVERY_INVENTORY_POPULATION_UNMAPPED"),
    "A subject named a population its declared proof class does not cover.",
  ),
  RECORD_OVERSIZED: recoveryInventoryRefusal(
    local("RECOVERY_INVENTORY_RECORD_OVERSIZED"),
    "The reconciled record encodes above the byte cap the decoder would refuse it at.",
  ),
  SUBJECT_DUPLICATE: recoveryInventoryRefusal(
    local("RECOVERY_INVENTORY_SUBJECT_DUPLICATE"),
    "Two subjects claimed one class-scoped external identity.",
  ),
});

/**
 * The configured class set must be EXACTLY the frozen six. A malformed set is a
 * structural refusal, unlike missing evidence for a well-formed class, which is
 * a legitimate UNKNOWN slot below. Conflating the two would let a caller shrink
 * the mapping by simply not configuring a class it did not want inventoried.
 */
function refuseConfiguredClasses(
  configured: readonly string[],
): RecoveryInventoryRefusal | null {
  // Length is asked FIRST and deliberately. Only six class names exist, so an
  // over-long list is always ALSO a duplicate; letting the duplicate guard
  // answer first would leave EXTRA unreachable while its test stayed green.
  if (configured.length > RECOVERY_PROOF_CLASSES.length) return REFUSALS.CLASS_EXTRA;
  const seen = new Set<string>();
  for (const entry of configured) {
    if (!(RECOVERY_PROOF_CLASSES as readonly string[]).includes(entry)) return REFUSALS.CLASS_UNKNOWN;
    if (seen.has(entry)) return REFUSALS.CLASS_DUPLICATE;
    seen.add(entry);
  }
  if (seen.size < RECOVERY_PROOF_CLASSES.length) return REFUSALS.CLASS_OMITTED;
  return null;
}

const BUILD_INPUT_KEYS = Object.freeze([
  "backupCursor",
  "backupGenerationDigest",
  "configuredClasses",
  "projectId",
  "projectTag",
  "proofs",
  "selected",
  "subjects",
]);

/**
 * Total: every path returns a record or a refusal, and nothing throws. The
 * caller's objects are read through descriptor snapshots and copied; they are
 * never frozen and never mutated, because a builder that froze its input would
 * change the caller's world as a side effect of being asked a question.
 */
export function buildRecoveryReconciliationRecord(
  value: unknown,
): RecoveryReconciliationResult {
  const raw = exactDataRecord(value, BUILD_INPUT_KEYS);
  if (raw === null) return REFUSALS.INPUT_INVALID;
  const input: RecoveryReconciliationBuildInput | null = snapshotBuildInput(raw);
  if (input === null) return REFUSALS.INPUT_INVALID;

  const classRefusal = refuseConfiguredClasses(input.configuredClasses);
  if (classRefusal !== null) return classRefusal;
  // The supplied proof ROWS are validated too, not merely consulted: reading
  // them by lookup alone let an unknown or duplicated row vanish unanswered.
  const indexed = indexConfiguredProofs(input.proofs);
  if ("ok" in indexed) return indexed;

  const items: RecoveryReconciliationItem[] = [];
  const seen = new Set<string>();
  for (const subject of input.subjects) {
    const declared = subject.class as RecoveryProofClass;
    const mapped = recoveryPopulationClass(subject.population);
    if (mapped === null || mapped !== declared) return REFUSALS.POPULATION_UNMAPPED;
    const identityKey = recoveryClassScopedIdentity(declared, subject.identity);
    if (seen.has(identityKey)) return REFUSALS.SUBJECT_DUPLICATE;
    seen.add(identityKey);
    const contradiction = refuseContradictingProof(indexed, mapped, subject.sourceProofDigest);
    if (contradiction !== null) return contradiction;
    items.push(unbackedItem(adjudicateSubject(subject, mapped, input.selected), indexed));
  }

  // Order and truth come from the SHARED invariant surface, which the decoder
  // re-derives with too. One implementation, so the two sides of the durable
  // boundary cannot drift into disagreeing about what canonical means.
  const ordered = orderRecoveryReconciliationItems(items);
  const proofs = normaliseProofs(indexed, ordered);
  const { truth, upstream } = deriveRecoveryReconciliationTruth(proofs, ordered);

  const body = Object.freeze({
    anchorBindingDigest: input.selected.anchorBindingDigest,
    backupCursor: input.backupCursor,
    backupGenerationDigest: input.backupGenerationDigest,
    configuredClasses: Object.freeze([...RECOVERY_PROOF_CLASSES]),
    coordinator:
      truth === "UNKNOWN"
        ? Object.freeze({ code: "UNKNOWN_TRUTH" as const, layer: "RECOVERY_INVENTORY" as const })
        : null,
    incarnationRef: input.selected.incarnationRef,
    items: Object.freeze(ordered),
    keyEpochRef: input.selected.keyEpochRef,
    projectId: input.projectId,
    projectTag: input.projectTag,
    proofs: Object.freeze(proofs),
    schemaVersion: RECOVERY_RECONCILIATION_SCHEMA_VERSION,
    truth,
    upstream,
  });

  const record = Object.freeze({ ...body, recordDigest: recoveryReconciliationDigest(body) });
  // The item and text caps bound each field, not their product: the maximum
  // item count at the maximum text length encodes well past the byte cap the
  // decoder refuses at. Measured on the canonical bytes the ledger would commit,
  // so a record is refused HERE, before any write, rather than committed as
  // RECORDED and then unreadable under its own digest forever.
  if (encodeRecoveryReconciliationRecord(record).length > MAX_RECOVERY_RECONCILIATION_BYTES) {
    return REFUSALS.RECORD_OVERSIZED;
  }

  return Object.freeze({
    authority: "NONE" as const,
    ok: true as const,
    outcome: "RECONCILED" as const,
    record,
  });
}
