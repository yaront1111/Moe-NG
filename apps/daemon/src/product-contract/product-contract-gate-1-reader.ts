import { createRuntimeError, decodeBoundedJsonBytes, type RuntimeErrorCode } from "@moe/contracts";
import {
  PRINCIPAL_KINDS, admitProductContractRevisionRef, productContractGate1Authority,
} from "@moe/core";
import type {
  HumanAuthorityGate, HumanAuthorityGrant, PrincipalKind, ProductContractRevisionRef,
} from "@moe/core";
import {
  COMMAND_DECISION_REQUEST_IDENTITY_VERSION, COMMAND_EFFECT_IDENTITY_VERSION, DurableStoreError,
  type CommandDecisionRecord, type CommandReceipt, type DurableStoreErrorCode,
  type SqliteEventStore, type StoredEvent,
} from "@moe/store";

import { readExactRecord } from "../identity/session-authority-protocol.js";
import {
  PRODUCT_CONTRACT_GATE_1_COMMAND_KIND, PRODUCT_CONTRACT_GATE_1_EVENT_TYPE,
  PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION, deriveProductContractGate1AggregateId,
} from "./product-contract-gate-1-contract.js";

/**
 * Re-proves the one Gate 1 approval event addressed by core's own work identity,
 * and re-proves that the daemon's own writer command produced it. This is a
 * reader, never a minter: principal kind, moment and the grant's inner binding
 * remain core's questions when the resolver calls `validateProductContractGate1`.
 */

const READER_LAYER = "PRODUCT_CONTRACT_GATE_1_READER" as const;
const DURABLE_STORE_LAYER = "DURABLE_STORE" as const;

export const PRODUCT_CONTRACT_GATE_1_READER_CODES = Object.freeze([
  "PRODUCT_CONTRACT_GATE_1_APPROVAL_ABSENT",
  "PRODUCT_CONTRACT_GATE_1_APPROVAL_AMBIGUOUS",
  "PRODUCT_CONTRACT_GATE_1_EVENT_UNEXPECTED",
  "PRODUCT_CONTRACT_GATE_1_SCHEMA_UNSUPPORTED",
  "PRODUCT_CONTRACT_GATE_1_RECORD_MALFORMED",
  "PRODUCT_CONTRACT_GATE_1_WORK_IDENTITY_MISMATCH",
  "PRODUCT_CONTRACT_GATE_1_PROVENANCE_ABSENT",
  "PRODUCT_CONTRACT_GATE_1_COMMAND_KIND_MISMATCH",
  "PRODUCT_CONTRACT_GATE_1_DECISION_UNRESOLVED",
  "PRODUCT_CONTRACT_GATE_1_RECEIPT_UNBOUND",
] as const);

export type ProductContractGate1ReaderCode =
  (typeof PRODUCT_CONTRACT_GATE_1_READER_CODES)[number];

export interface ProductContractGate1ApprovalReadInput {
  readonly projectId: string;
  readonly ref: ProductContractRevisionRef;
}

export interface ProductContractGate1ApprovalReadAccepted {
  readonly gate: HumanAuthorityGate;
  readonly ok: true;
  readonly ref: ProductContractRevisionRef;
}

export interface ProductContractGate1ApprovalReadRefusal {
  readonly code: DurableStoreErrorCode | ProductContractGate1ReaderCode | RuntimeErrorCode;
  readonly layer: typeof DURABLE_STORE_LAYER | typeof READER_LAYER;
  readonly ok: false;
}

export type ProductContractGate1ApprovalReadResult =
  | ProductContractGate1ApprovalReadAccepted
  | ProductContractGate1ApprovalReadRefusal;

const RECORD_KEYS = Object.freeze([
  "contractId", "gateId", "grant", "revisionDigest", "revisionId", "workRef",
] as const);
const GRANT_KEYS = Object.freeze([
  "gateId", "grantedAtEpochMs", "principalId", "principalKind", "workRef",
] as const);

type GrantRead =
  | Readonly<{ grant: HumanAuthorityGrant | null; ok: true }>
  | Readonly<{ ok: false }>;
type RecordRead = Readonly<{
  gate: HumanAuthorityGate;
  ref: ProductContractRevisionRef;
}>;

function refuseReader(code: ProductContractGate1ReaderCode): ProductContractGate1ApprovalReadRefusal {
  return Object.freeze({ code, layer: READER_LAYER, ok: false as const });
}

