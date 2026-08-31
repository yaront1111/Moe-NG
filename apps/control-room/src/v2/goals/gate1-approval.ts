import type { RuntimeCommandEnvelope } from "@moe/contracts";
import type {
  ControlRoomClientSurface, ControlRoomTransport,
} from "@moe/control-room-client";

/**
 * GATE 1 (approve the Product Contract) from the browser: the read that shows
 * the pending revision, and the one write that follows.
 *
 * EVERY IDENTITY IS THE DAEMON'S. The pending route answers a daemon-minted
 * affordance (commandId, target aggregate, schema version) and the SUBJECT
 * digest the command's bearer arm re-derives server-side; this module composes
 * NO digest of its own and no command identity — it presents exactly what the
 * daemon minted, stamps the one honest local fact (`issuedAt`, the moment the
 * human clicked) and lets the daemon's own fences judge it: digest compare,
 * freshness window, durable HUMAN principal, single-use replay marker.
 *
 * The render guards mirror live-planning-run.ts: a revision body whose shape
 * drifts reddens the WHOLE answer to ERROR rather than showing a half-contract
 * a human might approve.
 */

export const GATE1_LAYER = "CONTROL_ROOM_GATE1";
export const GATE1_PENDING_READ_PATH = "/v2/product-contract/pending/read" as const;
const REQUEST_TIMEOUT_MS = 15_000;
export const GATE1_COMMAND_KIND = "product_contract.approve_gate_1" as const;

export interface Gate1RequirementView {
  readonly requirementId: string;
  readonly statement: string;
}
export interface Gate1CriterionView {
  readonly criterionId: string;
  readonly statement: string;
}

export interface Gate1ClarificationView {
  /** Daemon-minted dispatch identity; null once answered. */
  readonly answerAffordance: Readonly<Record<string, unknown>> | null;
  readonly answered: boolean;
  readonly clarificationId: string;
  readonly optionDigests: readonly {
    readonly optionId: string; readonly projectionDigest: string;
  }[];
  readonly options: readonly { readonly label: string; readonly optionId: string }[];
  readonly question: string;
}

export interface Gate1PendingView {
  /** NULL while a material question is open: answer first, then approve. */
  readonly approval: {
    readonly affordance: Readonly<Record<string, unknown>>;
    readonly commandId: string;
    readonly requestDigest: string;
  } | null;
  readonly clarifications: readonly Gate1ClarificationView[];
  readonly contractId: string;
  readonly criteria: readonly Gate1CriterionView[];
  readonly requirements: readonly Gate1RequirementView[];
  readonly revisionDigest: string;
  readonly revisionId: string;
  readonly status: "PENDING";
}

export type Gate1ReadOutcome =
  | Gate1PendingView
  | { readonly status: "NONE" }
  | { readonly code: string; readonly layer: string; readonly status: "ERROR" | "REFUSED" };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

function errored(code: string): Gate1ReadOutcome {
  return Object.freeze({ code, layer: GATE1_LAYER, status: "ERROR" as const });
}

/** The two statement rosters the card renders, each item read defensively. */
function statementsOf(
  value: unknown, idKey: string,
): readonly { readonly id: string; readonly statement: string }[] | null {
  if (!Array.isArray(value)) return null;
  const rows: { id: string; statement: string }[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const id = raw[idKey];
    const statement = raw["statement"];
    if (!nonEmptyString(id) || typeof statement !== "string") return null;
    rows.push({ id, statement });
  }
  return rows;
}

/** The clarification rows, each read defensively; a drifted one reddens all. */
function clarificationsOf(value: unknown): readonly Gate1ClarificationView[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const rows: Gate1ClarificationView[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || !nonEmptyString(raw["clarificationId"])
      || !nonEmptyString(raw["question"]) || typeof raw["answered"] !== "boolean"
      || !Array.isArray(raw["options"]) || !Array.isArray(raw["optionDigests"])) return null;
    const answerAffordance = raw["answerAffordance"];
    if (answerAffordance !== null && !isRecord(answerAffordance)) return null;
    const options: { label: string; optionId: string }[] = [];
    for (const option of raw["options"]) {
      if (!isRecord(option) || !nonEmptyString(option["label"])
        || !nonEmptyString(option["optionId"])) return null;
      options.push({ label: option["label"], optionId: option["optionId"] });
    }
    const optionDigests: { optionId: string; projectionDigest: string }[] = [];
    for (const digest of raw["optionDigests"]) {
      if (!isRecord(digest) || !nonEmptyString(digest["optionId"])
        || !nonEmptyString(digest["projectionDigest"])) return null;
      optionDigests.push({
        optionId: digest["optionId"], projectionDigest: digest["projectionDigest"],
      });
    }
    rows.push(Object.freeze({
      answerAffordance,
      answered: raw["answered"],
      clarificationId: raw["clarificationId"],
      optionDigests: Object.freeze(optionDigests),
      options: Object.freeze(options),
      question: raw["question"],
    }));
  }
  return Object.freeze(rows);
}

