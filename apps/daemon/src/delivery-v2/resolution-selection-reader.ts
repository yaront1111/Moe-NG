import { resolveQualifiedDeliveryProfile, type ProductContractRevisionV2,
  type ProductContractCurrentRevisionSlotV2 } from "@moe/core";
import { DurableStoreError, type SqliteEventStore, type StoredEvent } from "@moe/store";

import { deriveProductContractCurrentRevisionSlotV2AggregateId }
  from "../product-contract/product-contract-v2-address.js";
import { resolveProductContractGate1V2 }
  from "../product-contract/product-contract-v2-gate-1-resolver.js";
import { readCurrentProductContractRevisionV2 }
  from "../product-contract/product-contract-v2-reader.js";
import {
  deriveProductContractV2WorkflowAggregateId,
  sameProductContractV2WorkflowRef,
  type ProductContractV2WorkflowHead,
} from "../product-contract/product-contract-v2-workflow-contract.js";
import { readProductContractV2WorkflowHead }
  from "../product-contract/product-contract-v2-workflow-reader.js";
import { createDeliveryProfileQualificationAuthority }
  from "./qualification-authority.js";
import { readDeliveryProfileQualificationStatusFence }
  from "./qualification-status-reader.js";
import { readDeliveryV2ResolutionMaterials } from "./material-readers.js";
import {
  DELIVERY_V2_RESOLUTION_SELECTION_COMMAND_KIND,
  DELIVERY_V2_RESOLUTION_SELECTION_EVENT_TYPE,
  DELIVERY_V2_RESOLUTION_SELECTION_LAYER,
  DELIVERY_V2_RESOLUTION_SELECTION_MAX_HISTORY,
  DELIVERY_V2_RESOLUTION_SELECTION_VERSION,
  admitDeliveryV2ResolutionSelectionConfig,
  admitDeliveryV2ResolutionSelectionReadInput,
  decodeDeliveryV2ResolutionSelection,
  deriveDeliveryV2ResolutionSelectionAggregateId,
  deriveDeliveryV2ResolutionSelectionEventId,
  encodeDeliveryV2ResolutionSelection,
  encodeDeliveryV2ResolutionSelectionRequest,
  type DeliveryV2ResolutionSelection,
  type DeliveryV2ResolutionSelectionConfig,
  type DeliveryV2ResolutionSelectionReadInput,
  type DeliveryV2ResolutionSelectionRefusal,
} from "./resolution-selection-contract.js";
import { validateDeliveryV2EventProvenance } from "./provenance.js";
import type {
  DeliveryV2QualificationStatusFence,
  DeliveryV2ResolutionMaterialRefs,
  DeliveryV2ResolutionMaterials,
} from "./contracts.js";

type ForwardedRefusal = Readonly<{ code: string; layer: string; ok: false }>;

const refuse = (
  code: DeliveryV2ResolutionSelectionRefusal["code"],
): DeliveryV2ResolutionSelectionRefusal => Object.freeze({
  code, layer: DELIVERY_V2_RESOLUTION_SELECTION_LAYER, ok: false,
});

const storageRefusal = (error: unknown): ForwardedRefusal => Object.freeze({
  code: error instanceof DurableStoreError ? error.code : "STORAGE_DEGRADED",
  layer: error instanceof DurableStoreError ? "DURABLE_STORE" : DELIVERY_V2_RESOLUTION_SELECTION_LAYER,
  ok: false,
});

export interface DeliveryV2ResolutionSelectionHistory {
  readonly events: readonly StoredEvent[];
  readonly ok: true;
  readonly selections: readonly DeliveryV2ResolutionSelection[];
}

export type DeliveryV2ResolutionSelectionHistoryResult =
  | DeliveryV2ResolutionSelectionHistory
  | DeliveryV2ResolutionSelectionRefusal
  | ForwardedRefusal;

