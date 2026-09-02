import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";
export const DAEMON_POLICY_WAIVER = "DAEMON_POLICY_WAIVER" as const;
export const POLICY_WAIVER_EVENT_TYPES = Object.freeze([
  "PolicyWaiverGranted.v1", "PolicyWaiverRevoked.v1"] as const);
export const POLICY_WAIVER_GRANTED_KEYS = Object.freeze([
  "actionKind", "approvedAt", "approvedBy", "commandId", "decisionReason",
  "expiresAtEpochMs", "humanApprovalRef", "namedObligationId", "policyRevisionRef",
  "projectId", "scope", "stepUpAuthRef", "supersedesWaiverRef", "waiverRef",
] as const);
export const POLICY_WAIVER_REVOKED_KEYS = Object.freeze([
  "actionKind", "approvedAt", "approvedBy", "commandId", "decisionReason",
  "humanApprovalRef", "namedObligationId", "policyRevisionRef", "projectId",
  "scope", "stepUpAuthRef", "revokedWaiverRef",
] as const);
export const POLICY_WAIVER_RECORD_CODES = Object.freeze([
  "POLICY_WAIVER_RECORD_INVALID", "POLICY_WAIVER_RECORD_UNREADABLE",
  "POLICY_WAIVER_RECORD_CONFLICT",
] as const);
export const POLICY_WAIVER_READER_CODES = Object.freeze([
  "POLICY_WAIVER_RECORD_MISSING", "POLICY_WAIVER_RECORD_UNREADABLE",
  "POLICY_WAIVER_EXPIRED", "POLICY_WAIVER_REVOKED", "POLICY_WAIVER_SUPERSEDED",
  "POLICY_WAIVER_PROJECT_FOREIGN", "POLICY_WAIVER_PRINCIPAL_FOREIGN",
  "POLICY_WAIVER_ACTION_FOREIGN", "POLICY_WAIVER_POLICY_STALE",
  "POLICY_WAIVER_OBLIGATION_FOREIGN", "POLICY_WAIVER_SCOPE_FOREIGN",
  "POLICY_WAIVER_NOT_SOFT",
] as const);
export const POLICY_WAIVER_WRITER_CODES = Object.freeze([
  "POLICY_WAIVER_EXPECTED_VERSION_CONFLICT",
] as const);
export type PolicyWaiverEventType = (typeof POLICY_WAIVER_EVENT_TYPES)[number];
export type PolicyWaiverRecordCode = (typeof POLICY_WAIVER_RECORD_CODES)[number];
export type PolicyWaiverReaderCode = (typeof POLICY_WAIVER_READER_CODES)[number];
export type PolicyWaiverWriterCode = (typeof POLICY_WAIVER_WRITER_CODES)[number];
export type PolicyWaiverRefusalCode = PolicyWaiverRecordCode | PolicyWaiverReaderCode | PolicyWaiverWriterCode;
interface PolicyWaiverCommonInput {
  actionKind: string; approvedAt: string; approvedBy: string;
  commandId: string; decisionReason: string; namedObligationId: string;
  policyRevisionRef: string; projectId: string; scope: readonly string[]; stepUpAuthRef: string;
}
export interface PolicyWaiverGrantInput extends PolicyWaiverCommonInput {
  expiresAtEpochMs: number; supersedesWaiverRef: string | null;
}
export interface PolicyWaiverRevokeInput extends PolicyWaiverCommonInput {
  revokedWaiverRef: string;
}
export type PolicyWaiverGrantRecord = Readonly<PolicyWaiverGrantInput & {
  humanApprovalRef: string; waiverRef: string;
}>;
export type PolicyWaiverRevokeRecord = Readonly<PolicyWaiverRevokeInput & { humanApprovalRef: string }>;
export type PolicyWaiverRecord = PolicyWaiverGrantRecord | PolicyWaiverRevokeRecord;
export type PolicyWaiverRefusal<Code extends PolicyWaiverRefusalCode = PolicyWaiverRecordCode> =
  Readonly<{ readonly code: Code; readonly layer: typeof DAEMON_POLICY_WAIVER; readonly ok: false }>;
