import { createHash } from "node:crypto";

import { createRuntimeError, type RuntimeErrorCode } from "@moe/contracts";
import {
  PRODUCT_CONTRACT_VERSION,
  createProductContractRevision,
  deriveProductContractRevisionDigest,
  encodeProductContractRevision,
  type ProductContractRefusal,
  type ProductContractRevision,
  type ProductContractRevisionRef,
} from "@moe/core";
import {
  DurableStoreError,
  type DurableStoreErrorCode,
  type SqliteEventStore,
} from "@moe/store";

const ADDRESS_DOMAIN = "moe-product-contract-revision-address/1";
const WRITER_LAYER = "PRODUCT_CONTRACT_REVISION_STORE";
const DURABLE_STORE_LAYER = "DURABLE_STORE";
const COMMAND_KIND = "product-contract.revision.commit";

export const PRODUCT_CONTRACT_REVISION_EVENT_TYPE = "ProductContractRevisionCommitted";

export interface ProductContractRevisionCommitInput {
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly draft: unknown;
  readonly principalId: string;
  readonly projectId: string;
}

export interface ProductContractRevisionCommitAccepted {
  readonly bytes: Uint8Array;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly ok: true;
  readonly ref: ProductContractRevisionRef;
  readonly revision: ProductContractRevision;
}

export interface ProductContractRevisionStoreRefusal {
  readonly code: DurableStoreErrorCode | RuntimeErrorCode;
  readonly layer: typeof DURABLE_STORE_LAYER | typeof WRITER_LAYER;
  readonly ok: false;
}

export type ProductContractRevisionCommitResult =
  | ProductContractRefusal
  | ProductContractRevisionCommitAccepted
  | ProductContractRevisionStoreRefusal;

function addressOf(projectId: string, contractId: string, revisionId: string): string {
  const hash = createHash("sha256").update(ADDRESS_DOMAIN, "utf8");
  for (const part of [projectId, contractId, revisionId]) {
    hash.update(Uint8Array.of(0)).update(part, "utf8");
  }
  return hash.digest("hex");
}

export function deriveProductContractRevisionAggregateId(
  projectId: string,
  contractId: string,
  revisionId: string,
): string {
  return `product-contract-revision:${addressOf(projectId, contractId, revisionId)}`;
}

function refuseStore(code: DurableStoreErrorCode): ProductContractRevisionStoreRefusal {
  return Object.freeze({ code, layer: DURABLE_STORE_LAYER, ok: false as const });
}

function refuseUnexpected(): ProductContractRevisionStoreRefusal {
  const error = createRuntimeError({
    code: "STORAGE_DEGRADED",
    source: { aggregate: "PROJECT", state: "DEGRADED" },
  });
  return Object.freeze({ code: error.code, layer: WRITER_LAYER, ok: false as const });
}

function commitBytes(
  store: SqliteEventStore,
  input: ProductContractRevisionCommitInput,
  revision: ProductContractRevision,
  bytes: Uint8Array,
) {
  const address = addressOf(input.projectId, revision.contractId, revision.revisionId);
  const aggregateId = deriveProductContractRevisionAggregateId(
    input.projectId,
    revision.contractId,
    revision.revisionId,
  );
  return store.commitExpectedVersionDecision({
    commandKind: COMMAND_KIND,
    committedResultBytes: bytes,
    correlationId: input.correlationId,
    decidedAt: input.decidedAt,
    events: [{
      domainSchemaVersion: PRODUCT_CONTRACT_VERSION,
      eventId: `product-contract-revision-event:${address}`,
      eventType: PRODUCT_CONTRACT_REVISION_EVENT_TYPE,
      payload: bytes,
    }],
    expectedVersion: 0,
    key: {
      commandId: `product-contract-revision-command:${address}`,
      principalId: input.principalId,
      projectId: input.projectId,
    },
    requestBytes: bytes,
    targetAggregateId: aggregateId,
  });
}

export function commitProductContractRevision(
  store: SqliteEventStore,
  input: ProductContractRevisionCommitInput,
): ProductContractRevisionCommitResult {
  const created = createProductContractRevision(input.draft);
  if (!created.ok) return created;
  const derived = deriveProductContractRevisionDigest(created.revision);
  if (!derived.ok) return derived;
  const encoded = encodeProductContractRevision(created.revision);
  if (!encoded.ok) return encoded;

  try {
    const response = commitBytes(store, input, created.revision, encoded.bytes);
    if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
      return refuseStore(response.decision.resultCode);
    }
    return Object.freeze({
      bytes: encoded.bytes,
      disposition: response.disposition,
      ok: true as const,
      ref: Object.freeze({
        contractId: created.revision.contractId,
        revisionDigest: derived.revisionDigest,
        revisionId: created.revision.revisionId,
      }),
      revision: created.revision,
    });
  } catch (error) {
    return error instanceof DurableStoreError ? refuseStore(error.code) : refuseUnexpected();
  }
}
