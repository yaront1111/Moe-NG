import { createHash } from "node:crypto";

import {
  RECOVERY_INVENTORY_CLASSES,
  collectRecoveryInventory,
  createRecoveryInventoryRegistry,
  isRecoveryInventoryFailure,
} from "@moe/runner";
import type {
  RecoveryInventoryErrorCode,
  RecoveryInventoryLayer,
  RecoveryInventoryRegistration,
  RecoveryInventoryReport,
} from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";

import { readCurrentRecoveryAuthenticationBinding } from "../identity/recovery-authentication-binding.js";
import { createDurableRecoveryInventoryRegistrations } from "./durable-recovery-inventory.js";
import type {
  DurableInventoryBasis,
  DurableInventoryObservation,
  DurableInventoryWindow,
} from "./durable-recovery-inventory-contract.js";
import { DURABLE_RECOVERY_INVENTORY_CLASSES } from "./durable-recovery-inventory-contract.js";
import {
  RECOVERY_COORDINATOR_UNKNOWN_CODE,
  RECOVERY_INVENTORY_LAYER,
  RECOVERY_INVENTORY_UPSTREAM_CODES,
  RECOVERY_PROOF_CLASSES,
  recoveryInventoryRefusal,
} from "./recovery-inventory-contract.js";
import type {
  RecoveryInventoryRefusal,
  RecoveryInventoryUpstream,
  RecoveryProofClass,
  RecoveryReconciliationRecord,
} from "./recovery-inventory-contract.js";
import type { RestoredEffectIntent } from "./effect-inventory-join.js";
import { nodeProofDigestMap } from "./effect-inventory-join.js";
import { readAnchoredIncarnation } from "./recovery-incarnation-anchor.js";
import type { RecoveryDurableReconcileRequest } from "./recovery-inventory-ledger.js";
import { buildRecoveryReconciliationRecord } from "./recovery-inventory-record.js";
import type {
  RecoveryConfiguredProof,
  RecoveryReconciliationSelectedRefs,
} from "./recovery-inventory-record.js";

export interface EffectInventoryConfiguration {
  readonly nodeRegistrations: readonly RecoveryInventoryRegistration[];
}

export interface EffectInventoryRequest extends RecoveryDurableReconcileRequest {
  readonly backupCursor: string;
  readonly backupGenerationDigest: string;
  readonly durableWindow: DurableInventoryWindow;
  readonly nodeWindow: { readonly endInclusive: string; readonly startInclusive: string };
  readonly projectTag: string;
  readonly restoredIntents: readonly RestoredEffectIntent[];
}

export type EffectInventoryUpstream =
  | RecoveryInventoryUpstream
  | { readonly code: RecoveryInventoryErrorCode; readonly layer: RecoveryInventoryLayer };

export interface EffectInventoryHeld {
  readonly authority: "NONE";
  readonly code: typeof RECOVERY_COORDINATOR_UNKNOWN_CODE;
  readonly layer: typeof RECOVERY_INVENTORY_LAYER;
  readonly ok: false;
  readonly outcome: "REFUSED";
  readonly reason: string;
  readonly record?: RecoveryReconciliationRecord;
  readonly recordDigest?: string;
  readonly truth: "UNKNOWN";
  readonly upstream: EffectInventoryUpstream;
}

export interface SelectedEffectRecovery {
  readonly backupGenerationDigest: string;
  readonly refs: RecoveryReconciliationSelectedRefs;
}

interface DurableCollection {
  readonly items: readonly DurableInventoryObservation[];
  readonly proofs: readonly RecoveryConfiguredProof[];
  readonly upstreamByClass: ReadonlyMap<RecoveryProofClass, RecoveryInventoryUpstream>;
}

export interface EffectInventorySources {
  readonly durable: DurableCollection;
  readonly node: RecoveryInventoryReport;
  readonly ok: true;
  readonly proofDigests: ReadonlyMap<RecoveryProofClass, string>;
  readonly proofs: readonly RecoveryConfiguredProof[];
}

const local = (code: RecoveryInventoryUpstream["code"]): RecoveryInventoryUpstream =>
  Object.freeze({ code, layer: RECOVERY_INVENTORY_LAYER });

const selectionRefusal = (code: RecoveryInventoryUpstream["code"]): RecoveryInventoryRefusal =>
  recoveryInventoryRefusal(local(code), "The current recovery selection is unavailable or mismatched.");

export function selectEffectRecovery(
  store: SqliteEventStore,
  projectId: string,
): SelectedEffectRecovery | RecoveryInventoryRefusal {
  const current = readCurrentRecoveryAuthenticationBinding(store);
  if (current === null) return selectionRefusal("RECOVERY_BINDING_UNAVAILABLE");
  const anchored = readAnchoredIncarnation(store, projectId, current.recoveryIncarnationRef);
  if (anchored === null) return selectionRefusal("RECOVERY_ANCHOR_UNAVAILABLE");
  if (anchored.keyEpochRef !== current.keyEpochRef) return selectionRefusal("RECOVERY_BINDING_MISMATCH");
  return Object.freeze({
    backupGenerationDigest: anchored.backupGenerationDigest,
    refs: Object.freeze({
      anchorBindingDigest: anchored.bindingDigest,
      incarnationRef: anchored.incarnationRef,
      keyEpochRef: anchored.keyEpochRef,
    }),
  });
}

export const effectInventoryConfiguredClasses = (
  configuration: EffectInventoryConfiguration,
): readonly string[] => Object.freeze([
  ...configuration.nodeRegistrations.map((registration) => registration.class),
  ...DURABLE_RECOVERY_INVENTORY_CLASSES,
]);