export type PolicyWaiverAccepted<Record extends PolicyWaiverRecord = PolicyWaiverRecord,
  Event extends PolicyWaiverEventType = PolicyWaiverEventType> = Readonly<{
  readonly bytes: Uint8Array;
  readonly eventType: Event; readonly ok: true;
  readonly record: Readonly<Record>;
}>;
export type PolicyWaiverRecordResult<Record extends PolicyWaiverRecord = PolicyWaiverRecord,
  Event extends PolicyWaiverEventType = PolicyWaiverEventType> = PolicyWaiverAccepted<Record, Event> | PolicyWaiverRefusal;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_REF_BYTES = 512, MAX_COMMAND_ID_BYTES = 489; // Reserves `-` plus either exact v1 event type.
const MAX_REASON_BYTES = 2_048;
const MAX_SCOPE_ITEMS = 64;
const DAY_MS = 86_400_000;
// Contract-A domains intentionally end in the two canonical characters `\` and `0`.
const HUMAN_DOMAIN = "moe.policy-waiver.human-approval.v1\\0";
const AUTHORITY_DOMAIN = "moe.policy-waiver.authority.v1\\0";
const AGGREGATE_DOMAIN = "moe.policy-waiver.aggregate.v1\\0";
export function policyWaiverRefusal<Code extends PolicyWaiverRefusalCode>(
  code: Code,
): PolicyWaiverRefusal<Code> {
  return Object.freeze({ code, layer: DAEMON_POLICY_WAIVER, ok: false as const });
}
function refuse(code: PolicyWaiverRecordCode): PolicyWaiverRefusal {
  return policyWaiverRefusal(code);
}
export function snapshotPolicyWaiverFields(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value) || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some((key) =>
      typeof key !== "string" || !keys.includes(key))) return null;
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}
function boundedString(value: unknown, maxBytes = MAX_REF_BYTES): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value
    && value.isWellFormed() && value.normalize("NFC") === value && !value.includes("\0")
    && encoder.encode(value).byteLength <= maxBytes;
}
function instant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) && new Date(epochMs).toISOString() === value;
}
function scopeSnapshot(value: unknown): readonly string[] | null {
  try {
    if (nodeTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, "length");
    const keys = Reflect.ownKeys(value);
    if (length === undefined || !("value" in length) || length.value < 1
      || length.value > MAX_SCOPE_ITEMS || keys.length !== length.value + 1) return null;
    const copy: string[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
        || !boundedString(descriptor.value)) return null;
      const item = descriptor.value;
      if (index > 0 && copy[index - 1]! >= item) return null;
      copy.push(item);
    }
    return Object.freeze(copy);
  } catch { return null; }
}
function common(input: Record<string, unknown>): Omit<PolicyWaiverCommonInput, "scope"> & {
  readonly scope: readonly string[];
} | null {
  const scope = scopeSnapshot(input["scope"]);
  const refs = ["actionKind", "approvedBy", "namedObligationId", "policyRevisionRef", "projectId", "stepUpAuthRef"] as const;
  if (scope === null || !instant(input["approvedAt"])
    || !boundedString(input["decisionReason"], MAX_REASON_BYTES)
    || !boundedString(input["commandId"], MAX_COMMAND_ID_BYTES) || input["commandId"].startsWith("moe-internal:")
    || refs.some((key) => !boundedString(input[key]))) return null;
  return {
    actionKind: input["actionKind"] as string, approvedAt: input["approvedAt"],
    approvedBy: input["approvedBy"] as string, commandId: input["commandId"] as string,
    decisionReason: input["decisionReason"], namedObligationId: input["namedObligationId"] as string,
    policyRevisionRef: input["policyRevisionRef"] as string, projectId: input["projectId"] as string,
    scope, stepUpAuthRef: input["stepUpAuthRef"] as string,
  };
}
function digest(domain: string, tuple: readonly unknown[]): string {
  return createHash("sha256").update(domain + JSON.stringify(tuple), "utf8").digest("hex");
}
function humanRef(eventType: PolicyWaiverEventType, value: PolicyWaiverCommonInput & {
  readonly expiresAtEpochMs?: number;
}): string {
  const tuple: unknown[] = [eventType, value.actionKind, value.approvedAt, value.approvedBy,
    value.commandId, value.decisionReason];
  if (eventType === "PolicyWaiverGranted.v1") tuple.push(value.expiresAtEpochMs);
  tuple.push(value.namedObligationId, value.policyRevisionRef, value.projectId,
    value.scope, value.stepUpAuthRef);
  return `approval:policy-waiver:sha256:${digest(HUMAN_DOMAIN, tuple)}`;
}
function waiverRef(value: PolicyWaiverCommonInput, approvalRef: string): string {
  return `policy-waiver:sha256:${digest(AUTHORITY_DOMAIN, [approvalRef, value.projectId,
    value.approvedBy, value.actionKind, value.policyRevisionRef, value.namedObligationId, value.scope])}`;
}
function accepted<Record extends PolicyWaiverRecord, Event extends PolicyWaiverEventType>(
  eventType: Event, record: Readonly<Record>,
): PolicyWaiverAccepted<Record, Event> {
  const canonical = JSON.stringify(record);
  return Object.freeze({ get bytes() { return encoder.encode(canonical); }, eventType, ok: true as const, record });
}
export function buildPolicyWaiverGrant(value: PolicyWaiverGrantInput):
PolicyWaiverRecordResult<PolicyWaiverGrantRecord, "PolicyWaiverGranted.v1"> {
  const raw = snapshotPolicyWaiverFields(value, POLICY_WAIVER_GRANTED_KEYS.filter((key) =>
    key !== "humanApprovalRef" && key !== "waiverRef"));
  if (raw === null) return refuse("POLICY_WAIVER_RECORD_INVALID");
  const base = common(raw);
  const approvedMs = base === null ? NaN : Date.parse(base.approvedAt);
  if (base === null || !Number.isSafeInteger(raw!["expiresAtEpochMs"])
    || Number(raw!["expiresAtEpochMs"]) <= approvedMs
    || Number(raw!["expiresAtEpochMs"]) > approvedMs + DAY_MS
    || !(raw!["supersedesWaiverRef"] === null || boundedString(raw!["supersedesWaiverRef"])))
    return refuse("POLICY_WAIVER_RECORD_INVALID");
  const grant = { ...base, expiresAtEpochMs: raw["expiresAtEpochMs"] as number,
    supersedesWaiverRef: raw["supersedesWaiverRef"] as string | null };
  const humanApprovalRef = humanRef("PolicyWaiverGranted.v1", grant);
  const record = Object.freeze({
    actionKind: grant.actionKind, approvedAt: grant.approvedAt, approvedBy: grant.approvedBy,
    commandId: grant.commandId, decisionReason: grant.decisionReason,
    expiresAtEpochMs: grant.expiresAtEpochMs, humanApprovalRef,
    namedObligationId: grant.namedObligationId, policyRevisionRef: grant.policyRevisionRef,
    projectId: grant.projectId, scope: grant.scope, stepUpAuthRef: grant.stepUpAuthRef,
    supersedesWaiverRef: grant.supersedesWaiverRef, waiverRef: waiverRef(grant, humanApprovalRef),
  });
  return accepted("PolicyWaiverGranted.v1", record);
}
export function buildPolicyWaiverRevoke(value: PolicyWaiverRevokeInput):
PolicyWaiverRecordResult<PolicyWaiverRevokeRecord, "PolicyWaiverRevoked.v1"> {
  const raw = snapshotPolicyWaiverFields(value, POLICY_WAIVER_REVOKED_KEYS.filter((key) => key !== "humanApprovalRef"));
  if (raw === null) return refuse("POLICY_WAIVER_RECORD_INVALID");
  const base = common(raw);
  if (base === null || !boundedString(raw!["revokedWaiverRef"]))
    return refuse("POLICY_WAIVER_RECORD_INVALID");
  const revoke = { ...base, revokedWaiverRef: raw["revokedWaiverRef"] as string };
  const record = Object.freeze({
    actionKind: revoke.actionKind, approvedAt: revoke.approvedAt, approvedBy: revoke.approvedBy,
    commandId: revoke.commandId, decisionReason: revoke.decisionReason,
    humanApprovalRef: humanRef("PolicyWaiverRevoked.v1", revoke),
    namedObligationId: revoke.namedObligationId, policyRevisionRef: revoke.policyRevisionRef,
    projectId: revoke.projectId, scope: revoke.scope, stepUpAuthRef: revoke.stepUpAuthRef,
    revokedWaiverRef: revoke.revokedWaiverRef,
  });
  return accepted("PolicyWaiverRevoked.v1", record);
}
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
export function decodePolicyWaiverRecord(eventType: "PolicyWaiverGranted.v1", bytes: Uint8Array):
PolicyWaiverRecordResult<PolicyWaiverGrantRecord, "PolicyWaiverGranted.v1">;
export function decodePolicyWaiverRecord(eventType: "PolicyWaiverRevoked.v1", bytes: Uint8Array):
PolicyWaiverRecordResult<PolicyWaiverRevokeRecord, "PolicyWaiverRevoked.v1">;
export function decodePolicyWaiverRecord(
  eventType: PolicyWaiverEventType, bytes: Uint8Array,
): PolicyWaiverRecordResult {
  if (!POLICY_WAIVER_EVENT_TYPES.includes(eventType)) return refuse("POLICY_WAIVER_RECORD_UNREADABLE");
  let raw: unknown;
  try { raw = JSON.parse(decoder.decode(bytes)); } catch { return refuse("POLICY_WAIVER_RECORD_UNREADABLE"); }
  const keys = eventType === "PolicyWaiverGranted.v1" ? POLICY_WAIVER_GRANTED_KEYS : POLICY_WAIVER_REVOKED_KEYS;
  const stored = snapshotPolicyWaiverFields(raw, keys);
  if (stored === null) return refuse("POLICY_WAIVER_RECORD_UNREADABLE");
  const semantic = { ...stored };
  delete semantic["humanApprovalRef"];
  delete semantic["waiverRef"];
  const derived = eventType === "PolicyWaiverGranted.v1"
    ? buildPolicyWaiverGrant(semantic as unknown as PolicyWaiverGrantInput)
    : buildPolicyWaiverRevoke(semantic as unknown as PolicyWaiverRevokeInput);
  const derivedWaiverRef = derived.ok && "waiverRef" in derived.record ? derived.record.waiverRef : undefined;
  if (!derived.ok || stored["humanApprovalRef"] !== derived.record.humanApprovalRef
    || (eventType === "PolicyWaiverGranted.v1" && stored["waiverRef"] !== derivedWaiverRef)
    || !bytesEqual(bytes, derived.bytes)) return refuse("POLICY_WAIVER_RECORD_UNREADABLE");
  return derived;
}
export function policyWaiverAggregateIdFor(input: Pick<PolicyWaiverCommonInput,
  "projectId" | "approvedBy" | "actionKind" | "policyRevisionRef">): string {
  return `policy-waiver:aggregate:v1:sha256:${digest(AGGREGATE_DOMAIN,
    [input.projectId, input.approvedBy, input.actionKind, input.policyRevisionRef])}`;
}
type PolicyWaiverTuple = Pick<PolicyWaiverCommonInput, "projectId" | "approvedBy" | "actionKind"
  | "policyRevisionRef" | "namedObligationId" | "scope">;
export function policyWaiverTupleKeyFor(input: PolicyWaiverTuple): string {
  return JSON.stringify([input.projectId, input.approvedBy, input.actionKind,
    input.policyRevisionRef, input.namedObligationId, input.scope]);
}
export function samePolicyWaiverTuple(left: PolicyWaiverTuple, right: PolicyWaiverTuple): boolean {
  return policyWaiverTupleKeyFor(left) === policyWaiverTupleKeyFor(right);
}
