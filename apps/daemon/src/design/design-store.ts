import { admitProductContractRevisionRef, type ProductContractRevisionRef } from "@moe/core";
import { DurableStoreError, type SqliteEventStore, type StoredEvent } from "@moe/store";

import { readProductContractGate1Approval }
  from "../product-contract/product-contract-gate-1-reader.js";
import { validateRevisionProvenance } from "../product-contract/product-contract-provenance.js";
import { readProductContractRevision }
  from "../product-contract/product-contract-revision-reader.js";
import {
  DESIGN_PROFILE,
  DESIGN_REVISION_EVENT_TYPE,
  DESIGN_REVISION_VERSION,
  decodeDesignRevision,
  designAggregateId,
  designRefusal,
  designRevisionEventId,
  type DesignRefusal,
} from "./design-contracts.js";
import { decodeDesignRecordBytes, encodeDesignRecord, type DesignRecord }
  from "./design-records.js";
import { readCompiledContractBinding } from "../planning/compiled-contract-binding.js";

/**
 * The VERSIONED durable aggregate `design:<goalId>`: one append-only history of design revisions
 * per goal, plus the read that serves the latest and any earlier version.
 *
 * VERSIONS ARE HISTORY, NOT A MUTABLE FIELD. A resubmit APPENDS at the next version; version 1
 * stays readable after version 2 exists. That is load-bearing rather than tidy: the operator is
 * shown WHICH design version a plan was compiled against, and a design ref carried into the
 * compiler mission stops naming a specific thing the moment a resubmit can overwrite.
 *
 * THE APPROVAL IS RE-PROVED FROM DURABLE STATE, NEVER PRESENTED. A caller names a contract
 * revision triple; it grants nothing. Three production surfaces re-prove it on every submit —
 * core admits the triple, `validateRevisionProvenance` proves the revision was authored against
 * THIS goal's bound source documents, and `readProductContractGate1Approval` proves a human
 * granted Gate 1 over it. Every one of their verdicts travels out as DESIGN_CONTRACT_NOT_APPROVED
 * with the delegated code and layer copied verbatim, so which authority answered is never lost.
 *
 * THE FENCE IS THE CONCURRENCY STORY. Two seats submitting at once both observe version N; the
 * store admits one and refuses the other DESIGN_REVISION_CONFLICT. A fenced decision is RETURNED,
 * not thrown, so "the call did not throw" is not success — the effect disposition is checked.
 */

export interface DesignSubmitInput {
  readonly commandId: string;
  /** The approved Gate 1 revision triple. RE-PROVED below; presenting it grants nothing. */
  readonly contractRef: unknown;
  readonly correlationId: string;
  readonly decidedAt: string;
  /** The version the caller observed. A stale one is refused rather than overwriting. */
  readonly expectedVersion: number;
  readonly goalRef: string;
  readonly principalId: string;
  readonly projectId: string;
  /** Still `unknown`: only `decodeDesignRevision` may narrow it. */
  readonly revision: unknown;
}

export interface DesignReadInput {
  readonly goalRef: string;
  readonly projectId: string;
  /** Omitted reads the LATEST; a number reads that version out of history. */
  readonly version?: number;
  /** Reads the immutable design selection sealed by this run, never the latest design. */
  readonly planningRunRef?: string;
}

export type DesignSubmitResult =
  | { readonly ok: true; readonly record: DesignRecord }
  | DesignRefusal;

export type DesignReadResult =
  | { readonly ok: true; readonly record: DesignRecord; readonly versions: readonly number[] }
  | DesignRefusal;

function storeFailure(error: unknown): DesignRefusal {
  if (!(error instanceof DurableStoreError)) {
    return designRefusal("DESIGN_STORE_UNAVAILABLE");
  }
  if (error.code === "EXPECTED_VERSION_CONFLICT" || error.code === "DURABLE_ID_CONFLICT"
    || error.code === "IDEMPOTENCY_CONFLICT") {
    return designRefusal("DESIGN_REVISION_CONFLICT", error.code, "DURABLE_STORE");
  }
  return designRefusal("DESIGN_STORE_UNAVAILABLE", error.code, "DURABLE_STORE");
}

/**
 * The Gate 1 precondition, composed from production readers only. No authority is minted here
 * and none is reimplemented: this function can say NO, and can only say YES by quoting three
 * surfaces that each already said yes.
 */
export function readApprovedDesignContract(
  store: SqliteEventStore,
  input: Readonly<{ contractRef: unknown; goalRef: string; projectId: string }>,
): { readonly ok: true; readonly ref: ProductContractRevisionRef } | DesignRefusal {
  const admitted = admitProductContractRevisionRef(input.contractRef);
  if (!admitted.ok) {
    return designRefusal("DESIGN_CONTRACT_NOT_APPROVED", admitted.code, admitted.layer);
  }
  try {
    const revision = readProductContractRevision(store, {
      projectId: input.projectId, ref: admitted.ref,
    });
    if (!revision.ok) {
      return designRefusal("DESIGN_CONTRACT_NOT_APPROVED", revision.code, revision.layer);
    }
    const provenance = validateRevisionProvenance(
      store, input.projectId, input.goalRef, revision.revision.sourceDocumentDigests,
    );
    if (!provenance.ok) {
      return designRefusal("DESIGN_CONTRACT_NOT_APPROVED", provenance.code, provenance.layer);
    }
    const approval = readProductContractGate1Approval(store, {
      projectId: input.projectId, ref: admitted.ref,
    });
    if (!approval.ok) {
      return designRefusal("DESIGN_CONTRACT_NOT_APPROVED", approval.code, approval.layer);
    }
    return Object.freeze({ ok: true as const, ref: admitted.ref });
  } catch (error) { return storeFailure(error); }
}

