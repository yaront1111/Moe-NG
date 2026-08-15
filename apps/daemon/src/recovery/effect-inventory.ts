import type { SqliteEventStore } from "@moe/store";

import {
  collectEffectInventorySources,
  effectInventoryBindingMismatch,
  effectInventoryConfigurationRefusal,
  effectInventoryConfiguredClasses,
  effectInventoryHeld,
  effectInventoryRecordConflict,
  firstEffectInventoryUnknown,
  selectEffectRecovery,
} from "./effect-inventory-collection.js";
import type {
  EffectInventoryConfiguration,
  EffectInventoryHeld,
  EffectInventoryRequest,
  EffectInventorySources,
} from "./effect-inventory-collection.js";
import { joinEffectInventoryItems } from "./effect-inventory-join.js";
import {
  readRecoveryReconciliation,
  recordRecoveryReconciliation,
} from "./recovery-inventory-ledger.js";
import type {
  RecoveryReconciliationExternalFacts,
  RecoveryReconciliationRecorded,
} from "./recovery-inventory-ledger.js";
import type { RecoveryInventoryRefusal } from "./recovery-inventory-contract.js";
import { buildRecoveryReconciliationRecord } from "./recovery-inventory-record.js";

export type {
  EffectInventoryConfiguration,
  EffectInventoryHeld,
  EffectInventoryRequest,
  EffectInventoryUpstream,
} from "./effect-inventory-collection.js";
export type { RestoredEffectIntent, RestoredIntentProof } from "./effect-inventory-join.js";

export type EffectInventoryOutcome =
  | RecoveryReconciliationRecorded
  | RecoveryInventoryRefusal
  | EffectInventoryHeld;

function persistEffectInventory(
  store: SqliteEventStore,
  request: EffectInventoryRequest,
  facts: RecoveryReconciliationExternalFacts,
  expectedDigest: string,
  sources: EffectInventorySources,
): EffectInventoryOutcome {
  const scope = {
    correlationId: request.correlationId,
    decidedAt: request.decidedAt,
    principalId: request.principalId,
    projectId: request.projectId,
  };
  const written = recordRecoveryReconciliation(store, scope, facts);
  if (!written.ok) return written;
  const read = readRecoveryReconciliation(store, request.projectId, written.recordDigest);
  if (!read.ok) return read;
  if (read.record.recordDigest !== expectedDigest) {
    return effectInventoryHeld(effectInventoryRecordConflict());
  }
  if (read.record.truth === "UNKNOWN") {
    return effectInventoryHeld(firstEffectInventoryUnknown(sources, read.record.items), read.record);
  }
  return Object.freeze({ ...written, record: read.record });
}

/**
 * Enumerates the configured node and durable populations, joins them to restored
 * history, and persists one content-addressed reconciliation record. No UNKNOWN
 * record is returned as success: persisted uncertainty still holds authority.
 */
export async function reconcileEffectInventory(
  store: SqliteEventStore,
  request: EffectInventoryRequest,
  configuration: EffectInventoryConfiguration,
): Promise<EffectInventoryOutcome> {
  const selected = selectEffectRecovery(store, request.projectId);
  if ("ok" in selected) return selected;
  if (selected.backupGenerationDigest !== request.backupGenerationDigest) {
    return effectInventoryBindingMismatch();
  }
  const configured = effectInventoryConfiguredClasses(configuration);
  const invalid = effectInventoryConfigurationRefusal(request, selected.refs, configured);
  if (invalid !== null) return invalid;
  const sources = await collectEffectInventorySources(store, request, configuration, selected);
  if (!sources.ok) return sources;
  const joined = joinEffectInventoryItems({
    durableItems: sources.durable.items,
    nodeItems: sources.node.items,
    proofDigests: sources.proofDigests,
    restoredIntents: request.restoredIntents,
    selected: selected.refs,
  });
  if (!joined.ok) return joined;
  const facts = {
    backupCursor: request.backupCursor,
    backupGenerationDigest: request.backupGenerationDigest,
    configuredClasses: configured,
    projectTag: request.projectTag,
    proofs: sources.proofs,
    subjects: joined.subjects,
  };
  const built = buildRecoveryReconciliationRecord({
    ...facts,
    projectId: request.projectId,
    selected: selected.refs,
  });
  if (!built.ok) return built;
  return persistEffectInventory(store, request, facts, built.record.recordDigest, sources);
}