/** Reads and authenticates the complete bounded selection lineage, oldest first. */
export function readDeliveryV2ResolutionSelectionHistory(
  store: SqliteEventStore,
  input: DeliveryV2ResolutionSelectionReadInput,
  expectedOperatorPrincipalId: string,
): DeliveryV2ResolutionSelectionHistoryResult {
  const aggregateId = deriveDeliveryV2ResolutionSelectionAggregateId(
    input.projectId, input.contractId,
  );
  const events: StoredEvent[] = [];
  let cursor = 0;
  try {
    for (;;) {
      const page = store.readAggregateEvents(
        aggregateId, cursor,
        Math.min(100, DELIVERY_V2_RESOLUTION_SELECTION_MAX_HISTORY + 1 - events.length),
      );
      events.push(...page.items);
      if (events.length > DELIVERY_V2_RESOLUTION_SELECTION_MAX_HISTORY) {
        return refuse("DELIVERY_V2_RESOLUTION_SELECTION_LIMIT_EXCEEDED");
      }
      if (!page.hasMore) break;
      const last = page.items.at(-1);
      if (last === undefined || last.aggregateSequence <= cursor) {
        return refuse("DELIVERY_V2_RESOLUTION_SELECTION_UNREADABLE");
      }
      cursor = last.aggregateSequence;
    }
  } catch (error) {
    return storageRefusal(error);
  }
  if (events.length === 0) return refuse("DELIVERY_V2_RESOLUTION_SELECTION_ABSENT");

  const selections: DeliveryV2ResolutionSelection[] = [];
  for (const [index, event] of events.entries()) {
    const generation = index + 1;
    const decoded = decodeDeliveryV2ResolutionSelection(event.payload);
    if (!decoded.ok || decoded.selection.generation !== generation
      || decoded.selection.projectId !== input.projectId
      || decoded.selection.contractId !== input.contractId
      || event.aggregateId !== aggregateId || event.aggregateSequence !== generation
      || event.domainSchemaVersion !== DELIVERY_V2_RESOLUTION_SELECTION_VERSION
      || event.eventType !== DELIVERY_V2_RESOLUTION_SELECTION_EVENT_TYPE
      || event.decisionTrace === undefined
      || event.decisionTrace.projectId !== input.projectId
      || event.decisionTrace.principalId !== expectedOperatorPrincipalId
      || event.decisionTrace.commandKind !== DELIVERY_V2_RESOLUTION_SELECTION_COMMAND_KIND) {
      return refuse("DELIVERY_V2_RESOLUTION_SELECTION_UNREADABLE");
    }
    const eventId = deriveDeliveryV2ResolutionSelectionEventId(
      input.projectId, expectedOperatorPrincipalId, event.decisionTrace.commandId,
    );
    const requestBytes = encodeDeliveryV2ResolutionSelectionRequest(
      input.projectId, input.contractId, decoded.selection.materialRefs,
    );
    const selectionBytes = encodeDeliveryV2ResolutionSelection(decoded.selection);
    if (requestBytes === undefined || !selectionBytes.ok || event.eventId !== eventId
      || !validateDeliveryV2EventProvenance(store, event, {
        aggregateId,
        commandKind: DELIVERY_V2_RESOLUTION_SELECTION_COMMAND_KIND,
        domainSchemaVersion: DELIVERY_V2_RESOLUTION_SELECTION_VERSION,
        eventId,
        eventType: DELIVERY_V2_RESOLUTION_SELECTION_EVENT_TYPE,
        expectedCommandId: event.decisionTrace.commandId,
        expectedPrincipalId: expectedOperatorPrincipalId,
        expectedProjectId: input.projectId,
        expectedVersion: index,
        payloadBytes: selectionBytes.ok ? selectionBytes.bytes : new Uint8Array(),
        requestBytes,
        resultBytes: selectionBytes.ok ? selectionBytes.bytes : new Uint8Array(),
      })) return refuse("DELIVERY_V2_RESOLUTION_SELECTION_UNREADABLE");
    selections.push(decoded.selection);
  }
  return Object.freeze({ events: Object.freeze(events), ok: true as const,
    selections: Object.freeze(selections) });
}

export interface DeliveryV2ResolutionSelectionLiveState {
  readonly catalogRevision: Exclude<ReturnType<typeof readDeliveryV2ResolutionMaterials>,
    { readonly ok: false }>["catalogRevision"];
  readonly contract: ProductContractRevisionV2;
  readonly materials: DeliveryV2ResolutionMaterials;
  readonly ok: true;
  readonly qualificationStatusFence: DeliveryV2QualificationStatusFence;
  readonly slot: ProductContractCurrentRevisionSlotV2;
  readonly workflow: ProductContractV2WorkflowHead;
}

