import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, RuntimeCommandKind } from "@moe/contracts";

/**
 * Byte ingress for the durable work-claim family: how an agent takes, keeps,
 * and hands back a unit of board work so two agents never collide on one step.
 *
 * DELIBERATE SCOPE NOTE: this family fences BOARD work items (affordance chain
 * steps and their kin). The four-leg atomic execution claim in `work-claim.ts`
 * (lease + providerSlot + budgetReservation + effectIntent) is a different,
 * stronger authority that the attempt-dispatch tasks will wire; these commands
 * own only the "who is working on what" register. Vocabulary is disjoint from
 * `work-kernel.ts`'s WORK_* codes on purpose.
 */

export const WORK_CLAIM_SCHEMA_VERSION = "moe-work-claim/1" as const;

export const WORK_CLAIM_COMMAND_KINDS = Object.freeze([
  "work.claim",
  "work.release",
  "work.renew",
] as const satisfies readonly RuntimeCommandKind[]);

export type WorkClaimCommandKind = (typeof WORK_CLAIM_COMMAND_KINDS)[number];

export const WORK_CLAIM_REQUEST_KEYS = Object.freeze([
  "commandId",
  "correlationId",
  "decidedAt",
  "expectedVersion",
  "kind",
  "payload",
  "principalId",
  "projectId",
  "schemaVersion",
] as const);

export const WORK_CLAIM_INGRESS_REFUSAL_CODES = Object.freeze([
  "WORK_CLAIM_INPUT_REJECTED",
  "WORK_CLAIM_REQUEST_INVALID",
  "WORK_CLAIM_COMMAND_UNKNOWN",
  "WORK_CLAIM_PAYLOAD_INVALID",
] as const);

export type WorkClaimIngressRefusalCode = (typeof WORK_CLAIM_INGRESS_REFUSAL_CODES)[number];

export const WORK_CLAIM_PREREQUISITE_REFUSAL_CODES = Object.freeze([
  "WORK_CLAIM_COMMAND_ID_REUSED",
  "WORK_CLAIM_HELD",
  "WORK_CLAIM_NOT_FOUND",
  "WORK_CLAIM_NOT_CLAIMANT",
  "WORK_CLAIM_LEDGER_UNREADABLE",
] as const);

export type WorkClaimPrerequisiteRefusalCode =
  (typeof WORK_CLAIM_PREREQUISITE_REFUSAL_CODES)[number];

export const WORK_CLAIM_REFUSED_BY = Object.freeze([
  "DAEMON_INGRESS",
  "DAEMON_PREREQUISITE",
  "DURABLE_STORE",
] as const);

export type WorkClaimRefusedBy = (typeof WORK_CLAIM_REFUSED_BY)[number];

export interface WorkClaimRequest {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly expectedVersion: number;
  readonly kind: WorkClaimCommandKind;
  readonly payload: JsonObject;
  readonly principalId: string;
  readonly projectId: string;
  readonly schemaVersion: typeof WORK_CLAIM_SCHEMA_VERSION;
}

export type WorkClaimDecodeResult =
  | { readonly code: WorkClaimIngressRefusalCode; readonly ok: false }
  | { readonly ok: true; readonly request: WorkClaimRequest };

const KIND_SET: ReadonlySet<string> = new Set(WORK_CLAIM_COMMAND_KINDS);
const KEY_SET: ReadonlySet<string> = new Set(WORK_CLAIM_REQUEST_KEYS);

const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function isIsoInstant(value: unknown): value is string {
  return typeof value === "string" && ISO_INSTANT.test(value)
    && !Number.isNaN(Date.parse(value));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function decodeWorkClaimRequestBytes(input: unknown): WorkClaimDecodeResult {
  const decoded = decodeBoundedJsonBytes(input as Uint8Array);
  if (!decoded.ok) return { code: "WORK_CLAIM_INPUT_REJECTED", ok: false };
  const value = decoded.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { code: "WORK_CLAIM_REQUEST_INVALID", ok: false };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== WORK_CLAIM_REQUEST_KEYS.length || !keys.every((key) => KEY_SET.has(key))) {
    return { code: "WORK_CLAIM_REQUEST_INVALID", ok: false };
  }
  const kind = record["kind"];
  if (typeof kind !== "string" || !KIND_SET.has(kind)) {
    return { code: "WORK_CLAIM_COMMAND_UNKNOWN", ok: false };
  }
  const payload = record["payload"];
  if (
    !nonEmpty(record["commandId"]) || !nonEmpty(record["correlationId"])
    || !isIsoInstant(record["decidedAt"])
    || typeof record["expectedVersion"] !== "number"
    || !Number.isSafeInteger(record["expectedVersion"]) || record["expectedVersion"] < 0
    || typeof payload !== "object" || payload === null || Array.isArray(payload)
    || !nonEmpty(record["principalId"]) || !nonEmpty(record["projectId"])
    || record["schemaVersion"] !== WORK_CLAIM_SCHEMA_VERSION
  ) {
    return { code: "WORK_CLAIM_REQUEST_INVALID", ok: false };
  }
  return {
    ok: true,
    request: Object.freeze({
      commandId: record["commandId"] as string,
      correlationId: record["correlationId"] as string,
      decidedAt: record["decidedAt"] as string,
      expectedVersion: record["expectedVersion"],
      kind: kind as WorkClaimCommandKind,
      payload: payload as JsonObject,
      principalId: record["principalId"] as string,
      projectId: record["projectId"] as string,
      schemaVersion: WORK_CLAIM_SCHEMA_VERSION,
    }),
  };
}
