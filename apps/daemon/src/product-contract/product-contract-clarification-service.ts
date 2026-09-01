/**
 * The clarification lifecycle — the compiler lane's "ask the human" wire.
 *
 * ASK (`product_contract.ask_clarification`, agent-staffable): the planning
 * agent presents a QUESTION with 2..64 OPTIONS, each carrying a full candidate
 * projection (criteria + requirements). Core's `assessClarificationMateriality`
 * is the only judge: an immaterial or vacuous question is REFUSED with core's
 * own code — the agent proceeds without asking — and a material one is recorded
 * durably with its option digests. The clarification id is CONTENT-ADDRESSED
 * over (contract, question, options), so a re-ask is a REPLAY, never a second
 * open question.
 *
 * ANSWER (`product_contract.answer_clarification`, HUMAN-only: operator-gated
 * with the paired-principal widening, MCP-excluded): the human picks one of the
 * recorded option digests. First answer wins durably; a different second answer
 * refuses ALREADY_ANSWERED; the identical one replays.
 *
 * WHAT AN OPEN MATERIAL QUESTION FENCES: the Gate 1 card's pending read
 * withholds the approval template while one is open for the pending contract —
 * the human answers before approving, on the same card. The record here is the
 * only durable source that fence reads.
 */
import { createHash } from "node:crypto";

import { assessClarificationMateriality } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";

const LAYER = "PRODUCT_CONTRACT_CLARIFICATION" as const;
const ADDRESS_DOMAIN = "moe/product-contract/clarification/v1";
const AGGREGATE_PREFIX = "product-contract-clarification:";
const EVENT_TYPE = "ProductContractClarificationRecorded" as const;
const SCHEMA_VERSION = "moe-product-contract-clarification/1" as const;

export const PRODUCT_CONTRACT_CLARIFICATION_SERVICE_CODES = Object.freeze([
  "PRODUCT_CONTRACT_CLARIFICATION_MALFORMED",
  "PRODUCT_CONTRACT_CLARIFICATION_UNKNOWN",
  "PRODUCT_CONTRACT_CLARIFICATION_ALREADY_ANSWERED",
  "PRODUCT_CONTRACT_CLARIFICATION_ANSWER_UNKNOWN_OPTION",
  "PRODUCT_CONTRACT_CLARIFICATION_STORE_REFUSED",
] as const);

export interface ClarificationCommandInput {
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly payload: unknown;
  readonly principalId: string;
  readonly projectId: string;
}

export interface ClarificationAccepted {
  readonly clarificationId: string;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly ok: true;
}
export interface ClarificationRefused {
  readonly code: string;
  readonly layer: string;
  readonly ok: false;
}
export type ClarificationResult = ClarificationAccepted | ClarificationRefused;

/** The durable row the fold serves — also what the Gate 1 fence and card read. */
export interface ClarificationRow {
  readonly answer: {
    readonly answerProjectionDigest: string;
    readonly answeredBy: string;
  } | null;
  readonly clarificationId: string;
  readonly contractId: string;
  readonly optionDigests: readonly {
    readonly optionId: string;
    readonly projectionDigest: string;
  }[];
  readonly options: readonly { readonly label: string; readonly optionId: string }[];
  readonly question: string;
}

function refused(code: string, layer: string = LAYER): ClarificationRefused {
  return Object.freeze({ code, layer, ok: false });
}

function dataRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

const boundedText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 2000;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonical(record[key])}`,
  ).join(",")}}`;
}

function addressOf(projectId: string, contractId: string, clarificationId: string): string {
  const hash = createHash("sha256").update(ADDRESS_DOMAIN, "utf8");
  for (const part of [projectId, contractId, clarificationId]) {
    hash.update(Uint8Array.of(0)).update(part, "utf8");
  }
  return hash.digest("hex");
}

