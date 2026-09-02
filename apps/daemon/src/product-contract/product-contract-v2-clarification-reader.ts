import { DurableStoreError, type DurableStoreErrorCode, type SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { validateRevisionProvenance } from "./product-contract-provenance.js";
import {
  PRODUCT_CONTRACT_CLARIFICATION_V2_AGGREGATE_PREFIX,
  PRODUCT_CONTRACT_CLARIFICATION_V2_CORRUPT_OPEN_ID,
  compareProductContractV2CodeUnits,
  productContractClarificationV2AggregateId,
  type ProductContractClarificationV2Row,
} from "./product-contract-v2-clarification-contract.js";
import { readProductContractClarificationV2Row, validProductContractClarificationV2Text }
  from "./product-contract-v2-clarification-row.js";
import { validateProductContractClarificationV2Provenance }
  from "./product-contract-v2-clarification-provenance.js";

export interface ProductContractClarificationV2OpenReader {
  openMaterialClarificationIds(contractId: string): readonly string[];
}

export type ProductContractClarificationV2Read =
  | Readonly<{ readonly kind: "ABSENT" }>
  | Readonly<{ readonly code: "PRODUCT_CONTRACT_V2_CLARIFICATION_STATE_INVALID";
    readonly kind: "INVALID"; readonly layer: "PRODUCT_CONTRACT_V2_CLARIFICATION" }>
  | Readonly<{ readonly code: DurableStoreErrorCode | "STORAGE_DEGRADED";
    readonly kind: "UNREADABLE"; readonly layer: "DURABLE_STORE" }>
  | Readonly<{ readonly kind: "PRESENT"; readonly row: ProductContractClarificationV2Row }>;

const ABSENT = Object.freeze({ kind: "ABSENT" as const });
const INVALID = Object.freeze({ code: "PRODUCT_CONTRACT_V2_CLARIFICATION_STATE_INVALID" as const,
  kind: "INVALID" as const, layer: "PRODUCT_CONTRACT_V2_CLARIFICATION" as const });
function unreadable(error: unknown): Extract<ProductContractClarificationV2Read,
{ readonly kind: "UNREADABLE" }> {
  return Object.freeze({ code: error instanceof DurableStoreError ? error.code : "STORAGE_DEGRADED",
    kind: "UNREADABLE" as const, layer: "DURABLE_STORE" as const });
}

function readAggregate(
  store: SqliteEventStore,
  projectId: string,
  aggregateId: string,
  state: unknown,
): ProductContractClarificationV2Read {
  const row = readProductContractClarificationV2Row(state);
  if (row === null || productContractClarificationV2AggregateId(
    projectId, row.contractId, row.clarificationId,
  ) !== aggregateId) return INVALID;
  try {
    const source = validateRevisionProvenance(
      store, projectId, row.goalRef, row.sharedIdentity.sourceDocumentDigests,
    );
    if (!source.ok) return INVALID;
  } catch (error) {
    return unreadable(error);
  }
  const provenance = validateProductContractClarificationV2Provenance(
    store, projectId, aggregateId, row,
  );
  return provenance.kind === "VALID"
    ? Object.freeze({ kind: "PRESENT" as const, row })
    : provenance.kind === "INVALID" ? INVALID : provenance;
}

export function readProductContractClarificationV2(
  store: SqliteEventStore,
  projectId: string,
  contractId: string,
  clarificationId: string,
): ProductContractClarificationV2Read {
  const aggregateId = productContractClarificationV2AggregateId(
    projectId, contractId, clarificationId,
  );
  try {
    const ledger = readDurableLedger(store, projectId);
    if (!ledger.aggregates.has(aggregateId)) return ABSENT;
    return readAggregate(store, projectId, aggregateId, stateOf(ledger, aggregateId));
  } catch (error) {
    return unreadable(error);
  }
}

export type ProductContractClarificationV2Scan =
  | Readonly<{ readonly kind: "PRESENT";
    readonly rows: readonly ProductContractClarificationV2Row[] }>
  | Extract<ProductContractClarificationV2Read, { readonly kind: "INVALID" | "UNREADABLE" }>;

function scanProductContractClarificationsV2(
  store: SqliteEventStore,
  projectId: string,
): ProductContractClarificationV2Scan {
  try {
    const ledger = readDurableLedger(store, projectId);
    const rows: ProductContractClarificationV2Row[] = [];
    const aggregates = [...ledger.aggregates.keys()]
      .filter((aggregateId) => aggregateId.startsWith(
        PRODUCT_CONTRACT_CLARIFICATION_V2_AGGREGATE_PREFIX,
      )).sort(compareProductContractV2CodeUnits);
    for (const aggregateId of aggregates) {
      const read = readAggregate(store, projectId, aggregateId, stateOf(ledger, aggregateId));
      if (read.kind === "PRESENT") rows.push(read.row);
      else return read.kind === "ABSENT" ? INVALID : read;
    }
    rows.sort((left, right) => compareProductContractV2CodeUnits(
      left.clarificationId, right.clarificationId,
    ));
    return Object.freeze({ kind: "PRESENT" as const, rows: Object.freeze(rows) });
  } catch (error) {
    return unreadable(error);
  }
}

export function readProductContractClarificationsV2ForContract(
  store: SqliteEventStore, projectId: string, contractId: string,
): ProductContractClarificationV2Scan {
  if (!validProductContractClarificationV2Text(contractId)) return INVALID;
  const scan = scanProductContractClarificationsV2(store, projectId);
  return scan.kind === "PRESENT" ? Object.freeze({ kind: "PRESENT" as const,
    rows: Object.freeze(scan.rows.filter((row) => row.contractId === contractId)) }) : scan;
}

export function productContractClarificationsV2ForContract(
  store: SqliteEventStore,
  projectId: string,
  contractId: string,
): readonly ProductContractClarificationV2Row[] {
  const read = readProductContractClarificationsV2ForContract(store, projectId, contractId);
  return read.kind === "PRESENT" ? read.rows : Object.freeze([]);
}

/** Structurally satisfies the proposal service's open-clarification fence port. */
export function createProductContractClarificationV2OpenReader(
  store: SqliteEventStore,
  projectId: string,
): ProductContractClarificationV2OpenReader {
  return Object.freeze({
    openMaterialClarificationIds(contractId: string): readonly string[] {
      if (!validProductContractClarificationV2Text(contractId)) {
        return Object.freeze([PRODUCT_CONTRACT_CLARIFICATION_V2_CORRUPT_OPEN_ID]);
      }
      const scan = readProductContractClarificationsV2ForContract(store, projectId, contractId);
      if (scan.kind !== "PRESENT") {
        return Object.freeze([PRODUCT_CONTRACT_CLARIFICATION_V2_CORRUPT_OPEN_ID]);
      }
      return Object.freeze(scan.rows.filter((row) => row.answerDecision === null)
        .map((row) => row.clarificationId));
    },
  });
}
