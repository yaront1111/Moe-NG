import type {
  ProductContractCurrentRevisionSlotV2,
  ProductContractRevisionV2,
} from "@moe/core";
import { MAX_JSON_BODY_BYTES } from "@moe/contracts";

import { admitGate1ContractRevision } from "./gate1-contract-admission.js";
import {
  GATE1_ANSWER_COMMAND_KIND,
  GATE1_COMMAND_KIND,
  admitGate1DaemonSubmission,
} from "./gate1-daemon-submission.js";
import type { Gate1DaemonSubmission } from "./gate1-daemon-submission.js";
import {
  exactGate1Row, gate1Digest, gate1Text, snapshotGate1Data,
} from "./gate1-data-snapshot.js";
import { gate1RefusalFromSnapshot } from "./gate1-refusal.js";

export const GATE1_LAYER = "CONTROL_ROOM_GATE1" as const;
type Row = Readonly<Record<string, unknown>>;
const encoder = new TextEncoder();
// Browser-safe mirrors of the v2 wire bounds; the 64/65 test pins the option boundary.
const MAX_ID_BYTES = 512;
const MAX_OPTIONS = 64;
const MAX_REVISION_HISTORY = 1_024;
const MAX_STATEMENT_BYTES = 32_768;
const CURRENT_SLOT_VERSION = "moe-product-contract-current-revision-slot/2" as const;
const CURRENT_SLOT_DIGEST_DOMAIN = "moe-product-contract-current-revision-slot-digest/2";
const REVISION_VERSION = "moe-product-contract-revision/2" as const;

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && !value.includes("\0") && value.isWellFormed() && value.normalize("NFC") === value
    && value.trim() === value && encoder.encode(value).byteLength <= maximum;
}

export interface Gate1ClarificationOptionView {
  readonly answer: Gate1DaemonSubmission;
  readonly label: string;
  readonly optionId: string;
  readonly projectionDigest: string;
  readonly revisionDigest: string;
}

export interface Gate1ClarificationView {
  readonly clarificationId: string;
  readonly options: readonly Gate1ClarificationOptionView[];
  readonly question: string;
}

export interface Gate1PendingView {
  readonly approval: Gate1DaemonSubmission | null;
  readonly clarifications: readonly Gate1ClarificationView[];
  readonly contractId: string;
  readonly revision: ProductContractRevisionV2;
  readonly revisionDigest: string;
  readonly revisionId: string;
  readonly status: "PENDING";
}

export interface Gate1CurrentView {
  readonly contractId: string;
  readonly revision: ProductContractRevisionV2;
  readonly revisionDigest: string;
  readonly revisionId: string;
  readonly slot: ProductContractCurrentRevisionSlotV2;
  readonly status: "CURRENT";
}

export type Gate1ReadOutcome =
  | Gate1CurrentView
  | Gate1PendingView
  | { readonly status: "NONE" }
  | { readonly code: string; readonly layer: string; readonly status: "ERROR" | "REFUSED" };

function errored(): Gate1ReadOutcome {
  return Object.freeze({
    code: "GATE1_RESPONSE_INVALID", layer: GATE1_LAYER, status: "ERROR" as const,
  });
}

function slotCanonicalText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(slotCanonicalText).join(",")}]`;
  if (typeof value === "object") {
    const row = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(row).sort().map(
      (key) => `${JSON.stringify(key)}:${slotCanonicalText(row[key])}`,
    ).join(",")}}`;
  }
  throw new TypeError("non-canonical Product Contract current slot");
}

function slotRefOf(
  value: unknown, contractId: string,
): ProductContractCurrentRevisionSlotV2["currentRevision"] | null {
  const row = exactGate1Row(value, ["contractId", "revisionDigest", "revisionId", "version"]);
  if (row === null || row["contractId"] !== contractId
    || !boundedText(row["revisionId"], MAX_ID_BYTES)
    || !gate1Digest(row["revisionDigest"]) || row["version"] !== REVISION_VERSION) return null;
  return Object.freeze({
    contractId,
    revisionDigest: row["revisionDigest"],
    revisionId: row["revisionId"],
    version: REVISION_VERSION,
  });
}

async function validSlotDigest(slot: ProductContractCurrentRevisionSlotV2): Promise<boolean> {
  try {
    if (encoder.encode(slotCanonicalText(slot)).byteLength > MAX_JSON_BODY_BYTES) return false;
    const { slotDigest: _digest, ...source } = slot;
    const domain = encoder.encode(CURRENT_SLOT_DIGEST_DOMAIN);
    const body = encoder.encode(slotCanonicalText(source));
    const bytes = new Uint8Array(domain.byteLength + 1 + body.byteLength);
    bytes.set(domain, 0);
    bytes.set(body, domain.byteLength + 1);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("") === slot.slotDigest;
  } catch {
    return false;
  }
}

