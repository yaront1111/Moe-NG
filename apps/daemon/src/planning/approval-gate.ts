import type { JsonObject, JsonValue } from "@moe/contracts";
import type { HumanAuthorityGate } from "@moe/core";

const IDENTITY_KEY = "workIdentity";
const GATE_KEY = "humanAuthorityGate";
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

interface StoredGate {
  readonly found: boolean;
  readonly value: JsonValue | undefined;
}

export interface ApprovalGateRead {
  readonly gate: HumanAuthorityGate | null;
  readonly status: "ABSENT" | "PRESENT" | "UNREADABLE";
}

export type ApprovalDelayDisposition = "DEFERRED" | "IMMEDIATE" | "REQUIRE_HUMAN";

function objectValue(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined || typeof value !== "object"
    || Array.isArray(value)) return null;
  return value as JsonObject;
}

function storedGate(record: JsonValue | undefined): StoredGate {
  const root = objectValue(record);
  if (root === null || !Object.hasOwn(root, IDENTITY_KEY)) {
    return { found: false, value: undefined };
  }
  const identity = objectValue(root[IDENTITY_KEY]);
  if (identity === null) return { found: true, value: null };
  if (!Object.hasOwn(identity, GATE_KEY)) return { found: false, value: undefined };
  return { found: true, value: identity[GATE_KEY] };
}

function proposalGate(candidate: JsonValue | undefined): JsonValue | undefined {
  if (candidate === undefined) return undefined;
  const gate = objectValue(candidate);
  if (gate === null || typeof gate["gateId"] !== "string"
    || typeof gate["workRef"] !== "string" || gate["grant"] !== null) return null;
  return Object.freeze({ gateId: gate["gateId"], grant: null, workRef: gate["workRef"] });
}

function unreadableGate(workRef: string): HumanAuthorityGate {
  return Object.freeze({
    gateId: `unreadable-approval-gate:${workRef}`,
    grant: null,
    workRef,
  });
}

function decodedGate(value: JsonValue | undefined, workRef: string): HumanAuthorityGate | null {
  const gate = objectValue(value);
  if (gate === null) return null;
  if (typeof gate["gateId"] !== "string" || gate["gateId"].trim().length === 0) return null;
  if (gate["workRef"] !== workRef) return null;
  const grant = gate["grant"];
  if (grant !== null && objectValue(grant) === null) return null;
  return gate as unknown as HumanAuthorityGate;
}

/**
 * Carries a gate on the work's immutable identity envelope while lifecycle state changes below it.
 * A transition may introduce an absent gate, but can never replace or clear an existing slot.
 */
export function persistApprovalGate(
  result: JsonObject,
  prior: JsonValue | undefined,
  candidate: JsonValue | undefined,
): JsonObject {
  const stored = storedGate(prior);
  // Proposal ingress may establish only an unsatisfied gate. A grant requires a future
  // authority-bearing writer; accepting caller-shaped grant bytes here would mint a human.
  const selected = stored.found ? stored.value : proposalGate(candidate);
  if (selected === undefined) return result;
  return Object.freeze({
    ...result,
    workIdentity: Object.freeze({ humanAuthorityGate: selected }),
  });
}

/** Reads the lifecycle slice without granting it ownership of the work-identity envelope. */
export function planningStateFromDurableRecord(record: JsonValue | undefined): JsonValue | undefined {
  const root = objectValue(record);
  return root !== null && Object.hasOwn(root, "state") ? root["state"] : record;
}

/** Distinguishes no gate from corrupt/unverifiable persisted bytes; the latter stays gated. */
export function readApprovalGate(record: JsonValue | undefined, workRef: string): ApprovalGateRead {
  const stored = storedGate(record);
  if (!stored.found) return Object.freeze({ gate: null, status: "ABSENT" as const });
  const gate = decodedGate(stored.value, workRef);
  return gate === null
    ? Object.freeze({ gate: unreadableGate(workRef), status: "UNREADABLE" as const })
    : Object.freeze({ gate, status: "PRESENT" as const });
}

/**
 * Bounds the authority decision before this synchronous daemon path can act on it. There is no
 * timer here: a representable positive delay stays deferred, while a value that `setTimeout`
 * would clamp to 1ms becomes REQUIRE_HUMAN. Neither may fall through to immediate activation.
 */
export function approvalDelayDisposition(delayMs: number): ApprovalDelayDisposition {
  if (delayMs === 0) return "IMMEDIATE";
  return delayMs > MAX_TIMER_DELAY_MS ? "REQUIRE_HUMAN" : "DEFERRED";
}
