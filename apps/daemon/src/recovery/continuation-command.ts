/**
 * The AUTHENTICATED caller of `evaluateContinuationCommandBytes` — the registry
 * edge that was missing, so a continuation decision can be made by command rather
 * than only by a test.
 *
 * `work.resume` is not minted here. `CONTINUATION_COMMAND_KINDS` already declares
 * it and already `satisfies readonly RuntimeCommandKind[]`, so the carrier was
 * decided by the producer and is a member of the frozen runtime union — nothing
 * in this task expands that union.
 *
 * THE REQUEST IS ASSEMBLED, NEVER COPIED. `parseContinuationRequest` demands
 * exactly eight keys, and six of them are server facts: the kind, the schema
 * version, the project, the principal, the correlation and the decision time. Only
 * `attemptRef` and `successorRef` may come from a caller, which is why the
 * registry's payload allow-list is exactly those two — a payload naming a
 * principal is refused at the seam rather than silently overwritten here.
 *
 * THE DISPOSITION IS MEASURED. `evaluateContinuationCommandBytes` answers BOUND
 * for a first binding and for an identical retry alike, so the bindings are read
 * BEFORE the call and the returned `bindingRef` looked up in that set. Reporting
 * DECIDED unconditionally would invent a durable fact the producer never stated.
 */

import type { JsonObject } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import {
  CONTINUATION_COMMAND_KINDS, CONTINUATION_SCHEMA_VERSION,
} from "./continuation-contracts.js";
import {
  evaluateContinuationCommandBytes, readContinuationBindings,
} from "./continuation-service.js";

export const CONTINUATION_COMMAND_KIND = CONTINUATION_COMMAND_KINDS[0];

/** Exactly what a caller may say; every other request field is a server fact. */
export const CONTINUATION_PAYLOAD_KEYS = Object.freeze([
  "attemptRef",
  "successorRef",
] as const);

export type ContinuationCommandOutcome =
  | {
      readonly bindingRef: string;
      readonly ok: true;
      readonly replayed: boolean;
      readonly resultCode: string;
    }
  | { readonly code: string; readonly layer: string; readonly message: string; readonly ok: false };

export interface ContinuationCommandInput {
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly payload: JsonObject;
  readonly principalId: string;
  readonly projectId: string;
}

const encoder = new TextEncoder();

export function runContinuationCommand(
  store: SqliteEventStore,
  input: ContinuationCommandInput,
): ContinuationCommandOutcome {
  const bytes = encoder.encode(JSON.stringify({
    attemptRef: input.payload["attemptRef"],
    correlationId: input.correlationId,
    decidedAt: input.decidedAt,
    kind: CONTINUATION_COMMAND_KIND,
    principalId: input.principalId,
    projectId: input.projectId,
    schemaVersion: CONTINUATION_SCHEMA_VERSION,
    successorRef: input.payload["successorRef"],
  }));

  const before = readContinuationBindings(store, input.projectId);
  const result = evaluateContinuationCommandBytes(store, bytes);
  if (!result.ok) {
    return Object.freeze({
      code: result.code, layer: result.layer, message: result.message, ok: false as const,
    });
  }
  const { bindingRef } = result.binding;
  return Object.freeze({
    bindingRef,
    ok: true as const,
    replayed: before.some((binding) => binding.bindingRef === bindingRef),
    resultCode: result.outcome,
  });
}