function designEvents(
  store: SqliteEventStore, aggregateId: string,
): readonly StoredEvent[] | DesignRefusal {
  try {
    return store.readEvents(aggregateId)
      .filter((event) => event.eventType === DESIGN_REVISION_EVENT_TYPE);
  } catch (error) { return storeFailure(error); }
}

/** Appends one revision at the next version. NEVER overwrites: a stale fence refuses instead. */
export function submitDesignRevision(
  store: SqliteEventStore, input: DesignSubmitInput,
): DesignSubmitResult {
  const decoded = decodeDesignRevision(input.revision);
  if (!decoded.ok) return decoded;
  const approved = readApprovedDesignContract(store, {
    contractRef: input.contractRef, goalRef: input.goalRef, projectId: input.projectId,
  });
  if (!approved.ok) return approved;
  const aggregateId = designAggregateId(input.goalRef);
  const version = input.expectedVersion + 1;
  const record: DesignRecord = Object.freeze({
    contractRef: approved.ref,
    goalRef: input.goalRef,
    profile: DESIGN_PROFILE,
    projectId: input.projectId,
    revision: decoded.revision,
    schemaVersion: DESIGN_REVISION_VERSION,
    submittedAt: input.decidedAt,
    version,
  });
  const payload = encodeDesignRecord(record);
  let response;
  try {
    response = store.commitExpectedVersionDecisionLegs({
      commandKind: "design.submit",
      committedResultBytes: payload,
      correlationId: input.correlationId,
      decidedAt: input.decidedAt,
      key: {
        commandId: input.commandId,
        principalId: input.principalId,
        projectId: input.projectId,
      },
      legs: [{
        aggregateId,
        events: [{
          domainSchemaVersion: DESIGN_REVISION_VERSION,
          eventId: designRevisionEventId(input.goalRef, version),
          eventType: DESIGN_REVISION_EVENT_TYPE,
          payload,
        }],
        expectedVersion: input.expectedVersion,
      }],
      requestBytes: payload,
    });
  } catch (error) { return storeFailure(error); }
  // A fenced decision is RETURNED, not thrown: the store writes a NO_BUSINESS_EFFECT record and
  // appends nothing. Reading "it did not throw" as success is how a second submit would be
  // reported as committed while history was never extended.
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return designRefusal(
      "DESIGN_REVISION_CONFLICT", response.decision.resultCode, "DURABLE_STORE",
    );
  }
  return Object.freeze({ ok: true as const, record });
}

/** The LATEST revision by default, with its version number, and every version ever appended. */
export function readDesignRevision(
  store: SqliteEventStore, input: DesignReadInput,
): DesignReadResult {
  let version = input.version;
  if (input.planningRunRef !== undefined) {
    if (version !== undefined) return designRefusal("DESIGN_RECORD_MALFORMED");
    const compiled = readCompiledContractBinding(store, input.projectId, input.planningRunRef);
    if (!compiled.ok || compiled.binding.goalRef !== input.goalRef
      || compiled.binding.designVersion === undefined) return designRefusal("DESIGN_RECORD_MALFORMED");
    if (compiled.binding.designVersion === null) return designRefusal("DESIGN_REVISION_ABSENT");
    version = compiled.binding.designVersion;
  }
  const events = designEvents(store, designAggregateId(input.goalRef));
  if (!Array.isArray(events)) return events as DesignRefusal;
  const records: DesignRecord[] = [];
  for (const event of events) {
    const decoded = decodeDesignRecordBytes(event.payload);
    if (!decoded.ok) return decoded;
    if (decoded.record.projectId !== input.projectId
      || decoded.record.goalRef !== input.goalRef) {
      return designRefusal("DESIGN_RECORD_MALFORMED");
    }
    records.push(decoded.record);
  }
  if (records.length === 0) return designRefusal(input.planningRunRef === undefined ? "DESIGN_REVISION_ABSENT" : "DESIGN_RECORD_MALFORMED");
  const versions = Object.freeze(records.map((entry) => entry.version));
  const wanted = version === undefined
    ? records[records.length - 1]
    : records.find((entry) => entry.version === version);
  if (wanted === undefined) return designRefusal(input.planningRunRef === undefined ? "DESIGN_REVISION_ABSENT" : "DESIGN_RECORD_MALFORMED");
  return Object.freeze({ ok: true as const, record: wanted, versions });
}
