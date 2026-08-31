import type { RuntimeCommandEnvelope } from "@moe/contracts";
import type {
  ControlRoomClientSurface,
  ControlRoomTransport,
} from "@moe/control-room-client";

import {
  GATE1_ANSWER_COMMAND_KIND,
  GATE1_COMMAND_KIND,
} from "./gate1-daemon-submission.js";
import type {
  Gate1CommandKind,
  Gate1DaemonSubmission,
} from "./gate1-daemon-submission.js";
import {
  GATE1_LAYER,
  mapGate1Answer,
} from "./gate1-pending-contract.js";
import type {
  Gate1ClarificationView,
  Gate1PendingView,
  Gate1ReadOutcome,
} from "./gate1-pending-contract.js";
import {
  exactGate1Row,
  snapshotGate1Data,
} from "./gate1-data-snapshot.js";
import { gate1RefusalFromSnapshot } from "./gate1-refusal.js";

export { GATE1_COMMAND_KIND, GATE1_LAYER, mapGate1Answer };
export type {
  Gate1ClarificationOptionView,
  Gate1ClarificationView,
  Gate1PendingView,
  Gate1ReadOutcome,
} from "./gate1-pending-contract.js";
export type { Gate1DaemonSubmission } from "./gate1-daemon-submission.js";

export const GATE1_PENDING_READ_PATH = "/v2/product-contract/pending/read" as const;
const REQUEST_TIMEOUT_MS = 15_000;

export async function readPendingContract(
  headers: Readonly<Record<string, string>>,
  goalId: string,
  post?: (body: string) => Promise<Response>,
): Promise<Gate1ReadOutcome> {
  const send = post ?? ((body: string): Promise<Response> => fetch(GATE1_PENDING_READ_PATH, {
    body,
    headers,
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  try {
    const response = await send(JSON.stringify({ goalRef: goalId }));
    return mapGate1Answer(response.status, await response.json() as unknown);
  } catch {
    return Object.freeze({
      code: "TRANSPORT_REQUEST_FAILED", layer: GATE1_LAYER, status: "ERROR" as const,
    });
  }
}

export type Gate1ApprovalOutcome =
  | { readonly commandId: string; readonly ok: true }
  | { readonly code: string; readonly layer: string; readonly ok: false };

export interface Gate1ApprovalWire {
  readonly client: Pick<ControlRoomClientSurface, "commands">;
  readonly sessionCredential: string;
  readonly transport: Pick<ControlRoomTransport, "sendCommand">;
}

export interface Gate1ApprovalPort {
  readonly answer: (
    clarification: Gate1ClarificationView,
    optionId: string,
  ) => Promise<Gate1ApprovalOutcome>;
  readonly submit: (pending: Gate1PendingView) => Promise<Gate1ApprovalOutcome>;
}

function answerOf(response: unknown, status: number, commandId: string): Gate1ApprovalOutcome {
  const captured = snapshotGate1Data(response);
  if (!captured.ok) {
    return Object.freeze({
      code: "GATE1_ANSWER_UNREADABLE", layer: GATE1_LAYER, ok: false as const,
    });
  }
  const accepted = exactGate1Row(
    captured.value, ["decision", "httpStatus", "ok", "outcome"],
  );
  if (accepted !== null && status === 200 && accepted["httpStatus"] === 200
    && accepted["ok"] === true && accepted["outcome"] === "ACCEPTED") {
    const decision = exactGate1Row(
      accepted["decision"], ["commandId", "disposition", "effectId", "resultCode"],
    );
    if (decision !== null && decision["commandId"] === commandId
      && (decision["disposition"] === "DECIDED" || decision["disposition"] === "REPLAYED")
      && (decision["effectId"] === null || typeof decision["effectId"] === "string"
        && decision["effectId"].length > 0)
      && decision["resultCode"] === "EFFECTS_COMMITTED") {
      return Object.freeze({ commandId, ok: true as const });
    }
    return Object.freeze({
      code: "GATE1_ANSWER_UNREADABLE", layer: GATE1_LAYER, ok: false as const,
    });
  }
  const refusal = gate1RefusalFromSnapshot(status, captured.value);
  return refusal === null ? Object.freeze({
      code: "GATE1_ANSWER_UNREADABLE", layer: GATE1_LAYER, ok: false as const,
    }) : Object.freeze({ ...refusal, ok: false as const });
}

/**
 * Adds only the human's fresh bearer presentation. The revision subject,
 * command identity, correlation and digest remain the daemon submission's.
 */
export function presentGate1Approval(
  submission: Gate1DaemonSubmission,
  issuedAt: number = Date.now(),
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...submission.payload,
    authentication: Object.freeze({
      issuedAt,
      kind: "BEARER" as const,
      requestDigest: submission.requestDigest,
      requestId: submission.commandId,
    }),
  });
}

export function createGate1ApprovalPort(wire: Gate1ApprovalWire): Gate1ApprovalPort {
  const dispatch = async (
    kind: Gate1CommandKind,
    submission: Gate1DaemonSubmission,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<Gate1ApprovalOutcome> => {
    const builder = wire.client.commands[kind] as unknown as (
      affordance: unknown,
      caller: unknown,
    ) => { readonly envelope?: unknown; readonly error?: { readonly code: string }; readonly ok: boolean };
    const built = builder(submission.affordance, {
      correlationId: submission.correlationId,
      payload,
      requestDigest: submission.requestDigest,
      sessionCredential: wire.sessionCredential,
    });
    if (!built.ok || built.envelope === undefined) {
      return {
        code: built.error?.code ?? "INPUT_INVALID",
        layer: GATE1_LAYER,
        ok: false,
      };
    }
    const envelope = built.envelope as RuntimeCommandEnvelope;
    const sent = await wire.transport.sendCommand(envelope);
    if (!sent.delivered) return { code: sent.code, layer: sent.layer, ok: false };
    return answerOf(sent.response, sent.status, submission.commandId);
  };

  return Object.freeze({
    answer: async (
      clarification: Gate1ClarificationView,
      optionId: string,
    ): Promise<Gate1ApprovalOutcome> => {
      const selected = clarification.options.find((option) => option.optionId === optionId);
      if (selected === undefined) {
        return { code: "GATE1_ANSWER_UNAVAILABLE", layer: GATE1_LAYER, ok: false };
      }
      return dispatch(GATE1_ANSWER_COMMAND_KIND, selected.answer, selected.answer.payload);
    },
    submit: async (pending: Gate1PendingView): Promise<Gate1ApprovalOutcome> => {
      if (pending.approval === null) {
        return { code: "GATE1_APPROVAL_WITHHELD", layer: GATE1_LAYER, ok: false };
      }
      return dispatch(
        GATE1_COMMAND_KIND,
        pending.approval,
        presentGate1Approval(pending.approval),
      );
    },
  });
}
