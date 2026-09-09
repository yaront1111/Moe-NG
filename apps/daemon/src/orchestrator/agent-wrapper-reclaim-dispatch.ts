import { createHash } from "node:crypto";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";

import { handleCommandRequest } from "../http/http-adapter.js";
import type { CommandAdapterDeps } from "../http/http-contract.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";

/**
 * The reclaim pass's command path: the SAME committed adapter call the wrapper
 * makes (agent-wrapper.ts), under the operator credential. No side door — every
 * effect the pass has is one an operator could issue by hand.
 *
 * It differs from the wrapper's own helper in ONE respect, and that difference is
 * the point: it carries `refusal.detail` back to the caller. A conflict refusal
 * names the version the store observed only in that string, and the pass's single
 * retry has nothing to resend at without it.
 */

export interface ReclaimDispatchResult {
  readonly code: string;
  readonly detail: string;
  readonly ok: boolean;
}

export type ReclaimDispatch = (
  kind: string, payload: JsonObject, target: string,
  expectedVersion: number, commandId: string,
) => ReclaimDispatchResult;

interface WireResult {
  readonly decision?: { readonly resultCode: string };
  readonly error?: { readonly code: string };
  readonly ok: boolean;
  readonly outcome: string;
  readonly refusal?: { readonly code: string; readonly detail?: string };
}

const encoder = new TextEncoder();

/** The version a conflict refusal names, so the one retry can resend at it. */
export function actualVersionOf(detail: string): number | null {
  const matched = /(?:^| )actualVersion=(\d+)(?: |$)/u.exec(detail);
  if (matched?.[1] === undefined) return null;
  const parsed = Number(matched[1]);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function createReclaimDispatch(
  deps: CommandAdapterDeps, credential: string, correlationId: string,
): ReclaimDispatch {
  return (kind, payload, target, expectedVersion, commandId): ReclaimDispatchResult => {
    const envelope = {
      commandId,
      commandKind: kind,
      correlationId,
      expectedVersion,
      payload,
      requestDigest: createHash("sha256")
        .update(encoder.encode(JSON.stringify(payload))).digest("hex"),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: credential,
      targetAggregateId: target,
    };
    let result: WireResult;
    try {
      result = handleCommandRequest(deps, {
        body: encoder.encode(JSON.stringify(envelope)),
        credential,
        protocolVersion: WIRE_PROTOCOL_VERSION,
      }, "AGENT_WRAPPER") as WireResult;
    } catch {
      return { code: "COMMAND_DISPATCH_FAILED", detail: "", ok: false };
    }
    if (result.ok) {
      const code = result.decision?.resultCode ?? "ACCEPTED";
      return { code, detail: code, ok: code === "EFFECTS_COMMITTED" };
    }
    const code = result.refusal?.code ?? result.error?.code ?? result.outcome;
    return { code, detail: result.refusal?.detail ?? code, ok: false };
  };
}
