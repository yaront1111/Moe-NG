import {
  PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_VERSION,
  PRODUCT_CONTRACT_V2_VERSION,
  advanceProductContractCurrentRevisionSlotV2,
  createProductContractCurrentRevisionSlotV2,
  createProductContractRevisionV2,
  decodeProductContractCurrentRevisionSlotV2Bytes,
  encodeProductContractCurrentRevisionSlotV2,
  encodeProductContractRevisionV2,
  type ProductContractCurrentRevisionSlotV2,
  type ProductContractRevisionV2,
  type ProductContractV2Refusal,
} from "@moe/core";
import { DurableStoreError, identifyReplayRequest, type CommandDecisionKey,
  type DurableStoreErrorCode, type SqliteEventStore }
  from "@moe/store";

import {
  deriveProductContractCurrentRevisionSlotV2AggregateId,
  deriveProductContractRevisionV2AggregateId,
  deriveProductContractRevisionV2CommandId,
  PRODUCT_CONTRACT_REVISION_V2_COMMAND_KIND,
} from "./product-contract-v2-address.js";
import {
  PRODUCT_CONTRACT_CURRENT_SLOT_V2_EVENT_TYPE,
  PRODUCT_CONTRACT_REVISION_V2_EVENT_TYPE,
  readCurrentProductContractRevisionV2,
  type ProductContractV2ReaderRefusal,
} from "./product-contract-v2-reader.js";
import { validateProductContractV2EventProvenance }
  from "./product-contract-v2-provenance.js";

export {
  deriveProductContractCurrentRevisionSlotV2AggregateId,
  deriveProductContractRevisionV2AggregateId,
} from "./product-contract-v2-address.js";

const WRITER_LAYER = "PRODUCT_CONTRACT_V2_REVISION_STORE" as const;

export interface ProductContractRevisionV2CommitInput {
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly draft: unknown;
  readonly principalId: string;
  readonly projectId: string;
}
export interface ProductContractRevisionV2CommitAccepted {
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly ok: true;
  readonly revision: ProductContractRevisionV2;
  readonly slot: ProductContractCurrentRevisionSlotV2;
}
export interface ProductContractRevisionV2StoreRefusal {
  readonly code: DurableStoreErrorCode | "STORAGE_DEGRADED";
  readonly layer: "DURABLE_STORE" | typeof WRITER_LAYER;
  readonly ok: false;
}
export type ProductContractRevisionV2CommitResult =
  | ProductContractRevisionV2CommitAccepted
  | ProductContractRevisionV2StoreRefusal
  | ProductContractV2ReaderRefusal
  | ProductContractV2Refusal;