export function clarificationAggregateId(
  projectId: string, contractId: string, clarificationId: string,
): string {
  return `${AGGREGATE_PREFIX}${addressOf(projectId, contractId, clarificationId)}`;
}

/** The ledger-folded row at an aggregate, or null when absent or misshapen. */
export function readClarificationRow(value: unknown): ClarificationRow | null {
  const row = dataRecord(value);
  if (row === null || !boundedText(row["clarificationId"])
    || !boundedText(row["contractId"]) || !boundedText(row["question"])
    || !Array.isArray(row["optionDigests"]) || !Array.isArray(row["options"])) return null;
  const answer = row["answer"] === null ? null : dataRecord(row["answer"]);
  if (row["answer"] !== null
    && (answer === null || !boundedText(answer["answerProjectionDigest"]))) return null;
  return row as unknown as ClarificationRow;
}

/** Every clarification row for one contract, read off the folded ledger. */
export function clarificationsForContract(
  store: SqliteEventStore, projectId: string, contractId: string,
): readonly ClarificationRow[] {
  const ledger = readDurableLedger(store, projectId);
  const rows: ClarificationRow[] = [];
  for (const [aggregateId] of ledger.aggregates) {
    if (!aggregateId.startsWith(AGGREGATE_PREFIX)) continue;
    const row = readClarificationRow(stateOf(ledger, aggregateId));
    if (row !== null && row.contractId === contractId) rows.push(row);
  }
  return rows.sort((left, right) =>
    left.clarificationId.localeCompare(right.clarificationId));
}

export function runAskClarification(
  store: SqliteEventStore, input: ClarificationCommandInput,
): ClarificationResult {
  const payload = dataRecord(input.payload);
  const contractId = payload?.["contractId"];
  const options = payload?.["options"];
  const question = payload?.["question"];
  if (payload === null || Object.keys(payload).length !== 3
    || !boundedText(contractId) || !boundedText(question) || !Array.isArray(options)) {
    return refused("PRODUCT_CONTRACT_CLARIFICATION_MALFORMED");
  }
  // CONTENT-ADDRESSED identity: the same question over the same options is the
  // same clarification, whoever asks and however many times.
  const clarificationId = `clar-${createHash("sha256")
    .update(ADDRESS_DOMAIN, "utf8").update(Uint8Array.of(1))
    .update(contractId, "utf8").update(Uint8Array.of(0))
    .update(canonical({ options, question }), "utf8")
    .digest("hex").slice(0, 24)}`;
  // CORE IS THE ONLY JUDGE. Its refusal (invalid / vacuous / immaterial)
  // travels out verbatim — an immaterial question is the agent's cue to decide
  // for itself, not a fault.
  const materiality = assessClarificationMateriality({ clarificationId, options, question });
  if (!materiality.ok) return refused(materiality.code, String(materiality.layer));
  const labels: { label: string; optionId: string }[] = [];
  for (const option of options) {
    const record = dataRecord(option);
    if (record === null || !boundedText(record["label"]) || !boundedText(record["optionId"])) {
      return refused("PRODUCT_CONTRACT_CLARIFICATION_MALFORMED");
    }
    labels.push({ label: record["label"], optionId: record["optionId"] });
  }
  const aggregateId = clarificationAggregateId(input.projectId, contractId, clarificationId);
  const committed = commitRowAt(store, input, `clarification-ask-${addressOf(
    input.projectId, contractId, clarificationId,
  )}`, aggregateId, 0, Object.freeze({
    answer: null,
    clarificationId,
    contractId,
    optionDigests: materiality.optionDigests,
    options: Object.freeze(labels),
    question,
  }));
  if (!committed.ok) {
    // A second DIFFERENT ask can never collide (content-addressed), so a
    // version conflict here means this exact question is already recorded.
    return committed.code === "PRODUCT_CONTRACT_CLARIFICATION_STORE_REFUSED"
      && rowExists(store, input.projectId, contractId, clarificationId)
      ? Object.freeze({ clarificationId, disposition: "REPLAYED" as const, ok: true as const })
      : committed;
  }
  return Object.freeze({ clarificationId, disposition: committed.disposition, ok: true as const });
}

