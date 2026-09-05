import { createHash } from "node:crypto";

import { ACTIVATION_GENERATION_KEYS } from "@moe/benchmark";
import type { ActivationBinding, ActivationGenerationKey } from "@moe/benchmark";
import { RUNTIME_LIFECYCLES, decodeBoundedJsonBytes } from "@moe/contracts";
import type { CutoverCommand, CutoverCommandKind } from "@moe/core";
import type {
  CommandDecisionKey,
  CommandDecisionRecord,
  CommandDecisionResponse,
  CommitExpectedVersionDecisionInput,
  DurableStoreErrorCode,
  StoredEvent,
} from "@moe/store";

export const CUTOVER_ATTEMPT_LAYER = "DAEMON_CUTOVER_ATTEMPT" as const;
export const CUTOVER_ATTEMPT_EVENT_TYPE = "CutoverAttemptCommandApplied" as const;
export const CUTOVER_ATTEMPT_COMMAND_KIND = "cutover.admit_activate_approval" as const;

export const CUTOVER_ATTEMPT_CODES = Object.freeze([
  "CUTOVER_ATTEMPT_STATE_ABSENT",
  "CUTOVER_ATTEMPT_EVIDENCE_UNREADABLE",
  "CUTOVER_ATTEMPT_SEQUENCE_INVALID",
  "CUTOVER_ATTEMPT_EVENT_TYPE_UNEXPECTED",
  "CUTOVER_ATTEMPT_VERSION_DESYNC",
  "CUTOVER_ATTEMPT_EXPECTED_VERSION_CONFLICT",
  "CUTOVER_ATTEMPT_STORE_UNAVAILABLE",
  "CUTOVER_ATTEMPT_FIELD_INVALID",
  "CUTOVER_ATTEMPT_REPLAY_DIVERGED",
] as const);

export type CutoverAttemptCode = (typeof CUTOVER_ATTEMPT_CODES)[number];

export interface CutoverAttemptStore {
  commitExpectedVersionDecision(input: CommitExpectedVersionDecisionInput): CommandDecisionResponse;
  getCommandDecision(key: CommandDecisionKey): CommandDecisionRecord | null;
  readEvents(aggregateId: string): readonly StoredEvent[];
}

export interface CutoverAttemptAdmittedRecord {
  readonly generations: Readonly<Record<ActivationGenerationKey, string>>;
  readonly grantedAtEpochMs: number;
  readonly principalId: string;
  readonly sourceCommit: string;
}

export interface CutoverAttemptEventPayload {
  readonly admitted: CutoverAttemptAdmittedRecord | null;
  readonly command: CutoverCommand;
}

export interface CutoverAttemptRefusal {
  readonly code: CutoverAttemptCode;
  readonly layer: typeof CUTOVER_ATTEMPT_LAYER;
  readonly ok: false;
  readonly storeCode: DurableStoreErrorCode | null;
}

export type CutoverAttemptDecodeResult =
  | { readonly ok: true; readonly value: CutoverAttemptEventPayload }
  | CutoverAttemptRefusal;

const AGGREGATE_NAMESPACE = "cutover-attempt.v1|aggregate|";
const MAX_STORE_IDENTIFIER_UTF8_BYTES = 512;
const REF = /^[A-Za-z0-9._:/-]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const TRUTH_CLASSES: ReadonlySet<string> = new Set(RUNTIME_LIFECYCLES.TRUTH_CLASS);
const EVENT_KEYS = ["admitted", "command"] as const;
const ADMITTED_KEYS = ["generations", "grantedAtEpochMs", "principalId", "sourceCommit"] as const;

export function cutoverAttemptRefusal(
  code: CutoverAttemptCode,
  storeCode: DurableStoreErrorCode | null = null,
): CutoverAttemptRefusal {
  return Object.freeze({ code, layer: CUTOVER_ATTEMPT_LAYER, ok: false as const, storeCode });
}

export function deriveCutoverAttemptAggregateId(projectId: string): string {
  const legacy = `${AGGREGATE_NAMESPACE}${projectId.length}:${projectId}`;
  if (Buffer.byteLength(legacy, "utf8") <= MAX_STORE_IDENTIFIER_UTF8_BYTES) return legacy;
  const digest = createHash("sha256").update(legacy, "utf8").digest("hex");
  return `${AGGREGATE_NAMESPACE}sha256:${digest}`;
}

