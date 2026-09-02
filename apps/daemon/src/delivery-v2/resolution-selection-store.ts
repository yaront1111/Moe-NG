import { identifyCorrelation, identifyReplayRequest, DurableStoreError,
  type CommandDecisionKey, type SqliteEventStore } from "@moe/store";

import { deriveProductContractCurrentRevisionSlotV2AggregateId }
  from "../product-contract/product-contract-v2-address.js";
import { deriveProductContractV2WorkflowAggregateId }
  from "../product-contract/product-contract-v2-workflow-contract.js";
import {
  DELIVERY_V2_RESOLUTION_SELECTION_COMMAND_KIND,
  DELIVERY_V2_RESOLUTION_SELECTION_EVENT_TYPE,
  DELIVERY_V2_RESOLUTION_SELECTION_LAYER,
  DELIVERY_V2_RESOLUTION_SELECTION_MAX_HISTORY,
  DELIVERY_V2_RESOLUTION_SELECTION_VERSION,
  admitDeliveryV2ResolutionSelectionCommitInput,
  admitDeliveryV2ResolutionSelectionConfig,
  createDeliveryV2ResolutionSelection,
  decodeDeliveryV2ResolutionSelection,
  deriveDeliveryV2ResolutionSelectionAggregateId,
  deriveDeliveryV2ResolutionSelectionEventId,
  encodeDeliveryV2ResolutionSelection,
  encodeDeliveryV2ResolutionSelectionRequest,
  type DeliveryV2ResolutionSelection,
  type DeliveryV2ResolutionSelectionCommitInput,
  type DeliveryV2ResolutionSelectionConfig,
  type DeliveryV2ResolutionSelectionRefusal,
} from "./resolution-selection-contract.js";
import {
  readDeliveryV2ResolutionSelectionHistory,
  resolveDeliveryV2ResolutionSelectionLiveState,
} from "./resolution-selection-reader.js";
import {
  validateDeliveryV2DecisionDisposition,
  validateDeliveryV2EventProvenance,
} from "./provenance.js";

export {
  DELIVERY_V2_RESOLUTION_SELECTION_COMMAND_KIND,
  DELIVERY_V2_RESOLUTION_SELECTION_EVENT_TYPE,
  deriveDeliveryV2ResolutionSelectionAggregateId,
  deriveDeliveryV2ResolutionSelectionEventId,
} from "./resolution-selection-contract.js";
export type {
  DeliveryV2ResolutionSelectionCommitInput,
  DeliveryV2ResolutionSelectionConfig,
} from "./resolution-selection-contract.js";

type ForwardedRefusal = Readonly<{ code: string; layer: string; ok: false }>;

export interface DeliveryV2ResolutionSelectionCommitAccepted {
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly ok: true;
  readonly selection: DeliveryV2ResolutionSelection;
}

export type DeliveryV2ResolutionSelectionCommitResult =
  | DeliveryV2ResolutionSelectionCommitAccepted
  | DeliveryV2ResolutionSelectionRefusal
  | ForwardedRefusal;

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

const durableRefusal = (code: string): ForwardedRefusal => Object.freeze({
  code, layer: "DURABLE_STORE", ok: false,
});