export type DeliveryV2ResolutionSelectionLiveStateResult =
  | DeliveryV2ResolutionSelectionLiveState
  | DeliveryV2ResolutionSelectionRefusal
  | ForwardedRefusal;

/** Re-resolves every authority whose generation is fenced by a selection commit. */
export function resolveDeliveryV2ResolutionSelectionLiveState(
  store: SqliteEventStore,
  config: DeliveryV2ResolutionSelectionConfig,
  input: Readonly<{
    atEpochMs: number;
    contractId: string;
    materialRefs: DeliveryV2ResolutionMaterialRefs;
    projectId: string;
  }>,
): DeliveryV2ResolutionSelectionLiveStateResult {
  const current = readCurrentProductContractRevisionV2(store, {
    contractId: input.contractId, projectId: input.projectId,
  });
  if (!current.ok) return current;
  const ref = Object.freeze({ contractId: current.revision.contractId,
    revisionDigest: current.revision.revisionDigest, revisionId: current.revision.revisionId });
  const gate = resolveProductContractGate1V2(store, { projectId: input.projectId, ref });
  if (!gate.ok) return gate;
  const workflow = readProductContractV2WorkflowHead(store, {
    contractId: input.contractId, projectId: input.projectId,
  });
  if (!workflow.ok) return workflow;
  if (current.revision.contractId !== input.contractId
    || current.slot.projectId !== input.projectId
    || workflow.head.clarificationStatus !== "SATISFIED"
    || !sameProductContractV2WorkflowRef(workflow.head.currentRevision,
      current.slot.currentRevision)
    || !sameProductContractV2WorkflowRef(workflow.head.effectiveGateRef,
      current.slot.currentRevision)
    || workflow.head.currentSlotDigest !== current.slot.slotDigest
    || workflow.head.currentSlotGeneration !== current.slot.generation) {
    return refuse("DELIVERY_V2_RESOLUTION_SELECTION_CONTRACT_STALE");
  }

  const resolvedMaterials = readDeliveryV2ResolutionMaterials(
    store, input.materialRefs, config.materialPublishers,
  );
  if (!resolvedMaterials.ok) return resolvedMaterials;
  const qualification = resolveQualifiedDeliveryProfile(
    resolvedMaterials.materials.deliveryProfileRevision,
    resolvedMaterials.materials.deliveryProfileQualification,
    input.atEpochMs,
    createDeliveryProfileQualificationAuthority(
      store, input.projectId, config.authorityPrincipals,
    ),
  );
  if (!qualification.ok) {
    return refuse("DELIVERY_V2_RESOLUTION_SELECTION_QUALIFICATION_STALE");
  }
  const statusFence = readDeliveryProfileQualificationStatusFence(
    store, input.projectId, {
      qualificationDigest: input.materialRefs.qualification.qualificationDigest,
      qualificationId: input.materialRefs.qualification.qualificationId,
    }, config.authorityPrincipals,
  );
  if (statusFence === undefined
    || qualification.qualificationStatus.qualificationDigest !== statusFence.qualificationDigest
    || qualification.qualificationStatus.qualificationId !== statusFence.qualificationId
    || qualification.qualificationStatus.statusDigest !== statusFence.statusDigest
    || qualification.qualificationStatus.statusRef !== statusFence.statusRef) {
    return refuse("DELIVERY_V2_RESOLUTION_SELECTION_QUALIFICATION_STALE");
  }
  return Object.freeze({ catalogRevision: resolvedMaterials.catalogRevision,
    contract: current.revision, materials: resolvedMaterials.materials, ok: true as const,
    qualificationStatusFence: statusFence, slot: current.slot, workflow: workflow.head });
}

export interface DeliveryV2ResolutionSelectionDownstreamFences {
  readonly productContractSlot: Readonly<{ aggregateId: string; expectedVersion: number }>;
  readonly qualificationStatus: DeliveryV2QualificationStatusFence;
  readonly resolutionSelection: Readonly<{ aggregateId: string; expectedVersion: number }>;
  readonly workflow: Readonly<{ aggregateId: string; expectedVersion: number }>;
}

