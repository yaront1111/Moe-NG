import { createHash } from "node:crypto";
import { PROJECT_CONFIGURATION_SCHEMA_VERSION, isLogicalRef } from "@moe/contracts";
import type { ProjectConfigurationManifest } from "@moe/contracts";
import { decodeProjectConfigurationManifestBytes } from "@moe/core";
import { DurableStoreError } from "@moe/store";
import type { CommandDecisionRecord, CommandDecisionResponse, CommandReceipt,
  CommitExpectedVersionDecisionInput, CursorPage, StoredEvent } from "@moe/store";
export const PROJECT_CONFIGURATION_SELECTION_CODES = Object.freeze(["PROJECT_CONFIGURATION_ABSENT", "PROJECT_CONFIGURATION_STALE", "PROJECT_CONFIGURATION_CONFLICT", "PROJECT_CONFIGURATION_UNREADABLE"] as const);
export const PROJECT_CONFIGURATION_SELECTION_LAYER = "PROJECT_CONFIGURATION_SELECTION" as const;
export type ProjectConfigurationSelectionCode = (typeof PROJECT_CONFIGURATION_SELECTION_CODES)[number];
export type ProjectConfigurationSelectionUpstream = Readonly<{ code: string; layer: string }>;
export interface ProjectConfigurationSelectionUnknown {
  readonly authority: "NONE"; readonly code: ProjectConfigurationSelectionCode;
  readonly layer: typeof PROJECT_CONFIGURATION_SELECTION_LAYER; readonly ok: false;
  readonly outcome: "UNKNOWN"; readonly upstream: ProjectConfigurationSelectionUpstream | null;
}
export interface CurrentProjectConfiguration {
  readonly authority: "DAEMON_VERIFIED"; readonly evidence: "DURABLE";
  readonly manifest: ProjectConfigurationManifest; readonly manifestBytes: Uint8Array;
  readonly ok: true; readonly outcome: "CURRENT"; readonly selectionVersion: number;
}
export interface SelectedProjectConfiguration extends Omit<CurrentProjectConfiguration, "outcome"> {
  readonly outcome: "SELECTED";
}
export type ReadCurrentProjectConfigurationResult = CurrentProjectConfiguration | ProjectConfigurationSelectionUnknown;
export type SelectProjectConfigurationResult = SelectedProjectConfiguration | ProjectConfigurationSelectionUnknown;
export interface ProjectConfigurationStore {
  commitExpectedVersionDecision(input: CommitExpectedVersionDecisionInput): CommandDecisionResponse;
  getAggregateVersion(aggregateId: string): number;
  getCommandDecision(key: Readonly<{ commandId: string; principalId: string; projectId: string }>): CommandDecisionRecord | null;
  getCommandReceipt(commandId: string): CommandReceipt | null;
  readAggregateEvents(aggregateId: string, after: number, limit: number): CursorPage<StoredEvent, number>;
}
const EVENT_TYPE = "ProjectConfigurationSelected", COMMAND_KIND = "project-configuration.select";
const TAIL_ATTEMPTS = 3, HEX64 = /^[0-9a-f]{64}$/u;
const PAGE_KEYS = ["hasMore", "items", "nextCursor"] as const;
const EVENT_KEYS = ["aggregateId", "aggregateSequence", "commandId", "committedAt", "decisionTrace", "domainSchemaVersion", "eventId", "eventType", "globalPosition", "metadata", "payload", "payloadCodecVersion", "recordVersion", "requestSha256"] as const;
const TRACE_KEYS = ["commandId", "commandKind", "principalId", "projectId", "requestIdentityVersion", "requestSha256"] as const;
const DECISION_KEYS = ["auditEventId", "businessEventIds", "commandKind", "correlationSha256", "coverage", "currentVersion", "decidedAt", "decisionId", "decisionIdentityVersion", "decisionPosition", "decisionSha256", "effectDisposition", "effectIdentityVersion", "effectSha256", "expectedVersion", "key", "observedVersion", "outboxMessageIds", "previousVersion", "recordVersion", "requestIdentityVersion", "requestSha256", "resultBytes", "resultCode", "resultSha256", "resultVersion", "targetAggregateId"] as const;
const KEY_KEYS = ["commandId", "principalId", "projectId"] as const;
const RECEIPT_KEYS = ["aggregateId", "commandId", "committedAt", "currentVersion", "effectIdentityVersion", "effectSha256", "eventIds", "outboxMessageIds", "previousVersion", "requestSha256"] as const;
const SELECT_KEYS = ["projectId", "commandId", "correlationId", "decidedAt", "principalId", "expectedVersion", "manifestBytes"] as const;
const RESPONSE_KEYS = ["decision", "disposition", "historical", "requiresAffordanceRefresh"] as const;
const ENCODER = new TextEncoder();
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key))) {
    return null;
  }
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}
function exactArray(value: unknown): readonly unknown[] | null {
  if (!Array.isArray(value)) return null;
  const length = Reflect.getOwnPropertyDescriptor(value, "length")?.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length)
    || length < 0 || Reflect.ownKeys(value).length !== length + 1) {
    return null;
  }
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    copy.push(descriptor.value);
  }
  return copy;
}
function copyBytes(value: unknown): Uint8Array | null {
  if (!ArrayBuffer.isView(value) || !(value instanceof Uint8Array)) return null;
  if (typeof SharedArrayBuffer !== "undefined" && value.buffer instanceof SharedArrayBuffer) return null;
  return new Uint8Array(value);
}
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
function aggregateId(projectId: string): string {
  return `project-configuration:${createHash("sha256").update(projectId).digest("hex")}`;
}
function refuse(
  code: ProjectConfigurationSelectionCode,
  upstream: ProjectConfigurationSelectionUpstream | null = null,
): ProjectConfigurationSelectionUnknown {
  return Object.freeze({ authority: "NONE", code, layer: PROJECT_CONFIGURATION_SELECTION_LAYER,
    ok: false as const, outcome: "UNKNOWN" as const,
    upstream: upstream === null ? null : Object.freeze({ ...upstream }) });
}
function storeRefusal(error: unknown): ProjectConfigurationSelectionUnknown {
  const code = error instanceof DurableStoreError ? error.code : "STORE_UNAVAILABLE";
  return refuse("PROJECT_CONFIGURATION_UNREADABLE", { code, layer: "DURABLE_STORE" });
}
interface StableEvent { readonly event: Record<string, unknown>; readonly payload: Uint8Array }
function stableTail(store: ProjectConfigurationStore, id: string): StableEvent | "ABSENT" | null {
  for (let attempt = 0; attempt < TAIL_ATTEMPTS; attempt += 1) {
    const before = store.getAggregateVersion(id);
    if (!Number.isSafeInteger(before) || before < 0) continue;
    if (before === 0) {
      if (store.getAggregateVersion(id) === 0) return "ABSENT";
      continue;
    }
    const page = exactRecord(store.readAggregateEvents(id, before - 1, 1), PAGE_KEYS);
    const items = page === null ? null : exactArray(page.items);
    const event = items?.length === 1 ? exactRecord(items[0], EVENT_KEYS) : null;
    const payload = event === null ? null : copyBytes(event.payload);
    const after = store.getAggregateVersion(id);
    if (page !== null && items !== null && event !== null && payload !== null
      && page.hasMore === false && page.nextCursor === before
      && event.aggregateSequence === before && after === before) return { event, payload };
  }
  return null;
}
function validateDecision(
  store: ProjectConfigurationStore, tail: StableEvent, id: string, projectId: string,
): { readonly decision: Record<string, unknown>; readonly version: number } | "MISSING" | null {
  const event = tail.event;
  const trace = exactRecord(event.decisionTrace, TRACE_KEYS);
  if (trace === null || trace.projectId !== projectId || trace.commandKind !== COMMAND_KIND
    || typeof trace.commandId !== "string" || typeof trace.principalId !== "string") return null;
  const loaded = store.getCommandDecision({ commandId: trace.commandId,
    principalId: trace.principalId, projectId });
  if (loaded === null) return "MISSING";
  const decision = exactRecord(loaded, DECISION_KEYS);
  const key = decision === null ? null : exactRecord(decision.key, KEY_KEYS);
  const events = decision === null ? null : exactArray(decision.businessEventIds);
  const result = decision === null ? null : copyBytes(decision.resultBytes);
  const version = event.aggregateSequence;
  if (decision === null || key === null || events === null || result === null
    || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1
    || decision.effectDisposition !== "EFFECTS_COMMITTED"
    || decision.resultCode !== "EFFECTS_COMMITTED" || decision.targetAggregateId !== id
    || decision.currentVersion !== version || decision.previousVersion !== version - 1
    || decision.expectedVersion !== version - 1 || key.commandId !== trace.commandId
    || key.principalId !== trace.principalId || key.projectId !== projectId
    || events.length !== 1 || events[0] !== event.eventId || decision.requestSha256 !== trace.requestSha256
    || !sameBytes(result, tail.payload)
    || event.commandId !== `moe-internal:decision-effect:${String(decision.decisionId)}`) return null;
  return { decision, version: version as number };
}
function validReceipt(
  store: ProjectConfigurationStore, tail: StableEvent, id: string, version: number,
): "MISSING" | boolean {
  const event = tail.event;
  const loaded = store.getCommandReceipt(String(event.commandId));
  if (loaded === null) return "MISSING";
  const receipt = exactRecord(loaded, RECEIPT_KEYS);
  const eventIds = receipt === null ? null : exactArray(receipt.eventIds);
  return receipt !== null && eventIds !== null && receipt.aggregateId === id
    && receipt.commandId === event.commandId && receipt.currentVersion === version
    && receipt.previousVersion === version - 1 && receipt.requestSha256 === event.requestSha256
    && eventIds.length === 1 && eventIds[0] === event.eventId;
}
function readCurrent(
  store: ProjectConfigurationStore, projectId: string, expectedSettingsDigest: string,
): ReadCurrentProjectConfigurationResult {
  const id = aggregateId(projectId);
  const tail = stableTail(store, id);
  if (tail === "ABSENT") return refuse("PROJECT_CONFIGURATION_ABSENT");
  if (tail === null) return refuse("PROJECT_CONFIGURATION_CONFLICT");
  if (tail.event.aggregateId !== id || tail.event.eventType !== EVENT_TYPE
    || tail.event.domainSchemaVersion !== PROJECT_CONFIGURATION_SCHEMA_VERSION) {
    return refuse("PROJECT_CONFIGURATION_CONFLICT");
  }
  const validated = validateDecision(store, tail, id, projectId);
  if (validated === "MISSING") return refuse("PROJECT_CONFIGURATION_UNREADABLE");
  if (validated === null) return refuse("PROJECT_CONFIGURATION_CONFLICT");
  const receipt = validReceipt(store, tail, id, validated.version);
  if (receipt === "MISSING") return refuse("PROJECT_CONFIGURATION_UNREADABLE");
  if (!receipt) return refuse("PROJECT_CONFIGURATION_CONFLICT");
  const decoded = decodeProjectConfigurationManifestBytes(tail.payload);
  if (!decoded.ok) return refuse("PROJECT_CONFIGURATION_UNREADABLE",
    { code: decoded.code, layer: decoded.layer });
  if (decoded.manifest.projectId !== projectId) return refuse("PROJECT_CONFIGURATION_CONFLICT");
  if (decoded.manifest.settingsDigest !== expectedSettingsDigest) {
    return refuse("PROJECT_CONFIGURATION_STALE");
  }
  return Object.freeze({ authority: "DAEMON_VERIFIED" as const, evidence: "DURABLE" as const,
    manifest: decoded.manifest, manifestBytes: new Uint8Array(tail.payload), ok: true as const,
    outcome: "CURRENT" as const, selectionVersion: validated.version });
}
export function readCurrentProjectConfiguration(
  store: ProjectConfigurationStore, input: unknown,
): ReadCurrentProjectConfigurationResult {
  try {
    const request = exactRecord(input, ["projectId", "expectedSettingsDigest"]);
    if (request === null || !isLogicalRef(request.projectId)
      || typeof request.expectedSettingsDigest !== "string"
      || !HEX64.test(request.expectedSettingsDigest)) return refuse("PROJECT_CONFIGURATION_UNREADABLE");
    return readCurrent(store, request.projectId, request.expectedSettingsDigest);
  } catch (error) {
    return storeRefusal(error);
  }
}
/**
 * Current means the latest decision-backed event at one stable aggregate tail.
 * `settingsDigest` is a currentness expectation; its own preimage excludes it by manifest shape.
 */