export function deriveCutoverDecisionId(binding: ActivationBinding): string {
  const grant = binding.authority.grant;
  const canonical = {
    decision: binding.decision,
    grant: grant === null ? null : {
      gateId: grant.gateId,
      grantedAtEpochMs: grant.grantedAtEpochMs,
      principalId: grant.principalId,
      principalKind: grant.principalKind,
      workRef: grant.workRef,
    },
    generations: ACTIVATION_GENERATION_KEYS.map((key) => [key, binding.generations[key]]),
    sourceCommit: binding.sourceCommit,
  };
  return createHash("sha256").update(canonicalJson(canonical), "utf8").digest("hex");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const members = Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function encodeCutoverAttemptEvent(value: CutoverAttemptEventPayload): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

const COMMAND_KEYS: Readonly<Record<CutoverCommandKind, readonly string[]>> = Object.freeze({
  "cutover.abort": ["commandId", "expectedVersion", "kind", "witness"],
  "cutover.activate": ["commandId", "expectedVersion", "kind"],
  "cutover.admit_activate_approval": ["commandId", "expectedVersion", "kind", "witness"],
  "cutover.admit_quiesce_approval": ["commandId", "expectedVersion", "kind", "witness"],
  "cutover.begin_quiesce": ["commandId", "expectedVersion", "kind"],
  "cutover.complete_quiesce": ["commandId", "expectedVersion", "kind", "witness"],
  "cutover.preview": ["attemptId", "commandId", "expectedVersion", "kind", "sourceManifestRef", "witness"],
  "cutover.verify_import": ["commandId", "expectedVersion", "kind", "witness"],
});

const WITNESS_KEYS: Readonly<Record<CutoverCommandKind, readonly string[]>> = Object.freeze({
  "cutover.abort": ["legacyUnfrozenRef", "truthClass"],
  "cutover.activate": [],
  "cutover.admit_activate_approval": ["approvalRef", "truthClass"],
  "cutover.admit_quiesce_approval": ["approvalRef", "truthClass"],
  "cutover.begin_quiesce": [],
  "cutover.complete_quiesce": ["identicalManifestRef", "truthClass", "writeLockRef"],
  "cutover.preview": ["inventoryRef", "truthClass"],
  "cutover.verify_import": ["importHeadRef", "restoreDrillRef", "truthClass"],
});

function validWitness(kind: CutoverCommandKind, value: unknown): boolean {
  if (!Object.hasOwn(WITNESS_KEYS, kind)) return false;
  const keys = WITNESS_KEYS[kind];
  if (keys.length === 0) return value === undefined;
  if (!exact(value, keys)) return false;
  return keys.every((key) => key === "truthClass"
    ? typeof value[key] === "string" && TRUTH_CLASSES.has(value[key])
    : typeof value[key] === "string" && REF.test(value[key]));
}

function validCommand(value: unknown): value is CutoverCommand {
  if (!isRecord(value) || typeof value["kind"] !== "string") return false;
  // Own keys only: a stored kind of `constructor` or `hasOwnProperty` resolved to an inherited
  // function through the bare lookup, and the decoder THREW from `keys.every` instead of
  // refusing — a tampered store row answered 500 on cutover.activate instead of UNREADABLE.
  const kind = value["kind"] as CutoverCommandKind;
  if (!Object.hasOwn(COMMAND_KEYS, kind)) return false;
  const keys = COMMAND_KEYS[kind];
  if (!exact(value, keys)) return false;
  if (typeof value["commandId"] !== "string" || !REF.test(value["commandId"])) return false;
  const version = value["expectedVersion"];
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) return false;
  if (!validWitness(kind, value["witness"])) return false;
  return kind !== "cutover.preview" || (
    typeof value["attemptId"] === "string" && REF.test(value["attemptId"])
    && typeof value["sourceManifestRef"] === "string" && REF.test(value["sourceManifestRef"])
  );
}

function validAdmitted(value: unknown): value is CutoverAttemptAdmittedRecord {
  if (!exact(value, ADMITTED_KEYS)) return false;
  if (typeof value["principalId"] !== "string" || value["principalId"].length === 0) return false;
  const moment = value["grantedAtEpochMs"];
  if (typeof moment !== "number" || !Number.isSafeInteger(moment) || moment < 0) return false;
  if (typeof value["sourceCommit"] !== "string" || !HEX40.test(value["sourceCommit"])) return false;
  const generations = value["generations"];
  return exact(generations, ACTIVATION_GENERATION_KEYS)
    && ACTIVATION_GENERATION_KEYS.every((key) =>
      typeof generations[key] === "string" && HEX64.test(generations[key]));
}

export function decodeCutoverAttemptEvent(bytes: unknown): CutoverAttemptDecodeResult {
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok || !exact(decoded.value, EVENT_KEYS)) {
    return cutoverAttemptRefusal("CUTOVER_ATTEMPT_EVIDENCE_UNREADABLE");
  }
  if (decoded.value["admitted"] !== null && !validAdmitted(decoded.value["admitted"])) {
    return cutoverAttemptRefusal("CUTOVER_ATTEMPT_EVIDENCE_UNREADABLE");
  }
  if (!validCommand(decoded.value["command"])) {
    return cutoverAttemptRefusal("CUTOVER_ATTEMPT_EVIDENCE_UNREADABLE");
  }
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      admitted: decoded.value["admitted"] as CutoverAttemptAdmittedRecord | null,
      command: decoded.value["command"],
    }),
  });
}