/** Maps the pending route's answer; refusals travel at their own layer. */
export function mapGate1Answer(status: number, response: unknown): Gate1ReadOutcome {
  if (isRecord(response) && response["outcome"] === "NONE") {
    return Object.freeze({ status: "NONE" as const });
  }
  if (isRecord(response) && response["outcome"] === "REFUSED"
    && nonEmptyString(response["code"])) {
    return Object.freeze({
      code: response["code"],
      layer: nonEmptyString(response["layer"]) ? response["layer"] : "DAEMON",
      status: "REFUSED" as const,
    });
  }
  // Listener refusals ({code, layer} at a non-200) and auth frames.
  if (status !== 200) {
    if (isRecord(response) && nonEmptyString(response["code"])) {
      return Object.freeze({
        code: response["code"],
        layer: nonEmptyString(response["layer"]) ? response["layer"] : "DAEMON",
        status: "REFUSED" as const,
      });
    }
    return errored("GATE1_RESPONSE_INVALID");
  }
  if (!isRecord(response) || response["outcome"] !== "PENDING") {
    return errored("GATE1_RESPONSE_INVALID");
  }
  const approvalRaw = response["approval"];
  const ref = response["ref"];
  const revision = response["revision"];
  if ((approvalRaw !== null && !isRecord(approvalRaw))
    || !isRecord(ref) || !isRecord(revision)) {
    return errored("GATE1_RESPONSE_INVALID");
  }
  let approval: Gate1PendingView["approval"] = null;
  if (approvalRaw !== null) {
    const affordance = approvalRaw["affordance"];
    if (!isRecord(affordance) || !nonEmptyString(approvalRaw["commandId"])
      || !nonEmptyString(approvalRaw["requestDigest"])) {
      return errored("GATE1_RESPONSE_INVALID");
    }
    approval = Object.freeze({
      affordance,
      commandId: approvalRaw["commandId"],
      requestDigest: approvalRaw["requestDigest"],
    });
  }
  if (!nonEmptyString(ref["contractId"]) || !nonEmptyString(ref["revisionDigest"])
    || !nonEmptyString(ref["revisionId"])) {
    return errored("GATE1_RESPONSE_INVALID");
  }
  const requirements = statementsOf(revision["requirements"], "requirementId");
  const criteria = statementsOf(revision["criteria"], "criterionId");
  if (requirements === null || criteria === null) return errored("GATE1_RESPONSE_INVALID");
  const clarifications = clarificationsOf(response["clarifications"]);
  if (clarifications === null) return errored("GATE1_RESPONSE_INVALID");
  return Object.freeze({
    approval,
    clarifications,
    contractId: ref["contractId"],
    criteria: Object.freeze(criteria.map((row) =>
      Object.freeze({ criterionId: row.id, statement: row.statement }))),
    requirements: Object.freeze(requirements.map((row) =>
      Object.freeze({ requirementId: row.id, statement: row.statement }))),
    revisionDigest: ref["revisionDigest"],
    revisionId: ref["revisionId"],
    status: "PENDING" as const,
  });
}