export function effectInventoryConfigurationRefusal(
  request: EffectInventoryRequest,
  selected: RecoveryReconciliationSelectedRefs,
  configured: readonly string[],
): RecoveryInventoryRefusal | null {
  const result = buildRecoveryReconciliationRecord({
    backupCursor: request.backupCursor,
    backupGenerationDigest: request.backupGenerationDigest,
    configuredClasses: configured,
    projectId: request.projectId,
    projectTag: request.projectTag,
    proofs: [],
    selected,
    subjects: [],
  });
  return result.ok ? null : result;
}

const failureDigest = (upstream: RecoveryInventoryUpstream): string =>
  createHash("sha256").update(JSON.stringify([upstream.layer, upstream.code]), "utf8").digest("hex");

function collectDurable(store: SqliteEventStore, request: EffectInventoryRequest): DurableCollection {
  const basis: DurableInventoryBasis = {
    backupCursor: request.backupCursor,
    backupGenerationDigest: request.backupGenerationDigest,
    projectTag: request.projectTag,
  };
  const items: DurableInventoryObservation[] = [];
  const proofs: RecoveryConfiguredProof[] = [];
  const upstreamByClass = new Map<RecoveryProofClass, RecoveryInventoryUpstream>();
  for (const registration of createDurableRecoveryInventoryRegistrations(store, request.projectId)) {
    const result = registration.enumerate(basis, request.durableWindow);
    if (!result.ok) {
      proofs.push({ class: registration.class, sourceProofDigest: failureDigest(result.upstream), truth: "UNKNOWN", upstream: result.upstream });
      upstreamByClass.set(registration.class, result.upstream);
    } else {
      items.push(...result.observations);
      proofs.push(result.proof);
    }
  }
  return Object.freeze({ items: Object.freeze(items), proofs: Object.freeze(proofs), upstreamByClass });
}

const admittedNodeUpstream = (code: RecoveryInventoryErrorCode): RecoveryInventoryUpstream => ({
  code: (RECOVERY_INVENTORY_UPSTREAM_CODES as readonly string[]).includes(code)
    ? code as RecoveryInventoryUpstream["code"]
    : "RECOVERY_INVENTORY_COVERAGE_UNKNOWN",
  layer: "INVENTORY_ADAPTER",
});

function nodeProofs(report: RecoveryInventoryReport): readonly RecoveryConfiguredProof[] {
  return report.proofs.map((proof) => ({
    class: proof.class,
    sourceProofDigest: report.inventoryDigest,
    truth: proof.truth,
    upstream: proof.truth === "UNKNOWN"
      ? admittedNodeUpstream(proof.code ?? "RECOVERY_INVENTORY_COVERAGE_UNKNOWN")
      : null,
  }));
}

export function effectInventoryHeld(
  upstream: EffectInventoryUpstream,
  record?: RecoveryReconciliationRecord,
): EffectInventoryHeld {
  return Object.freeze({
    authority: "NONE" as const, code: RECOVERY_COORDINATOR_UNKNOWN_CODE,
    layer: RECOVERY_INVENTORY_LAYER, ok: false as const, outcome: "REFUSED" as const,
    reason: "Recovery inventory or reconciliation remains incomplete.",
    ...(record === undefined ? {} : { record, recordDigest: record.recordDigest }),
    truth: "UNKNOWN" as const, upstream: Object.freeze({ ...upstream }),
  });
}

export async function collectEffectInventorySources(
  store: SqliteEventStore,
  request: EffectInventoryRequest,
  configuration: EffectInventoryConfiguration,
  selected: SelectedEffectRecovery,
): Promise<EffectInventorySources | EffectInventoryHeld> {
  const node = await collectRecoveryInventory({
    projectTag: request.projectTag,
    backup: { kind: "BACKUP_CURSOR_GENERATION", ref: request.backupCursor, digest: request.backupGenerationDigest },
    incarnation: { kind: "RECOVERY_INCARNATION", ref: selected.refs.incarnationRef, digest: selected.refs.anchorBindingDigest },
    window: request.nodeWindow,
    configuredClasses: [...RECOVERY_INVENTORY_CLASSES],
  }, createRecoveryInventoryRegistry(configuration.nodeRegistrations));
  if (isRecoveryInventoryFailure(node)) return effectInventoryHeld({ code: node.code, layer: node.layer });
  const durable = collectDurable(store, request);
  const proofDigests = new Map(nodeProofDigestMap(node));
  for (const proof of durable.proofs) proofDigests.set(proof.class as RecoveryProofClass, proof.sourceProofDigest);
  return Object.freeze({ durable, node, ok: true as const, proofDigests,
    proofs: Object.freeze([...nodeProofs(node), ...durable.proofs]) });
}

export function firstEffectInventoryUnknown(
  sources: EffectInventorySources,
  items: RecoveryReconciliationRecord["items"],
): EffectInventoryUpstream {
  for (const proofClass of RECOVERY_PROOF_CLASSES) {
    const node = sources.node.proofs.find((proof) => proof.class === proofClass && proof.truth === "UNKNOWN");
    if (node?.code !== null && node?.code !== undefined) return { code: node.code, layer: node.layer };
    const durable = sources.durable.upstreamByClass.get(proofClass);
    if (durable !== undefined) return durable;
  }
  return items.find((item) => item.disposition === "UNKNOWN")?.upstream
    ?? local("RECOVERY_INVENTORY_ITEM_UNRESOLVED");
}

export const effectInventoryBindingMismatch = (): RecoveryInventoryRefusal =>
  selectionRefusal("RECOVERY_BINDING_MISMATCH");

export const effectInventoryRecordConflict = (): RecoveryInventoryUpstream => local("RECORD_CONFLICT");
