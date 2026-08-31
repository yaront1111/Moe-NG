import { decodeBoundedJsonBytes } from "@moe/contracts";
import {
  PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_VERSION,
  PRODUCT_CONTRACT_V2_LIMITS,
  PRODUCT_CONTRACT_V2_VERSION,
  decodeProductContractCurrentRevisionSlotV2Bytes,
  decodeProductContractRevisionV2Bytes,
  type ProductContractCurrentRevisionSlotV2,
  type ProductContractRevisionV2,
  type ProductContractV2Refusal,
} from "@moe/core";
import { DurableStoreError, type DurableStoreErrorCode, type SqliteEventStore,
  type StoredEvent } from "@moe/store";

import {
  deriveProductContractCurrentRevisionSlotV2AggregateId,
  deriveProductContractRevisionV2AggregateId,
} from "./product-contract-v2-address.js";
import {
  PRODUCT_CONTRACT_V2_REVISION_READER_LAYER,
  validateProductContractV2EventProvenance,
  type ProductContractV2ProvenanceCode,
} from "./product-contract-v2-provenance.js";

export const PRODUCT_CONTRACT_REVISION_V2_EVENT_TYPE =
  "ProductContractRevisionV2Committed" as const;
export const PRODUCT_CONTRACT_CURRENT_SLOT_V2_EVENT_TYPE =
  "ProductContractCurrentRevisionSlotV2Advanced" as const;
export { PRODUCT_CONTRACT_V2_REVISION_READER_LAYER }
  from "./product-contract-v2-provenance.js";

export type ProductContractV2ReaderCode =
  | "PRODUCT_CONTRACT_V2_CURRENT_SLOT_ABSENT"
  | "PRODUCT_CONTRACT_V2_CURRENT_SLOT_UNREADABLE"
  | "PRODUCT_CONTRACT_V2_REVISION_ABSENT"
  | "PRODUCT_CONTRACT_V2_REVISION_UNREADABLE"
  | "PRODUCT_CONTRACT_V2_REVISION_IDENTITY_MISMATCH"
  | ProductContractV2ProvenanceCode;

export interface ProductContractV2ReaderRefusal {
  readonly code: DurableStoreErrorCode | ProductContractV2ReaderCode | "STORAGE_DEGRADED";
  readonly layer: "DURABLE_STORE" | typeof PRODUCT_CONTRACT_V2_REVISION_READER_LAYER;
  readonly ok: false;
}
export type ProductContractV2CurrentReadResult =
  | Readonly<{ ok: true; revision: ProductContractRevisionV2;
    slot: ProductContractCurrentRevisionSlotV2 }>
  | ProductContractV2Refusal
  | ProductContractV2ReaderRefusal;

const HEX64 = /^[0-9a-f]{64}$/u;
const REF_KEYS = Object.freeze(["contractId", "revisionDigest", "revisionId", "version"]);

function refusal(code: ProductContractV2ReaderCode): ProductContractV2ReaderRefusal {
  return Object.freeze({ code, layer: PRODUCT_CONTRACT_V2_REVISION_READER_LAYER, ok: false });
}
type EventRead = Readonly<{ events: readonly StoredEvent[]; ok: true }>
  | ProductContractV2ReaderRefusal;

const READ_PAGE_SIZE = 100;

function readEvents(
  store: SqliteEventStore, aggregateId: string, maximum: number,
): EventRead {
  try {
    const events: StoredEvent[] = [];
    let cursor = 0;
    while (true) {
      const remaining = maximum + 1 - events.length;
      const page = store.readAggregateEvents(
        aggregateId, cursor, Math.min(READ_PAGE_SIZE, remaining),
      );
      events.push(...page.items);
      if (events.length > maximum) {
        return Object.freeze({ code: "STORE_LIMIT_EXCEEDED" as const,
          layer: "DURABLE_STORE" as const, ok: false as const });
      }
      if (!page.hasMore) return Object.freeze({ events: Object.freeze(events), ok: true as const });
      const last = page.items.at(-1);
      if (last === undefined || last.aggregateSequence <= cursor) {
        return Object.freeze({ code: "STORAGE_DEGRADED" as const,
          layer: PRODUCT_CONTRACT_V2_REVISION_READER_LAYER, ok: false as const });
      }
      cursor = last.aggregateSequence;
    }
  } catch (error) {
    return Object.freeze({
      code: error instanceof DurableStoreError ? error.code : "STORAGE_DEGRADED",
      layer: error instanceof DurableStoreError ? "DURABLE_STORE" :
        PRODUCT_CONTRACT_V2_REVISION_READER_LAYER,
      ok: false as const,
    });
  }
}
function exact(value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && Buffer.byteLength(value, "utf8") <= 512;
}
function currentHint(bytes: Uint8Array): Readonly<{
  contractId: string; revisionDigest: string; revisionId: string;
}> | null {
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok || typeof decoded.value !== "object" || decoded.value === null
    || Array.isArray(decoded.value)) return null;
  const current = (decoded.value as Readonly<Record<string, unknown>>)["currentRevision"];
  if (!exact(current, REF_KEYS) || !boundedId(current["contractId"])
    || !boundedId(current["revisionId"]) || typeof current["revisionDigest"] !== "string"
    || !HEX64.test(current["revisionDigest"])
    || current["version"] !== PRODUCT_CONTRACT_V2_VERSION) return null;
  return Object.freeze({ contractId: current["contractId"],
    revisionDigest: current["revisionDigest"], revisionId: current["revisionId"] });
}