function historicalReplay(
  store: SqliteEventStore,
  key: CommandDecisionKey,
  contractId: string,
  requestBytes: Uint8Array,
): DeliveryV2ResolutionSelectionCommitResult | null {
  try {
    const prior = store.getCommandDecision(key);
    if (prior === null) return null;
    const aggregateId = deriveDeliveryV2ResolutionSelectionAggregateId(
      key.projectId, contractId,
    );
    if (prior.commandKind !== DELIVERY_V2_RESOLUTION_SELECTION_COMMAND_KIND
      || prior.effectDisposition !== "EFFECTS_COMMITTED"
      || prior.targetAggregateId !== aggregateId
      || prior.replayRequestSha256 !== identifyReplayRequest(prior, requestBytes)) {
      return durableRefusal("COMMAND_ID_CONFLICT");
    }
    const decoded = decodeDeliveryV2ResolutionSelection(prior.resultBytes);
    if (!decoded.ok || decoded.selection.projectId !== key.projectId
      || decoded.selection.contractId !== contractId
      || prior.expectedVersion !== decoded.selection.generation - 1) {
      return refuse("DELIVERY_V2_RESOLUTION_SELECTION_UNREADABLE");
    }
    const eventId = deriveDeliveryV2ResolutionSelectionEventId(
      key.projectId, key.principalId, key.commandId,
    );
    const page = store.readAggregateEvents(
      aggregateId, decoded.selection.generation - 1, 1,
    );
    const event = page.items[0];
    if (page.items.length !== 1 || event === undefined
      || event.aggregateSequence !== decoded.selection.generation
      || !validateDeliveryV2EventProvenance(store, event, {
        aggregateId,
        commandKind: DELIVERY_V2_RESOLUTION_SELECTION_COMMAND_KIND,
        domainSchemaVersion: DELIVERY_V2_RESOLUTION_SELECTION_VERSION,
        eventId,
        eventType: DELIVERY_V2_RESOLUTION_SELECTION_EVENT_TYPE,
        expectedCommandId: key.commandId,
        expectedPrincipalId: key.principalId,
        expectedProjectId: key.projectId,
        expectedVersion: decoded.selection.generation - 1,
        payloadBytes: prior.resultBytes,
        requestBytes,
        resultBytes: prior.resultBytes,
      })) return refuse("DELIVERY_V2_RESOLUTION_SELECTION_UNREADABLE");
    return Object.freeze({ disposition: "REPLAYED" as const, ok: true as const,
      selection: decoded.selection });
  } catch (error) {
    return storageRefusal(error);
  }
}

/**
 * Commits one current resolution selection and the three authorities that made it selectable
 * as a single expected-version decision. The request carries no generation, contract revision,
 * workflow generation, qualification status, actor payload, or clock payload; those are read
 * and sealed by the daemon immediately before the atomic commit.
 */