function rowExists(
  store: SqliteEventStore, projectId: string, contractId: string, clarificationId: string,
): boolean {
  const ledger = readDurableLedger(store, projectId);
  return readClarificationRow(stateOf(
    ledger, clarificationAggregateId(projectId, contractId, clarificationId),
  )) !== null;
}

function commitRowAt(
  store: SqliteEventStore, input: ClarificationCommandInput, commandId: string,
  aggregateId: string, expectedVersion: number, row: ClarificationRow,
): { disposition: "DECIDED" | "REPLAYED"; ok: true } | ClarificationRefused {
  const bytes = new TextEncoder().encode(JSON.stringify(row));
  try {
    const response = store.commitExpectedVersionDecision({
      commandKind: expectedVersion === 0
        ? "product_contract.ask_clarification"
        : "product_contract.answer_clarification",
      committedResultBytes: bytes,
      correlationId: input.correlationId,
      decidedAt: input.decidedAt,
      events: [{
        domainSchemaVersion: SCHEMA_VERSION,
        eventId: `${commandId}-event`,
        eventType: EVENT_TYPE,
        payload: bytes,
      }],
      expectedVersion,
      key: { commandId, principalId: input.principalId, projectId: input.projectId },
      requestBytes: bytes,
      targetAggregateId: aggregateId,
    });
    if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
      return refused("PRODUCT_CONTRACT_CLARIFICATION_STORE_REFUSED", "DURABLE_STORE");
    }
    return { disposition: response.disposition === "REPLAYED" ? "REPLAYED" : "DECIDED", ok: true };
  } catch {
    return refused("PRODUCT_CONTRACT_CLARIFICATION_STORE_REFUSED", "DURABLE_STORE");
  }
}

export function runAnswerClarification(
  store: SqliteEventStore, input: ClarificationCommandInput,
): ClarificationResult {
  const payload = dataRecord(input.payload);
  const answerProjectionDigest = payload?.["answerProjectionDigest"];
  const clarificationId = payload?.["clarificationId"];
  const contractId = payload?.["contractId"];
  if (payload === null || Object.keys(payload).length !== 3
    || !boundedText(answerProjectionDigest) || !boundedText(clarificationId)
    || !boundedText(contractId)) {
    return refused("PRODUCT_CONTRACT_CLARIFICATION_MALFORMED");
  }
  const aggregateId = clarificationAggregateId(input.projectId, contractId, clarificationId);
  const ledger = readDurableLedger(store, input.projectId);
  const row = readClarificationRow(stateOf(ledger, aggregateId));
  if (row === null) return refused("PRODUCT_CONTRACT_CLARIFICATION_UNKNOWN");
  if (row.answer !== null) {
    // The identical answer replays honestly; a different one is refused — the
    // first human answer is the durable product decision.
    return row.answer.answerProjectionDigest === answerProjectionDigest
      ? Object.freeze({ clarificationId, disposition: "REPLAYED" as const, ok: true as const })
      : refused("PRODUCT_CONTRACT_CLARIFICATION_ALREADY_ANSWERED");
  }
  if (!row.optionDigests.some(
    (option) => option.projectionDigest === answerProjectionDigest,
  )) {
    return refused("PRODUCT_CONTRACT_CLARIFICATION_ANSWER_UNKNOWN_OPTION");
  }
  const committed = commitRowAt(store, input, `clarification-answer-${addressOf(
    input.projectId, contractId, clarificationId,
  )}`, aggregateId, 1, Object.freeze({
    ...row,
    answer: Object.freeze({
      answerProjectionDigest,
      answeredBy: input.principalId,
    }),
  }));
  if (!committed.ok) return committed;
  return Object.freeze({ clarificationId, disposition: committed.disposition, ok: true as const });
}