export function readCurrentProductContractRevisionV2(
  store: SqliteEventStore,
  input: Readonly<{ contractId: string; projectId: string }>,
): ProductContractV2CurrentReadResult {
  const slotEvents = readEvents(store,
    deriveProductContractCurrentRevisionSlotV2AggregateId(input.projectId, input.contractId),
    PRODUCT_CONTRACT_V2_LIMITS.maxRevisionHistory + 1);
  if (!slotEvents.ok) return slotEvents;
  if (slotEvents.events.length === 0) return refusal("PRODUCT_CONTRACT_V2_CURRENT_SLOT_ABSENT");
  const slotEvent = slotEvents.events.at(-1);
  if (slotEvent === undefined || slotEvent.aggregateSequence !== slotEvents.events.length
    || slotEvent.eventType !== PRODUCT_CONTRACT_CURRENT_SLOT_V2_EVENT_TYPE
    || slotEvent.domainSchemaVersion !== PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_VERSION) {
    return refusal("PRODUCT_CONTRACT_V2_CURRENT_SLOT_UNREADABLE");
  }
  const hint = currentHint(slotEvent.payload);
  if (hint === null || hint.contractId !== input.contractId) {
    return refusal("PRODUCT_CONTRACT_V2_CURRENT_SLOT_UNREADABLE");
  }
  const revisionEvents = readEvents(store, deriveProductContractRevisionV2AggregateId(
    input.projectId, hint.contractId, hint.revisionId,
  ), 1);
  if (!revisionEvents.ok) return revisionEvents;
  if (revisionEvents.events.length === 0) return refusal("PRODUCT_CONTRACT_V2_REVISION_ABSENT");
  const revisionEvent = revisionEvents.events[0];
  if (revisionEvents.events.length !== 1 || revisionEvent === undefined
    || revisionEvent.aggregateSequence !== 1
    || revisionEvent.eventType !== PRODUCT_CONTRACT_REVISION_V2_EVENT_TYPE
    || revisionEvent.domainSchemaVersion !== PRODUCT_CONTRACT_V2_VERSION) {
    return refusal("PRODUCT_CONTRACT_V2_REVISION_UNREADABLE");
  }
  const revision = decodeProductContractRevisionV2Bytes(revisionEvent.payload);
  if (!revision.ok) return revision;
  if (revision.revision.contractId !== hint.contractId
    || revision.revision.revisionId !== hint.revisionId
    || revision.revision.revisionDigest !== hint.revisionDigest) {
    return refusal("PRODUCT_CONTRACT_V2_REVISION_IDENTITY_MISMATCH");
  }
  const slot = decodeProductContractCurrentRevisionSlotV2Bytes(
    slotEvent.payload, revision.revision,
  );
  if (!slot.ok) return slot;
  if (slot.slot.projectId !== input.projectId || slot.slot.contractId !== input.contractId
    || slot.slot.generation !== slotEvents.events.length) {
    return refusal("PRODUCT_CONTRACT_V2_CURRENT_SLOT_UNREADABLE");
  }
  const provenance = validateProductContractV2EventProvenance(store, {
    contractId: input.contractId, projectId: input.projectId, revisionEvent,
    revisionId: revision.revision.revisionId, slotEvent,
  });
  if (!provenance.ok) return provenance;
  return Object.freeze({ ok: true as const, revision: revision.revision, slot: slot.slot });
}