function refuseStore(code: DurableStoreErrorCode): ProductContractGate1ApprovalReadRefusal {
  return Object.freeze({ code, layer: DURABLE_STORE_LAYER, ok: false as const });
}

const storeFailure = (error: unknown): ProductContractGate1ApprovalReadRefusal =>
  error instanceof DurableStoreError ? refuseStore(error.code) : refuseUnexpected();

function refuseUnexpected(): ProductContractGate1ApprovalReadRefusal {
  const error = createRuntimeError({
    code: "STORAGE_DEGRADED",
    source: { aggregate: "PROJECT", state: "DEGRADED" },
  });
  return Object.freeze({ code: error.code, layer: READER_LAYER, ok: false as const });
}

function isPrincipalKind(value: unknown): value is PrincipalKind {
  return typeof value === "string" && (PRINCIPAL_KINDS as readonly string[]).includes(value);
}

function readGrant(value: unknown): GrantRead {
  if (value === null) return Object.freeze({ grant: null, ok: true as const });
  const raw = readExactRecord(value, GRANT_KEYS);
  if (raw === null || typeof raw["gateId"] !== "string"
    || typeof raw["grantedAtEpochMs"] !== "number"
    || typeof raw["principalId"] !== "string"
    || !isPrincipalKind(raw["principalKind"])
    || typeof raw["workRef"] !== "string") return Object.freeze({ ok: false as const });
  return Object.freeze({
    grant: Object.freeze({
      gateId: raw["gateId"], grantedAtEpochMs: raw["grantedAtEpochMs"],
      principalId: raw["principalId"], principalKind: raw["principalKind"],
      workRef: raw["workRef"],
    }),
    ok: true as const,
  });
}

function readRecord(event: StoredEvent): RecordRead | null {
  const decoded = decodeBoundedJsonBytes(event.payload);
  if (!decoded.ok) return null;
  const raw = readExactRecord(decoded.value, RECORD_KEYS);
  if (raw === null || typeof raw["gateId"] !== "string"
    || typeof raw["workRef"] !== "string") return null;
  const admitted = admitProductContractRevisionRef({
    contractId: raw["contractId"], revisionDigest: raw["revisionDigest"],
    revisionId: raw["revisionId"],
  });
  if (!admitted.ok) return null;
  const grant = readGrant(raw["grant"]);
  if (!grant.ok) return null;
  return Object.freeze({
    gate: Object.freeze({ gateId: raw["gateId"], grant: grant.grant, workRef: raw["workRef"] }),
    ref: admitted.ref,
  });
}

const HEX64 = /^[0-9a-f]{64}$/u;
type DecisionTrace = NonNullable<StoredEvent["decisionTrace"]>;

/** The trace is the only link from a stored event back to the command that decided it. */
function traceOf(event: StoredEvent): DecisionTrace | null {
  const trace = event.decisionTrace;
  if (trace === undefined || trace.commandId === "" || trace.principalId === ""
    || !HEX64.test(trace.requestSha256) || !HEX64.test(event.requestSha256)
    || !Number.isSafeInteger(event.aggregateSequence) || event.aggregateSequence < 1
    || trace.requestIdentityVersion !== COMMAND_DECISION_REQUEST_IDENTITY_VERSION) return null;
  return trace;
}

function decisionAgrees(
  decision: CommandDecisionRecord, event: StoredEvent, trace: DecisionTrace, projectId: string,
): boolean {
  const prior = event.aggregateSequence - 1;
  return decision.effectDisposition === "EFFECTS_COMMITTED"
    && decision.resultCode === "EFFECTS_COMMITTED"
    && decision.commandKind === PRODUCT_CONTRACT_GATE_1_COMMAND_KIND
    && decision.requestIdentityVersion === COMMAND_DECISION_REQUEST_IDENTITY_VERSION
    && decision.effectIdentityVersion === COMMAND_EFFECT_IDENTITY_VERSION
    && decision.key.commandId === trace.commandId && decision.key.projectId === projectId
    && decision.key.principalId === trace.principalId
    && decision.targetAggregateId === event.aggregateId
    && decision.expectedVersion === prior && decision.observedVersion === prior
    && decision.previousVersion === prior && decision.currentVersion === event.aggregateSequence
    && decision.businessEventIds.length === 1 && decision.businessEventIds[0] === event.eventId
    && decision.outboxMessageIds.length === 0 && decision.decidedAt === event.committedAt
    && decision.requestSha256 === trace.requestSha256;
}

