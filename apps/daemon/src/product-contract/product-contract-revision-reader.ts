import { createRuntimeError, type RuntimeErrorCode } from "@moe/contracts";
import {
  PRODUCT_CONTRACT_VERSION,
  decodeProductContractRevisionBytes,
  type ProductContractRefusal,
  type ProductContractRevision,
  type ProductContractRevisionRef,
} from "@moe/core";
import {
  DurableStoreError,
  type DurableStoreErrorCode,
  type SqliteEventStore,
  type StoredEvent,
} from "@moe/store";

import {
  PRODUCT_CONTRACT_REVISION_EVENT_TYPE,
  deriveProductContractRevisionAggregateId,
} from "./product-contract-revision-store.js";

const READER_LAYER = "PRODUCT_CONTRACT_REVISION_READER";
const DURABLE_STORE_LAYER = "DURABLE_STORE";

type ProductContractRevisionReaderCode =
  | "PRODUCT_CONTRACT_REVISION_ABSENT"
  | "PRODUCT_CONTRACT_REVISION_AMBIGUOUS"
  | "PRODUCT_CONTRACT_REVISION_EVENT_UNEXPECTED"
  | "PRODUCT_CONTRACT_REVISION_IDENTITY_MISMATCH"
  | "PRODUCT_CONTRACT_REVISION_SCHEMA_UNSUPPORTED";

export interface ProductContractRevisionReadInput {
  readonly projectId: string;
  readonly ref: ProductContractRevisionRef;
}

export interface ProductContractRevisionReadAccepted {
  readonly bytes: Uint8Array;
  readonly ok: true;
  readonly revision: ProductContractRevision;
}

export interface ProductContractRevisionReadRefusal {
  readonly code: DurableStoreErrorCode | ProductContractRevisionReaderCode | RuntimeErrorCode;
  readonly layer: typeof DURABLE_STORE_LAYER | typeof READER_LAYER;
  readonly ok: false;
}

export type ProductContractRevisionReadResult =
  | ProductContractRefusal
  | ProductContractRevisionReadAccepted
  | ProductContractRevisionReadRefusal;

function refuseReader(code: ProductContractRevisionReaderCode): ProductContractRevisionReadRefusal {
  return Object.freeze({ code, layer: READER_LAYER, ok: false as const });
}

function refuseStore(code: DurableStoreErrorCode): ProductContractRevisionReadRefusal {
  return Object.freeze({ code, layer: DURABLE_STORE_LAYER, ok: false as const });
}

function refuseUnexpected(): ProductContractRevisionReadRefusal {
  const error = createRuntimeError({
    code: "STORAGE_DEGRADED",
    source: { aggregate: "PROJECT", state: "DEGRADED" },
  });
  return Object.freeze({ code: error.code, layer: READER_LAYER, ok: false as const });
}

function sameIdentity(revision: ProductContractRevision, ref: ProductContractRevisionRef): boolean {
  return revision.contractId === ref.contractId
    && revision.revisionId === ref.revisionId
    && revision.revisionDigest === ref.revisionDigest;
}

export function readProductContractRevision(
  store: SqliteEventStore,
  input: ProductContractRevisionReadInput,
): ProductContractRevisionReadResult {
  const aggregateId = deriveProductContractRevisionAggregateId(
    input.projectId,
    input.ref.contractId,
    input.ref.revisionId,
  );
  let events: readonly StoredEvent[];
  try {
    events = store.readEvents(aggregateId);
  } catch (error) {
    return error instanceof DurableStoreError ? refuseStore(error.code) : refuseUnexpected();
  }
  if (events.length === 0) return refuseReader("PRODUCT_CONTRACT_REVISION_ABSENT");
  if (events.length !== 1) return refuseReader("PRODUCT_CONTRACT_REVISION_AMBIGUOUS");
  const event = events[0];
  if (event?.eventType !== PRODUCT_CONTRACT_REVISION_EVENT_TYPE) {
    return refuseReader("PRODUCT_CONTRACT_REVISION_EVENT_UNEXPECTED");
  }
  if (event.domainSchemaVersion !== PRODUCT_CONTRACT_VERSION) {
    return refuseReader("PRODUCT_CONTRACT_REVISION_SCHEMA_UNSUPPORTED");
  }
  const bytes = new Uint8Array(event.payload);
  const decoded = decodeProductContractRevisionBytes(bytes);
  if (!decoded.ok) return decoded;
  if (!sameIdentity(decoded.revision, input.ref)) {
    return refuseReader("PRODUCT_CONTRACT_REVISION_IDENTITY_MISMATCH");
  }
  return Object.freeze({ bytes, ok: true as const, revision: decoded.revision });
}