export function selectProjectConfiguration(
  store: ProjectConfigurationStore, input: unknown,
): SelectProjectConfigurationResult {
  try {
    const request = exactRecord(input, SELECT_KEYS);
    const bytes = request === null ? null : copyBytes(request.manifestBytes);
    if (request === null || bytes === null || !isLogicalRef(request.projectId)
      || !isLogicalRef(request.commandId) || !isLogicalRef(request.correlationId)
      || !isLogicalRef(request.principalId) || typeof request.decidedAt !== "string"
      || !Number.isFinite(Date.parse(request.decidedAt)) || typeof request.expectedVersion !== "number"
      || !Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 0) {
      return refuse("PROJECT_CONFIGURATION_UNREADABLE");
    }
    const decoded = decodeProjectConfigurationManifestBytes(bytes);
    if (!decoded.ok) return refuse("PROJECT_CONFIGURATION_UNREADABLE",
      { code: decoded.code, layer: decoded.layer });
    if (decoded.manifest.projectId !== request.projectId) return refuse("PROJECT_CONFIGURATION_CONFLICT");
    const id = aggregateId(request.projectId);
    const eventId = `project-configuration-selected:${createHash("sha256")
      .update(`${request.projectId}\0${request.commandId}`).digest("hex")}`;
    const requestBytes = ENCODER.encode(JSON.stringify({ ...request, manifestBytes: [...bytes] }));
    const response = exactRecord(store.commitExpectedVersionDecision({ commandKind: COMMAND_KIND,
      committedResultBytes: bytes, correlationId: request.correlationId, decidedAt: request.decidedAt,
      events: [{ domainSchemaVersion: PROJECT_CONFIGURATION_SCHEMA_VERSION, eventId,
        eventType: EVENT_TYPE, payload: bytes }], expectedVersion: request.expectedVersion,
      key: { commandId: request.commandId, principalId: request.principalId,
        projectId: request.projectId }, requestBytes, targetAggregateId: id }), RESPONSE_KEYS);
    const decision = response === null ? null : exactRecord(response.decision, DECISION_KEYS);
    if (response === null || decision === null) return refuse("PROJECT_CONFIGURATION_CONFLICT");
    if (decision.resultCode === "EXPECTED_VERSION_CONFLICT") return refuse(
      "PROJECT_CONFIGURATION_STALE", { code: "EXPECTED_VERSION_CONFLICT", layer: "DURABLE_STORE" });
    if (decision.resultCode !== "EFFECTS_COMMITTED") return refuse("PROJECT_CONFIGURATION_CONFLICT");
    const current = readCurrentProjectConfiguration(store, { projectId: request.projectId,
      expectedSettingsDigest: decoded.manifest.settingsDigest });
    return current.ok ? Object.freeze({ ...current, outcome: "SELECTED" as const }) : current;
  } catch (error) {
    if (!(error instanceof DurableStoreError)) return storeRefusal(error);
    const conflicts = ["COMMAND_ID_CONFLICT", "DURABLE_ID_CONFLICT", "IDEMPOTENCY_CONFLICT",
      "PROJECT_SCOPE_MISMATCH"];
    return refuse(conflicts.includes(error.code) ? "PROJECT_CONFIGURATION_CONFLICT"
      : "PROJECT_CONFIGURATION_UNREADABLE", { code: error.code, layer: "DURABLE_STORE" });
  }
}