export interface DeliveryV2ResolutionSelectionReadAccepted {
  readonly catalogRevision: DeliveryV2ResolutionSelectionLiveState["catalogRevision"];
  readonly fences: DeliveryV2ResolutionSelectionDownstreamFences;
  readonly materials: DeliveryV2ResolutionMaterials;
  readonly ok: true;
  readonly selection: DeliveryV2ResolutionSelection;
}

export type DeliveryV2ResolutionSelectionReadResult =
  | DeliveryV2ResolutionSelectionReadAccepted
  | DeliveryV2ResolutionSelectionRefusal
  | ForwardedRefusal;

export function readCurrentDeliveryV2ResolutionSelection(
  store: SqliteEventStore,
  configValue: DeliveryV2ResolutionSelectionConfig,
  inputValue: DeliveryV2ResolutionSelectionReadInput,
): DeliveryV2ResolutionSelectionReadResult {
  const config = admitDeliveryV2ResolutionSelectionConfig(configValue);
  const input = admitDeliveryV2ResolutionSelectionReadInput(inputValue);
  if (config === undefined || input === undefined) {
    return refuse("DELIVERY_V2_RESOLUTION_SELECTION_INPUT_INVALID");
  }
  const history = readDeliveryV2ResolutionSelectionHistory(
    store, input, config.configuredOperatorPrincipalId,
  );
  if (!history.ok) return history;
  const selection = history.selections.at(-1);
  const event = history.events.at(-1);
  if (selection === undefined || event === undefined) {
    return refuse("DELIVERY_V2_RESOLUTION_SELECTION_UNREADABLE");
  }
  const atEpochMs = Date.parse(event.committedAt);
  if (!Number.isSafeInteger(atEpochMs) || atEpochMs < 0) {
    return refuse("DELIVERY_V2_RESOLUTION_SELECTION_UNREADABLE");
  }
  const live = resolveDeliveryV2ResolutionSelectionLiveState(store, config, {
    atEpochMs, contractId: input.contractId, materialRefs: selection.materialRefs,
    projectId: input.projectId,
  });
  if (!live.ok) {
    if (live.code === "DELIVERY_V2_RESOLUTION_SELECTION_QUALIFICATION_STALE"
      || live.code === "DELIVERY_V2_RESOLUTION_SELECTION_CONTRACT_STALE"
      || live.layer === "DURABLE_STORE" || live.code === "STORAGE_DEGRADED"
      || live.code.startsWith("DELIVERY_V2_MATERIAL_")) return live;
    return refuse("DELIVERY_V2_RESOLUTION_SELECTION_CONTRACT_STALE");
  }
  if (selection.productContract.revisionDigest !== live.contract.revisionDigest
    || selection.productContract.revisionId !== live.contract.revisionId
    || selection.productContract.revisionVersion !== live.contract.version
    || selection.productContract.slotDigest !== live.slot.slotDigest
    || selection.productContract.slotGeneration !== live.slot.generation
    || selection.productContract.workflowGeneration !== live.workflow.generation) {
    return refuse("DELIVERY_V2_RESOLUTION_SELECTION_CONTRACT_STALE");
  }
  const status = live.qualificationStatusFence;
  if (selection.qualificationStatus.qualificationDigest !== status.qualificationDigest
    || selection.qualificationStatus.qualificationId !== status.qualificationId
    || selection.qualificationStatus.statusDigest !== status.statusDigest
    || selection.qualificationStatus.statusRef !== status.statusRef) {
    return refuse("DELIVERY_V2_RESOLUTION_SELECTION_QUALIFICATION_STALE");
  }
  return Object.freeze({
    catalogRevision: live.catalogRevision,
    fences: Object.freeze({
      productContractSlot: Object.freeze({
        aggregateId: deriveProductContractCurrentRevisionSlotV2AggregateId(
          input.projectId, input.contractId,
        ), expectedVersion: live.slot.generation,
      }),
      qualificationStatus: status,
      resolutionSelection: Object.freeze({
        aggregateId: deriveDeliveryV2ResolutionSelectionAggregateId(
          input.projectId, input.contractId,
        ), expectedVersion: selection.generation,
      }),
      workflow: Object.freeze({
        aggregateId: deriveProductContractV2WorkflowAggregateId(
          input.projectId, input.contractId,
        ), expectedVersion: live.workflow.generation,
      }),
    }),
    materials: live.materials,
    ok: true as const,
    selection,
  });
}
