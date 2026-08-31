import { decodeBoundedJsonBytes } from "@moe/contracts";
import { decodeProductContractCurrentRevisionSlotV2Bytes,
  decodeProductContractRevisionV2Bytes } from "@moe/core";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { PRODUCT_CONTRACT_GATE_1_EVENT_TYPE,
  deriveProductContractGate1AggregateId } from "./product-contract-gate-1-contract.js";
import { readProductContractGate1Approval }
  from "./product-contract-gate-1-reader.js";
import { deriveProductContractCurrentRevisionSlotV2AggregateId,
  deriveProductContractRevisionV2AggregateId }
  from "./product-contract-v2-address.js";
import { PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_EVENT_TYPE,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_EVENT_TYPE,
  productContractClarificationV2AggregateId }
  from "./product-contract-v2-clarification-contract.js";
import { validateProductContractClarificationV2Provenance }
  from "./product-contract-v2-clarification-provenance.js";
import { readProductContractClarificationV2Row }
  from "./product-contract-v2-clarification-row.js";
import { productContractGate1Authority } from "@moe/core";
import { PRODUCT_CONTRACT_CURRENT_SLOT_V2_EVENT_TYPE,
  PRODUCT_CONTRACT_REVISION_V2_EVENT_TYPE }
  from "./product-contract-v2-event-contract.js";
import { validateProductContractV2EventProvenance }
  from "./product-contract-v2-provenance.js";
import { sameProductContractV2WorkflowRef,
  type ProductContractV2WorkflowHead }
  from "./product-contract-v2-workflow-contract.js";

function revisionPrimary(store: SqliteEventStore,
  head: ProductContractV2WorkflowHead): StoredEvent | null {
  const ref = head.cause.revisionRef;
  if (ref === null || head.currentSlotDigest === null) return null;
  const revisionPage = store.readAggregateEvents(deriveProductContractRevisionV2AggregateId(
    head.projectId, head.contractId, ref.revisionId,
  ), 0, 2);
  const revisionEvent = revisionPage.items[0];
  if (revisionPage.hasMore || revisionPage.items.length !== 1 || revisionEvent === undefined
    || revisionEvent.eventType !== PRODUCT_CONTRACT_REVISION_V2_EVENT_TYPE) return null;
  const revision = decodeProductContractRevisionV2Bytes(revisionEvent.payload);
  if (!revision.ok || !sameProductContractV2WorkflowRef(revision.revision, ref)) return null;
  const slotPage = store.readAggregateEvents(
    deriveProductContractCurrentRevisionSlotV2AggregateId(head.projectId, head.contractId),
    head.currentSlotGeneration - 1, 1,
  );
  const slotEvent = slotPage.items[0];
  if (slotEvent === undefined || slotEvent.aggregateSequence !== head.currentSlotGeneration
    || slotEvent.eventType !== PRODUCT_CONTRACT_CURRENT_SLOT_V2_EVENT_TYPE) return null;
  const slot = decodeProductContractCurrentRevisionSlotV2Bytes(slotEvent.payload,
    revision.revision);
  if (!slot.ok || slot.slot.slotDigest !== head.currentSlotDigest
    || slot.slot.generation !== head.currentSlotGeneration
    || !sameProductContractV2WorkflowRef(slot.slot.currentRevision, ref)) return null;
  const provenance = validateProductContractV2EventProvenance(store, {
    contractId: head.contractId, projectId: head.projectId, revisionEvent,
    revisionId: ref.revisionId, slotEvent,
  });
  return provenance.ok ? revisionEvent : null;
}
function clarificationPrimary(store: SqliteEventStore,
  head: ProductContractV2WorkflowHead): StoredEvent | null {
  const clarificationId = head.cause.clarificationId;
  if (clarificationId === null) return null;
  const aggregateId = productContractClarificationV2AggregateId(
    head.projectId, head.contractId, clarificationId,
  );
  const page = store.readAggregateEvents(aggregateId, 0, 3);
  const latest = page.items.at(-1);
  if (page.hasMore || latest === undefined) return null;
  const decoded = decodeBoundedJsonBytes(latest.payload);
  const row = decoded.ok ? readProductContractClarificationV2Row(decoded.value) : null;
  if (row === null || row.goalRef !== head.goalRef || row.clarificationId !== clarificationId
    || validateProductContractClarificationV2Provenance(
      store, head.projectId, aggregateId, row,
    ).kind !== "VALID") return null;
  const action = head.cause.kind === "ASK" ? page.items[0] : page.items[1];
  const eventType = head.cause.kind === "ASK"
    ? PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_EVENT_TYPE
    : PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_EVENT_TYPE;
  return action !== undefined && action.eventType === eventType ? action : null;
}
function gatePrimary(store: SqliteEventStore,
  head: ProductContractV2WorkflowHead): StoredEvent | null {
  const ref = head.cause.revisionRef;
  if (ref === null) return null;
  const approval = readProductContractGate1Approval(store, {
    projectId: head.projectId, ref,
  });
  if (!approval.ok) return null;
  const aggregateId = deriveProductContractGate1AggregateId(
    productContractGate1Authority(ref).workRef,
  );
  const page = store.readAggregateEvents(aggregateId, 0, 2);
  const event = page.items[0];
  return !page.hasMore && page.items.length === 1 && event !== undefined
    && event.eventType === PRODUCT_CONTRACT_GATE_1_EVENT_TYPE ? event : null;
}

export function readProductContractV2WorkflowPrimary(
  store: SqliteEventStore, head: ProductContractV2WorkflowHead,
): StoredEvent | null {
  if (head.cause.kind === "REVISION") return revisionPrimary(store, head);
  if (head.cause.kind === "ASK" || head.cause.kind === "ANSWER") {
    return clarificationPrimary(store, head);
  }
  return gatePrimary(store, head);
}