function receiptAgrees(
  receipt: CommandReceipt, decision: CommandDecisionRecord, event: StoredEvent,
): boolean {
  const prior = event.aggregateSequence - 1;
  return receipt.effectIdentityVersion === COMMAND_EFFECT_IDENTITY_VERSION
    && receipt.commandId === event.commandId && receipt.aggregateId === event.aggregateId
    && receipt.previousVersion === prior && receipt.currentVersion === event.aggregateSequence
    && receipt.eventIds.length === 1 && receipt.eventIds[0] === event.eventId
    && receipt.outboxMessageIds.length === 0 && receipt.committedAt === event.committedAt
    && receipt.effectSha256 === decision.effectSha256
    && receipt.requestSha256 === event.requestSha256;
}

/**
 * WRITER PROVENANCE. The checks above adjudicate SHAPE, and a durable shape
 * must never be the mint: a generic store commit can spell a byte-valid
 * `ProductContractGate1Approved` record without traversing bearer admission,
 * `grantHumanAuthority` or this command. Re-prove the event along
 * event -> decisionTrace -> decision -> receipt, bound to this command kind,
 * exactly as activation/human-approval-authority-reader.ts does.
 */
function checkProvenance(
  store: SqliteEventStore, event: StoredEvent, projectId: string,
): ProductContractGate1ApprovalReadRefusal | null {
  const trace = traceOf(event);
  if (trace === null) return refuseReader("PRODUCT_CONTRACT_GATE_1_PROVENANCE_ABSENT");
  if (trace.commandKind !== PRODUCT_CONTRACT_GATE_1_COMMAND_KIND) {
    return refuseReader("PRODUCT_CONTRACT_GATE_1_COMMAND_KIND_MISMATCH");
  }
  let decision: CommandDecisionRecord | null;
  try {
    decision = trace.projectId !== projectId ? null : store.getCommandDecision({
      commandId: trace.commandId, principalId: trace.principalId, projectId,
    });
  } catch (error) { return storeFailure(error); }
  if (decision === null || !decisionAgrees(decision, event, trace, projectId)) {
    return refuseReader("PRODUCT_CONTRACT_GATE_1_DECISION_UNRESOLVED");
  }
  let receipt: CommandReceipt | null;
  try {
    receipt = store.getCommandReceipt(event.commandId);
  } catch (error) { return storeFailure(error); }
  if (receipt === null || !receiptAgrees(receipt, decision, event)) {
    return refuseReader("PRODUCT_CONTRACT_GATE_1_RECEIPT_UNBOUND");
  }
  return null;
}

export function readProductContractGate1Approval(
  store: SqliteEventStore,
  input: ProductContractGate1ApprovalReadInput,
): ProductContractGate1ApprovalReadResult {
  const expectedGate = productContractGate1Authority(input.ref);
  const aggregateId = deriveProductContractGate1AggregateId(expectedGate.workRef);
  let events: readonly StoredEvent[];
  try {
    events = store.readEvents(aggregateId);
  } catch (error) { return storeFailure(error); }
  if (events.length === 0) return refuseReader("PRODUCT_CONTRACT_GATE_1_APPROVAL_ABSENT");
  if (events.length !== 1) return refuseReader("PRODUCT_CONTRACT_GATE_1_APPROVAL_AMBIGUOUS");
  const event = events[0];
  if (event?.eventType !== PRODUCT_CONTRACT_GATE_1_EVENT_TYPE) {
    return refuseReader("PRODUCT_CONTRACT_GATE_1_EVENT_UNEXPECTED");
  }
  if (event.domainSchemaVersion !== PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION) {
    return refuseReader("PRODUCT_CONTRACT_GATE_1_SCHEMA_UNSUPPORTED");
  }
  const record = readRecord(event);
  if (record === null) return refuseReader("PRODUCT_CONTRACT_GATE_1_RECORD_MALFORMED");
  if (record.gate.workRef !== expectedGate.workRef) {
    return refuseReader("PRODUCT_CONTRACT_GATE_1_WORK_IDENTITY_MISMATCH");
  }
  const provenance = checkProvenance(store, event, input.projectId);
  if (provenance !== null) return provenance;
  return Object.freeze({ gate: record.gate, ok: true as const, ref: record.ref });
}