async function currentSlotOf(
  value: unknown, revision: ProductContractRevisionV2, expectedProjectId: string,
): Promise<ProductContractCurrentRevisionSlotV2 | null> {
  const row = exactGate1Row(value, [
    "contractId", "currentRevision", "generation", "projectId", "revisionHistory",
    "slotDigest", "version",
  ]);
  if (row === null || row["contractId"] !== revision.contractId
    || !boundedText(row["projectId"], MAX_ID_BYTES) || row["projectId"] !== expectedProjectId
    || !Number.isSafeInteger(row["generation"]) || (row["generation"] as number) <= 0
    || !gate1Digest(row["slotDigest"]) || row["version"] !== CURRENT_SLOT_VERSION
    || !Array.isArray(row["revisionHistory"])
    || row["revisionHistory"].length > MAX_REVISION_HISTORY) return null;
  const current = slotRefOf(row["currentRevision"], revision.contractId);
  if (current === null || current.revisionId !== revision.revisionId
    || current.revisionDigest !== revision.revisionDigest
    || current.version !== revision.version
    || row["generation"] !== row["revisionHistory"].length + 1) return null;
  const history: ProductContractCurrentRevisionSlotV2["revisionHistory"][number][] = [];
  const revisionIds = new Set([current.revisionId]);
  const revisionDigests = new Set([current.revisionDigest]);
  for (const value of row["revisionHistory"]) {
    const ref = slotRefOf(value, revision.contractId);
    if (ref === null || revisionIds.has(ref.revisionId)
      || revisionDigests.has(ref.revisionDigest)) return null;
    revisionIds.add(ref.revisionId); revisionDigests.add(ref.revisionDigest); history.push(ref);
  }
  const parent = history.at(-1);
  if (revision.lineage === null
    ? history.length !== 0
    : parent === undefined || parent.revisionId !== revision.lineage.parentRevisionId
      || parent.revisionDigest !== revision.lineage.parentRevisionDigest) return null;
  const slot = Object.freeze({
    contractId: revision.contractId,
    currentRevision: current,
    generation: row["generation"] as number,
    projectId: row["projectId"],
    revisionHistory: Object.freeze(history),
    slotDigest: row["slotDigest"],
    version: CURRENT_SLOT_VERSION,
  });
  return await validSlotDigest(slot) ? slot : null;
}

async function currentOf(
  response: Row, expectedProjectId: string,
): Promise<Gate1CurrentView | null> {
  const exact = exactGate1Row(response, ["outcome", "ref", "revision", "slot"]);
  if (exact === null) return null;
  const revision = await admitGate1ContractRevision(exact["revision"]);
  const ref = exactGate1Row(exact["ref"], ["contractId", "revisionDigest", "revisionId"]);
  if (revision === null || ref === null || !gate1Text(ref["contractId"])
    || !gate1Digest(ref["revisionDigest"]) || !gate1Text(ref["revisionId"])
    || ref["contractId"] !== revision.contractId
    || ref["revisionDigest"] !== revision.revisionDigest
    || ref["revisionId"] !== revision.revisionId) return null;
  const slot = await currentSlotOf(exact["slot"], revision, expectedProjectId);
  return slot === null ? null : Object.freeze({
    contractId: revision.contractId,
    revision,
    revisionDigest: revision.revisionDigest,
    revisionId: revision.revisionId,
    slot,
    status: "CURRENT" as const,
  });
}