export function commitDeliveryV2ResolutionSelection(
  store: SqliteEventStore,
  configValue: DeliveryV2ResolutionSelectionConfig,
  inputValue: DeliveryV2ResolutionSelectionCommitInput,
): DeliveryV2ResolutionSelectionCommitResult {
  const config = admitDeliveryV2ResolutionSelectionConfig(configValue);
  const input = admitDeliveryV2ResolutionSelectionCommitInput(inputValue);
  if (config === undefined || input === undefined
    || input.principalId !== config.configuredOperatorPrincipalId) {
    return refuse("DELIVERY_V2_RESOLUTION_SELECTION_INPUT_INVALID");
  }
  const requestBytes = encodeDeliveryV2ResolutionSelectionRequest(
    input.projectId, input.contractId, input.materialRefs,
  );
  if (requestBytes === undefined) {
    return refuse("DELIVERY_V2_RESOLUTION_SELECTION_INPUT_INVALID");
  }
  const key = Object.freeze({ commandId: input.commandId,
    principalId: config.configuredOperatorPrincipalId, projectId: input.projectId });
  const replay = historicalReplay(store, key, input.contractId, requestBytes);
  if (replay !== null) return replay;

  const history = readDeliveryV2ResolutionSelectionHistory(store, {
    contractId: input.contractId, projectId: input.projectId,
  }, config.configuredOperatorPrincipalId);
  let currentGeneration = 0;
  if (!history.ok) {
    if (history.code !== "DELIVERY_V2_RESOLUTION_SELECTION_ABSENT"
      || history.layer !== DELIVERY_V2_RESOLUTION_SELECTION_LAYER) return history;
  } else {
    currentGeneration = history.selections.length;
  }
  if (currentGeneration >= DELIVERY_V2_RESOLUTION_SELECTION_MAX_HISTORY) {
    return refuse("DELIVERY_V2_RESOLUTION_SELECTION_LIMIT_EXCEEDED");
  }

  const atEpochMs = Date.parse(input.decidedAt);
  if (!Number.isSafeInteger(atEpochMs) || atEpochMs < 0) {
    return refuse("DELIVERY_V2_RESOLUTION_SELECTION_INPUT_INVALID");
  }
  const live = resolveDeliveryV2ResolutionSelectionLiveState(store, config, {
    atEpochMs, contractId: input.contractId, materialRefs: input.materialRefs,
    projectId: input.projectId,
  });
  if (!live.ok) return live;
  const created = createDeliveryV2ResolutionSelection({
    contractId: input.contractId,
    generation: currentGeneration + 1,
    materialRefs: input.materialRefs,
    productContract: {
      revisionDigest: live.contract.revisionDigest,
      revisionId: live.contract.revisionId,
      revisionVersion: live.contract.version,
      slotDigest: live.slot.slotDigest,
      slotGeneration: live.slot.generation,
      workflowGeneration: live.workflow.generation,
    },
    projectId: input.projectId,
    qualificationStatus: {
      qualificationDigest: live.qualificationStatusFence.qualificationDigest,
      qualificationId: live.qualificationStatusFence.qualificationId,
      statusDigest: live.qualificationStatusFence.statusDigest,
      statusRef: live.qualificationStatusFence.statusRef,
    },
  });
  if (!created.ok) return created;
  const encoded = encodeDeliveryV2ResolutionSelection(created.selection);
  if (!encoded.ok) return encoded;

  const aggregateId = deriveDeliveryV2ResolutionSelectionAggregateId(
    input.projectId, input.contractId,
  );
  const eventId = deriveDeliveryV2ResolutionSelectionEventId(
    input.projectId, config.configuredOperatorPrincipalId, input.commandId,
  );
  try {
    const response = store.commitExpectedVersionDecisionLegs({
      commandKind: DELIVERY_V2_RESOLUTION_SELECTION_COMMAND_KIND,
      committedResultBytes: encoded.bytes,
      correlationId: input.correlationId,
      decidedAt: input.decidedAt,
      key,
      legs: [
        {
          aggregateId,
          events: [{
            domainSchemaVersion: DELIVERY_V2_RESOLUTION_SELECTION_VERSION,
            eventId,
            eventType: DELIVERY_V2_RESOLUTION_SELECTION_EVENT_TYPE,
            payload: encoded.bytes,
          }],
          expectedVersion: currentGeneration,
        },
        {
          aggregateId: deriveProductContractCurrentRevisionSlotV2AggregateId(
            input.projectId, input.contractId,
          ),
          events: [],
          expectedVersion: live.slot.generation,
        },
        {
          aggregateId: deriveProductContractV2WorkflowAggregateId(
            input.projectId, input.contractId,
          ),
          events: [],
          expectedVersion: live.workflow.generation,
        },
        {
          aggregateId: live.qualificationStatusFence.aggregateId,
          events: [],
          expectedVersion: live.qualificationStatusFence.expectedVersion,
        },
      ],
      requestBytes,
    });
    if (!validateDeliveryV2DecisionDisposition(response)) {
      return refuse("DELIVERY_V2_RESOLUTION_SELECTION_UNREADABLE");
    }
    if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
      return durableRefusal(response.decision.resultCode);
    }
    if (response.disposition === "REPLAYED") {
      return historicalReplay(store, key, input.contractId, requestBytes)
        ?? refuse("DELIVERY_V2_RESOLUTION_SELECTION_UNREADABLE");
    }
    if (response.decision.correlationSha256 !== identifyCorrelation(input.correlationId)
      || response.decision.decidedAt !== input.decidedAt) {
      return refuse("DELIVERY_V2_RESOLUTION_SELECTION_UNREADABLE");
    }
    const page = store.readAggregateEvents(aggregateId, currentGeneration, 1);
    const event = page.items[0];
    if (page.items.length !== 1 || event === undefined
      || !validateDeliveryV2EventProvenance(store, event, {
        aggregateId,
        commandKind: DELIVERY_V2_RESOLUTION_SELECTION_COMMAND_KIND,
        domainSchemaVersion: DELIVERY_V2_RESOLUTION_SELECTION_VERSION,
        eventId,
        eventType: DELIVERY_V2_RESOLUTION_SELECTION_EVENT_TYPE,
        expectedCommandId: input.commandId,
        expectedPrincipalId: config.configuredOperatorPrincipalId,
        expectedProjectId: input.projectId,
        expectedVersion: currentGeneration,
        payloadBytes: encoded.bytes,
        requestBytes,
        resultBytes: encoded.bytes,
      })) return refuse("DELIVERY_V2_RESOLUTION_SELECTION_UNREADABLE");
    return Object.freeze({ disposition: "DECIDED" as const, ok: true as const,
      selection: created.selection });
  } catch (error) {
    return storageRefusal(error);
  }
}