function storeRefusal(error: unknown): ProductContractRevisionV2StoreRefusal {
  return Object.freeze({
    code: error instanceof DurableStoreError ? error.code : "STORAGE_DEGRADED",
    layer: error instanceof DurableStoreError ? "DURABLE_STORE" : WRITER_LAYER,
    ok: false as const,
  });
}
function durableRefusal(code: DurableStoreErrorCode): ProductContractRevisionV2StoreRefusal {
  return Object.freeze({ code, layer: "DURABLE_STORE", ok: false as const });
}
function sameCurrent(
  slot: ProductContractCurrentRevisionSlotV2,
  revision: ProductContractRevisionV2,
): boolean {
  return slot.currentRevision.contractId === revision.contractId
    && slot.currentRevision.revisionId === revision.revisionId
    && slot.currentRevision.revisionDigest === revision.revisionDigest
    && slot.currentRevision.version === revision.version;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

/** Replays the immutable command result, not a slot re-derived from newer live state. */
function historicalReplay(
  store: SqliteEventStore,
  key: CommandDecisionKey,
  revision: ProductContractRevisionV2,
  revisionBytes: Uint8Array,
): ProductContractRevisionV2CommitAccepted | ProductContractRevisionV2StoreRefusal
  | ProductContractV2ReaderRefusal | null {
  try {
    const prior = store.getCommandDecision(key);
    if (prior === null) return null;
    const revisionAggregateId = deriveProductContractRevisionV2AggregateId(
      key.projectId, revision.contractId, revision.revisionId,
    );
    const commandId = key.commandId;
    if (prior.commandKind !== PRODUCT_CONTRACT_REVISION_V2_COMMAND_KIND
      || prior.effectDisposition !== "EFFECTS_COMMITTED"
      || prior.targetAggregateId !== revisionAggregateId || prior.expectedVersion !== 0
      || prior.replayRequestSha256 !== identifyReplayRequest(prior, revisionBytes)
      || prior.businessEventIds.length !== 1
      || prior.businessEventIds[0] !== `${commandId}-revision`) {
      return durableRefusal("COMMAND_ID_CONFLICT");
    }
    const decodedSlot = decodeProductContractCurrentRevisionSlotV2Bytes(
      prior.resultBytes, revision,
    );
    if (!decodedSlot.ok || decodedSlot.slot.projectId !== key.projectId
      || !sameCurrent(decodedSlot.slot, revision)) return durableRefusal("STORE_CORRUPT");
    const revisionPage = store.readAggregateEvents(revisionAggregateId, 0, 2);
    const revisionEvent = revisionPage.items[0];
    const slotPage = store.readAggregateEvents(
      deriveProductContractCurrentRevisionSlotV2AggregateId(key.projectId, revision.contractId),
      decodedSlot.slot.generation - 1, 1,
    );
    const slotEvent = slotPage.items[0];
    if (revisionPage.hasMore || revisionPage.items.length !== 1 || revisionEvent === undefined
      || revisionEvent.eventType !== PRODUCT_CONTRACT_REVISION_V2_EVENT_TYPE
      || revisionEvent.domainSchemaVersion !== PRODUCT_CONTRACT_V2_VERSION
      || !sameBytes(revisionEvent.payload, revisionBytes)
      || slotEvent === undefined || slotEvent.aggregateSequence !== decodedSlot.slot.generation
      || slotEvent.eventId !== `${commandId}-slot`
      || slotEvent.eventType !== PRODUCT_CONTRACT_CURRENT_SLOT_V2_EVENT_TYPE
      || slotEvent.domainSchemaVersion !== PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_VERSION
      || !sameBytes(slotEvent.payload, prior.resultBytes)) return durableRefusal("STORE_CORRUPT");
    const provenance = validateProductContractV2EventProvenance(store, {
      contractId: revision.contractId, projectId: key.projectId, revisionEvent,
      revisionId: revision.revisionId, slotEvent,
    });
    if (!provenance.ok) return provenance;
    return Object.freeze({ disposition: "REPLAYED", ok: true as const,
      revision, slot: decodedSlot.slot });
  } catch (error) { return storeRefusal(error); }
}

export function commitProductContractRevisionV2(
  store: SqliteEventStore,
  input: ProductContractRevisionV2CommitInput,
): ProductContractRevisionV2CommitResult {
  const created = createProductContractRevisionV2(input.draft);
  if (!created.ok) return created;
  const revision = created.revision;
  const revisionBytes = encodeProductContractRevisionV2(revision);
  if (!revisionBytes.ok) return revisionBytes;
  const commandId = deriveProductContractRevisionV2CommandId(
    input.projectId, revision.contractId, revision.revisionId,
  );
  const key = { commandId, principalId: input.principalId, projectId: input.projectId };
  const replay = historicalReplay(store, key, revision, revisionBytes.bytes);
  if (replay !== null) return replay;
  const current = readCurrentProductContractRevisionV2(store, {
    contractId: revision.contractId, projectId: input.projectId,
  });
  let slot: ProductContractCurrentRevisionSlotV2;
  if (!current.ok) {
    if (current.code !== "PRODUCT_CONTRACT_V2_CURRENT_SLOT_ABSENT"
      || current.layer !== "PRODUCT_CONTRACT_V2_REVISION_READER") return current;
    const initial = createProductContractCurrentRevisionSlotV2(input.projectId, revision);
    if (!initial.ok) return initial;
    slot = initial.slot;
  } else if (sameCurrent(current.slot, revision)) {
    slot = current.slot;
  } else {
    const advanced = advanceProductContractCurrentRevisionSlotV2(
      current.slot, current.revision, revision,
    );
    if (!advanced.ok) return advanced;
    slot = advanced.slot;
  }
  const slotBytes = encodeProductContractCurrentRevisionSlotV2(slot);
  if (!slotBytes.ok) return slotBytes;
  try {
    const response = store.commitExpectedVersionDecisionLegs({
      commandKind: PRODUCT_CONTRACT_REVISION_V2_COMMAND_KIND,
      committedResultBytes: slotBytes.bytes,
      correlationId: input.correlationId,
      decidedAt: input.decidedAt,
      key,
      legs: [{
        aggregateId: deriveProductContractRevisionV2AggregateId(
          input.projectId, revision.contractId, revision.revisionId,
        ),
        events: [{ domainSchemaVersion: PRODUCT_CONTRACT_V2_VERSION,
          eventId: `${commandId}-revision`, eventType: PRODUCT_CONTRACT_REVISION_V2_EVENT_TYPE,
          payload: revisionBytes.bytes }],
        expectedVersion: 0,
      }, {
        aggregateId: deriveProductContractCurrentRevisionSlotV2AggregateId(
          input.projectId, revision.contractId,
        ),
        events: [{ domainSchemaVersion: PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_VERSION,
          eventId: `${commandId}-slot`, eventType: PRODUCT_CONTRACT_CURRENT_SLOT_V2_EVENT_TYPE,
          payload: slotBytes.bytes }],
        expectedVersion: slot.generation - 1,
      }],
      requestBytes: revisionBytes.bytes,
    });
    if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
      return Object.freeze({ code: response.decision.resultCode,
        layer: "DURABLE_STORE" as const, ok: false as const });
    }
    return Object.freeze({ disposition: response.disposition, ok: true as const, revision, slot });
  } catch (error) { return storeRefusal(error); }
}
