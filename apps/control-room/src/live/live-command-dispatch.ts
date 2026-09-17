import type { ControlRoomClientSurface, ControlRoomTransport } from "@moe/control-room-client";
import type { JsonObject } from "@moe/contracts";

import { exactDataRecord, isRecord, sha256Hex } from "./live-wire-primitives.js";

/** Result of one generated-builder command round trip. */
export interface DispatchReport {
  readonly detail: string;
  readonly ok: boolean;
  readonly stage:
    | "ANSWERED"
    | "ANSWER_REFUSED"
    | "ANSWER_UNREADABLE"
    | "BUILD_REFUSED"
    | "UNDELIVERED";
}

export interface DispatchInput {
  readonly affordance: Record<string, unknown>;
  readonly aggregateId: string | null;
  readonly client: ControlRoomClientSurface;
  readonly kind: string;
  readonly sessionCredential: string;
  readonly transport: Pick<ControlRoomTransport, "sendCommand">;
  readonly version?: number | null | undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function ownNonEmptyString(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor
      && nonEmptyString(descriptor.value) ? descriptor.value : null;
  } catch {
    return null;
  }
}

function answerText(
  status: number,
  response: unknown,
  expectedCommandId: string | null,
): { detail: string; kind: "ACCEPTED" | "REFUSED" | "UNREADABLE"; ok: boolean } {
  const accepted = exactDataRecord(response, ["decision", "httpStatus", "ok", "outcome"]);
  if (accepted !== null && status === 200 && accepted["httpStatus"] === 200
    && accepted["ok"] === true && accepted["outcome"] === "ACCEPTED") {
    const decision = exactDataRecord(
      accepted["decision"], ["commandId", "disposition", "effectId", "resultCode"],
    );
    if (decision !== null && expectedCommandId !== null
      && decision["commandId"] === expectedCommandId
      && (decision["disposition"] === "DECIDED" || decision["disposition"] === "REPLAYED")
      && (decision["effectId"] === null || nonEmptyString(decision["effectId"]))
      && nonEmptyString(decision["resultCode"])) {
      return {
        detail: `${decision["disposition"]} ${decision["resultCode"]}`,
        kind: "ACCEPTED",
        ok: true,
      };
    }
    return { detail: "unreadable answer", kind: "UNREADABLE", ok: false };
  }

  const listener = exactDataRecord(response, ["code", "layer"]);
  if (listener !== null && status !== 200 && nonEmptyString(listener["code"])
    && nonEmptyString(listener["layer"])) {
    return {
      detail: `${listener["code"]} @ ${listener["layer"]}`, kind: "REFUSED", ok: false,
    };
  }

  const port = exactDataRecord(response, ["httpStatus", "ok", "outcome", "refusal", "stage"]);
  if (port !== null && port["httpStatus"] === status && port["ok"] === false
    && port["outcome"] === "PORT_REFUSED"
    && (port["stage"] === "AUTHENTICATE" || port["stage"] === "DISPATCH")) {
    const refusal = exactDataRecord(port["refusal"], ["code", "detail", "httpStatus", "layer"]);
    if (refusal !== null && refusal["httpStatus"] === status
      && nonEmptyString(refusal["code"]) && typeof refusal["detail"] === "string"
      && nonEmptyString(refusal["layer"])) {
      return {
        detail: `${refusal["code"]} @ ${refusal["layer"]}`, kind: "REFUSED", ok: false,
      };
    }
  }

  const refused = exactDataRecord(response, ["error", "httpStatus", "ok", "outcome", "stage"]);
  if (refused !== null && refused["httpStatus"] === status && refused["ok"] === false
    && refused["outcome"] === "REFUSED" && nonEmptyString(refused["stage"])) {
    const code = ownNonEmptyString(refused["error"], "code");
    if (code !== null) {
      return { detail: `${code} @ ${refused["stage"]}`, kind: "REFUSED", ok: false };
    }
  }
  return { detail: "unreadable answer", kind: "UNREADABLE", ok: false };
}

/** Shared explicit-payload path; exported so the development adapter cannot fork its decoder. */
export async function dispatchPreparedPayload(
  input: DispatchInput,
  payload: JsonObject,
): Promise<DispatchReport> {
  const builders = input.client.commands as unknown as Readonly<Record<
    string,
    (affordance: unknown, caller: unknown) => { envelope?: unknown; error?: { code?: string }; ok: boolean }
  >>;
  const builder = builders[input.kind];
  if (builder === undefined) {
    return { detail: "no generated builder for this kind", ok: false, stage: "BUILD_REFUSED" };
  }
  const built = builder(input.affordance, {
    correlationId: `ui-${String(Date.now())}`,
    payload,
    requestDigest: await sha256Hex(JSON.stringify(payload)),
    sessionCredential: input.sessionCredential,
  });
  if (!built.ok || built.envelope === undefined) {
    return { detail: built.error?.code ?? "INPUT_INVALID", ok: false, stage: "BUILD_REFUSED" };
  }
  const sent = await input.transport.sendCommand(
    built.envelope as Parameters<ControlRoomTransport["sendCommand"]>[0],
  );
  if (!sent.delivered) return { detail: sent.code, ok: false, stage: "UNDELIVERED" };
  const answer = answerText(
    sent.status,
    sent.response,
    ownNonEmptyString(built.envelope, "commandId"),
  );
  const stage = answer.kind === "ACCEPTED" ? "ANSWERED"
    : answer.kind === "REFUSED" ? "ANSWER_REFUSED" : "ANSWER_UNREADABLE";
  return { detail: answer.detail, ok: answer.ok, stage };
}