/** POSTs { goalRef } to the pending route and maps the answer. */
export async function readPendingContract(
  headers: Readonly<Record<string, string>>,
  goalId: string,
  post?: (body: string) => Promise<Response>,
): Promise<Gate1ReadOutcome> {
  const send = post ?? ((body: string): Promise<Response> => fetch(GATE1_PENDING_READ_PATH, {
    body, headers, method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  try {
    const response = await send(JSON.stringify({ goalRef: goalId }));
    return mapGate1Answer(response.status, await response.json() as unknown);
  } catch {
    return errored("TRANSPORT_REQUEST_FAILED");
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
  /** Answers one open clarification with an option ID from the daemon's roster. */
  readonly answer: (
    clarification: Gate1ClarificationView, optionId: string, contractId: string,
  ) => Promise<Gate1ApprovalOutcome>;
  readonly submit: (pending: Gate1PendingView) => Promise<Gate1ApprovalOutcome>;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function refusalOf(value: unknown): Gate1ApprovalOutcome | null {
  if (!isRecord(value)) return null;
  const code = value["code"];
  if (!nonEmptyString(code)) return null;
  const layer = value["layer"];
  return Object.freeze({
    code, layer: nonEmptyString(layer) ? layer : "DAEMON", ok: false as const,
  });
}

function answerOf(response: unknown, commandId: string): Gate1ApprovalOutcome {
  if (!isRecord(response)) {
    return { code: "GATE1_ANSWER_UNREADABLE", layer: GATE1_LAYER, ok: false };
  }
  if (response["ok"] === true) return { commandId, ok: true };
  return refusalOf(response["refusal"]) ?? refusalOf(response["error"])
    ?? { code: "GATE1_REFUSED", layer: "DAEMON", ok: false };
}

const ANSWER_COMMAND_KIND = "product_contract.answer_clarification" as const;

export function createGate1ApprovalPort(wire: Gate1ApprovalWire): Gate1ApprovalPort {
  const send = async (
    kind: typeof ANSWER_COMMAND_KIND | typeof GATE1_COMMAND_KIND,
    affordance: Readonly<Record<string, unknown>>,
    payload: Record<string, unknown>,
  ): Promise<Gate1ApprovalOutcome> => {
    const requestDigest = await sha256Hex(JSON.stringify(payload));
    // Both kinds share the generated caller shape; the union index collapses the
    // parameter types, so the builder is invoked through one structural view.
    const builder = wire.client.commands[kind] as unknown as (
      affordance: unknown, caller: unknown,
    ) => { readonly envelope?: unknown; readonly error?: { code: string }; readonly ok: boolean };
    const built = builder(affordance, {
      correlationId: `ui-gate1-${requestDigest.slice(0, 16)}`,
      payload,
      requestDigest,
      sessionCredential: wire.sessionCredential,
    });
    if (!built.ok || built.envelope === undefined) {
      return { code: built.error?.code ?? "INPUT_INVALID", layer: GATE1_LAYER, ok: false };
    }
    const envelope = built.envelope as RuntimeCommandEnvelope;
    const sent = await wire.transport.sendCommand(envelope);
    if (!sent.delivered) {
      return { code: sent.code, layer: GATE1_LAYER, ok: false };
    }
    return answerOf(sent.response, envelope.commandId);
  };
  return Object.freeze({
    answer: async (
      clarification: Gate1ClarificationView, optionId: string, contractId: string,
    ): Promise<Gate1ApprovalOutcome> => {
      const affordance = clarification.answerAffordance;
      const chosen = clarification.options.some((option) => option.optionId === optionId);
      if (affordance === null || !chosen) {
        return { code: "GATE1_ANSWER_UNAVAILABLE", layer: GATE1_LAYER, ok: false };
      }
      // The browser selects only one option the daemon offered. The /2 reader
      // re-derives every digest and the /2 writer binds this stable option ID.
      return send(ANSWER_COMMAND_KIND, affordance, {
        answerOptionId: optionId,
        clarificationId: clarification.clarificationId,
        contractId,
      });
    },
    submit: async (pending: Gate1PendingView): Promise<Gate1ApprovalOutcome> => {
      const approval = pending.approval;
      if (approval === null) {
        return { code: "GATE1_APPROVAL_WITHHELD", layer: GATE1_LAYER, ok: false };
      }
      // The presentation binds the daemon's own minted command identity and
      // subject digest; `issuedAt` is the one honest local fact (click time).
      return send(GATE1_COMMAND_KIND, approval.affordance, {
        authentication: {
          issuedAt: Date.now(),
          kind: "BEARER",
          requestDigest: approval.requestDigest,
          requestId: approval.commandId,
        },
        contractId: pending.contractId,
        revisionDigest: pending.revisionDigest,
        revisionId: pending.revisionId,
      });
    },
  });
}
