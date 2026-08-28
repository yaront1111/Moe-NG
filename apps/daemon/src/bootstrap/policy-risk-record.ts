import { createHash } from "node:crypto";

import { POLICY_RISK_TIERS, type PolicyRiskTier } from "@moe/core";

import { isIsoInstant } from "../identity/session-contracts.js";

export const POLICY_RISK_EVENT_TYPE = "policy.risk-assessment.v1" as const;
/**
 * MODULE-PRIVATE. A column-zero exported `*_LAYER` declares a production boundary that the
 * security roster must cover. The read side has no production writer yet, so callers compose
 * refusals through `policyRiskRefusal` until task-12465418 promotes the live boundary.
 */
const POLICY_RISK_LAYER = "DAEMON_POLICY_RISK" as const;
export const POLICY_RISK_RECORD_KEYS = Object.freeze([
  "actionKind", "approvedBy", "assessedAt", "decisionRef",
  "projectId", "subjectRef", "subjectRevision", "tier",
] as const);
export const POLICY_RISK_RECORD_CODES = Object.freeze([
  "POLICY_RISK_RECORD_INVALID",
  "POLICY_RISK_RECORD_CONFLICT",
] as const);
export const POLICY_RISK_READER_CODES = Object.freeze([
  "POLICY_RISK_RECORD_MISSING",
  "POLICY_RISK_RECORD_UNREADABLE",
  "POLICY_RISK_PROJECT_FOREIGN",
  "POLICY_RISK_APPROVER_FOREIGN",
  "POLICY_RISK_ACTION_MISSING",
  "POLICY_RISK_SUBJECT_STALE",
  "POLICY_RISK_REVISION_STALE",
] as const);
export const POLICY_RISK_WRITER_CODES = Object.freeze([
  "POLICY_RISK_ACTOR_NOT_HUMAN",
  "POLICY_RISK_DECISION_REF_MISSING",
  "POLICY_RISK_STEP_UP_MISSING",
  "POLICY_RISK_TIER_MISSING",
  "POLICY_RISK_SUBJECT_UNAVAILABLE",
] as const);

export type PolicyRiskRecordCode = (typeof POLICY_RISK_RECORD_CODES)[number];
export type PolicyRiskReaderCode = (typeof POLICY_RISK_READER_CODES)[number];
export type PolicyRiskWriterCode = (typeof POLICY_RISK_WRITER_CODES)[number];
export type PolicyRiskRefusalCode =
  | PolicyRiskRecordCode | PolicyRiskReaderCode | PolicyRiskWriterCode;
export type PolicyRiskLayer = typeof POLICY_RISK_LAYER;
export interface PolicyRiskRecord {
  readonly actionKind: string;
  readonly approvedBy: string;
  readonly assessedAt: string;
  readonly decisionRef: string;
  readonly projectId: string;
  readonly subjectRef: string;
  readonly subjectRevision: number;
  readonly tier: PolicyRiskTier;
}
export interface PolicyRiskRefusal {
  readonly code: PolicyRiskRecordCode;
  readonly layer: typeof POLICY_RISK_LAYER;
  readonly ok: false;
}
export interface PolicyRiskRecordAccepted {
  readonly bytes: Uint8Array;
  readonly ok: true;
  readonly record: Readonly<PolicyRiskRecord>;
}
export type PolicyRiskRecordResult = PolicyRiskRecordAccepted | PolicyRiskRefusal;
export type PolicyRiskSelection =
  | Readonly<{ readonly ok: true; readonly record: Readonly<PolicyRiskRecord> | null }>
  | PolicyRiskRefusal;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const AGGREGATE_DOMAIN = "moe.policy-risk.aggregate.v1";
const MAX_REF_BYTES = 512;

export function policyRiskRefusal<Code extends PolicyRiskRefusalCode>(
  code: Code,
): Readonly<{ readonly code: Code; readonly layer: PolicyRiskLayer; readonly ok: false }> {
  return Object.freeze({ code, layer: POLICY_RISK_LAYER, ok: false as const });
}

function refuse(code: PolicyRiskRecordCode): PolicyRiskRefusal {
  return policyRiskRefusal(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownDataSnapshot(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== POLICY_RISK_RECORD_KEYS.length
      || keys.some((key) => typeof key !== "string" || !POLICY_RISK_RECORD_KEYS.includes(
        key as (typeof POLICY_RISK_RECORD_KEYS)[number],
      ))) return null;
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of POLICY_RISK_RECORD_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return null;
  }
}

function isBoundedRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value
    && value.isWellFormed() && value.normalize("NFC") === value && !value.includes("\0")
    && encoder.encode(value).byteLength <= MAX_REF_BYTES;
}

function isTier(value: unknown): value is PolicyRiskTier {
  return typeof value === "string"
    && POLICY_RISK_TIERS.some((candidate) => candidate === value);
}

function admitted(value: unknown): Readonly<PolicyRiskRecord> | null {
  const input = ownDataSnapshot(value);
  if (input === null || !isBoundedRef(input["actionKind"])
    || !isBoundedRef(input["approvedBy"]) || !isIsoInstant(input["assessedAt"] as never)
    || !isBoundedRef(input["decisionRef"]) || !isBoundedRef(input["projectId"])
    || !isBoundedRef(input["subjectRef"])
    || !Number.isSafeInteger(input["subjectRevision"]) || Number(input["subjectRevision"]) < 0
    || !isTier(input["tier"])) return null;
  return Object.freeze({
    actionKind: input["actionKind"], approvedBy: input["approvedBy"],
    assessedAt: input["assessedAt"] as string, decisionRef: input["decisionRef"],
    projectId: input["projectId"], subjectRef: input["subjectRef"],
    subjectRevision: input["subjectRevision"] as number, tier: input["tier"],
  });
}

export function buildPolicyRiskRecord(value: unknown): PolicyRiskRecordResult {
  const record = admitted(value);
  if (record === null) return refuse("POLICY_RISK_RECORD_INVALID");
  return Object.freeze({
    bytes: encoder.encode(JSON.stringify(record)), ok: true as const, record,
  });
}

export function decodePolicyRiskRecord(bytes: Uint8Array): PolicyRiskRecordResult {
  let value: unknown;
  try { value = JSON.parse(decoder.decode(bytes)); } catch {
    return refuse("POLICY_RISK_RECORD_INVALID");
  }
  return buildPolicyRiskRecord(value);
}

export function selectCurrentPolicyRiskRecord(
  records: readonly Readonly<PolicyRiskRecord>[],
): PolicyRiskSelection {
  if (records.length === 0) return Object.freeze({ ok: true as const, record: null });
  const revisions = new Set<number>();
  let current: Readonly<PolicyRiskRecord> | undefined;
  for (const record of records) {
    if (revisions.has(record.subjectRevision)) return refuse("POLICY_RISK_RECORD_CONFLICT");
    revisions.add(record.subjectRevision);
    if (current === undefined || record.subjectRevision > current.subjectRevision) current = record;
  }
  return Object.freeze({ ok: true as const, record: current ?? null });
}

export function policyRiskAggregateIdFor(
  input: Pick<PolicyRiskRecord, "actionKind" | "projectId" | "subjectRef">,
): string {
  const preimage = `${AGGREGATE_DOMAIN}\0${JSON.stringify([
    input.projectId, input.actionKind, input.subjectRef,
  ])}`;
  const digest = createHash("sha256").update(preimage, "utf8").digest("hex");
  return `policy-risk:sha256:${digest}`;
}