function clarificationOf(
  value: unknown, contractId: string, identities: Set<string>,
): Gate1ClarificationView | null {
  const row = exactGate1Row(value, ["clarificationId", "options", "question"]);
  if (row === null || !boundedText(row["clarificationId"], MAX_ID_BYTES)
    || !boundedText(row["question"], MAX_STATEMENT_BYTES)
    || !Array.isArray(row["options"]) || row["options"].length < 2
    || row["options"].length > MAX_OPTIONS) return null;
  const options: Gate1ClarificationOptionView[] = [];
  const optionIds = new Set<string>();
  const projectionDigests = new Set<string>();
  const revisionDigests = new Set<string>();
  let previousOptionId: string | null = null;
  for (const optionValue of row["options"]) {
    const option = exactGate1Row(optionValue, [
      "answer", "label", "optionId", "projectionDigest", "revisionDigest",
    ]);
    if (option === null
      || !boundedText(option["label"], MAX_STATEMENT_BYTES)
      || !boundedText(option["optionId"], MAX_ID_BYTES)
      || optionIds.has(option["optionId"])
      || (previousOptionId !== null && previousOptionId >= option["optionId"])
      || !gate1Digest(option["projectionDigest"])
      || projectionDigests.has(option["projectionDigest"])
      || !gate1Digest(option["revisionDigest"])
      || revisionDigests.has(option["revisionDigest"])) return null;
    optionIds.add(option["optionId"]);
    projectionDigests.add(option["projectionDigest"]);
    revisionDigests.add(option["revisionDigest"]);
    previousOptionId = option["optionId"];
    const answer = admitGate1DaemonSubmission(
      option["answer"], GATE1_ANSWER_COMMAND_KIND,
      {
        answerOptionId: option["optionId"],
        clarificationId: row["clarificationId"],
        contractId,
      },
    );
    if (answer === null || answer.commandId === answer.correlationId
      || identities.has(answer.commandId) || identities.has(answer.correlationId)) return null;
    identities.add(answer.commandId); identities.add(answer.correlationId);
    options.push(Object.freeze({
      answer,
      label: option["label"],
      optionId: option["optionId"],
      projectionDigest: option["projectionDigest"],
      revisionDigest: option["revisionDigest"],
    }));
  }
  return Object.freeze({
    clarificationId: row["clarificationId"],
    options: Object.freeze(options),
    question: row["question"],
  });
}

async function pendingOf(response: Row): Promise<Gate1PendingView | null> {
  const exact = exactGate1Row(response, ["approval", "clarifications", "outcome", "ref", "revision"]);
  if (exact === null || !Array.isArray(exact["clarifications"])) return null;
  const revision = await admitGate1ContractRevision(exact["revision"]);
  const ref = exactGate1Row(exact["ref"], ["contractId", "revisionDigest", "revisionId"]);
  if (revision === null || ref === null || !gate1Text(ref["contractId"])
    || !gate1Digest(ref["revisionDigest"]) || !gate1Text(ref["revisionId"])
    || ref["contractId"] !== revision.contractId
    || ref["revisionDigest"] !== revision.revisionDigest
    || ref["revisionId"] !== revision.revisionId) return null;
  const clarifications: Gate1ClarificationView[] = [];
  const clarificationIds = new Set<string>();
  const identities = new Set<string>();
  for (const value of exact["clarifications"]) {
    const row = clarificationOf(value, revision.contractId, identities);
    if (row === null || clarificationIds.has(row.clarificationId)) return null;
    clarificationIds.add(row.clarificationId);
    clarifications.push(row);
  }
  const approval = exact["approval"] === null ? null : admitGate1DaemonSubmission(
    exact["approval"], GATE1_COMMAND_KIND,
    {
      contractId: revision.contractId,
      revisionDigest: revision.revisionDigest,
      revisionId: revision.revisionId,
    },
  );
  if (exact["approval"] !== null && (approval === null || clarifications.length > 0
    || approval.commandId === approval.correlationId || identities.has(approval.commandId)
    || identities.has(approval.correlationId))) return null;
  return Object.freeze({
    approval,
    clarifications: Object.freeze(clarifications),
    contractId: revision.contractId,
    revision,
    revisionDigest: revision.revisionDigest,
    revisionId: revision.revisionId,
    status: "PENDING" as const,
  });
}

/** Maps the daemon query answer without granting authority to malformed partial content. */
export async function mapGate1Answer(
  status: number, response: unknown, expectedProjectId?: string,
): Promise<Gate1ReadOutcome> {
  try {
    const captured = snapshotGate1Data(response);
    if (!captured.ok || typeof captured.value !== "object" || captured.value === null
      || Array.isArray(captured.value)) return errored();
    const row = captured.value as Row;
    if (status === 200 && row["outcome"] === "NONE"
      && exactGate1Row(row, ["outcome"]) !== null) return Object.freeze({ status: "NONE" as const });
    if (status === 200 && row["outcome"] === "CURRENT") {
      return typeof expectedProjectId === "string"
        ? await currentOf(row, expectedProjectId) ?? errored()
        : errored();
    }
    const refusal = gate1RefusalFromSnapshot(status, row);
    if (refusal !== null) {
      return Object.freeze({ ...refusal, status: "REFUSED" as const });
    }
    if (status !== 200) return errored();
    if (row["outcome"] !== "PENDING") return errored();
    return await pendingOf(row) ?? errored();
  } catch {
    return errored();
  }
}
