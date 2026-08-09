import type { ControlRoomClientSurface, ControlRoomTransport } from "@moe/control-room-client";
import type { JsonObject } from "@moe/contracts";

/**
 * Dispatch = the daemon's affordance handed back through the generated builder.
 *
 * The builder validates the affordance and mints the envelope; this module adds
 * only the caller half (payload, correlation, digest, credential) and reports
 * the daemon's answer verbatim. The UI never moves a card on the strength of a
 * dispatch — the next surface poll does, because only the ledger moves cards.
 *
 * DEVELOPMENT payload defaults: dev-fixture payloads matching the daemon's
 * default-subject convention. The daemon may still refuse any of them; that
 * refusal renders verbatim, which is correct behavior rather than a failure.
 */

export const DEV_PAYLOADS: Readonly<Record<string, JsonObject>> = Object.freeze({
  "approval.decide": {
    activation: {}, command: {}, graphRevisionRef: "rev-1", record: {}, runId: "run-live-1",
  },
  "goal.close": { closureWitness: {}, goalId: "goal-live-1", zeroAuthorityWitness: {} },
  "goal.create": {
    budgetAccountRef: "budget-live-1", goalId: "goal-live-1",
    planningRunRef: "run-live-1", witness: {},
  },
  "plan.propose": { commands: [{ kind: "plan.propose" }], runId: "run-live-1" },
  "policy.install": { slice: {} },
  "policy.validate": { input: {} },
  "project.activate": { witness: {} },
  "project.bind_repository": { observation: {} },
  "project.register": { owner: "operator-local" },
  "provider.probe": { observation: {} },
  "session.open": {
    capabilities: ["goal.write"], credentialSha256: "a".repeat(64),
    expiresAt: "2027-01-01T00:00:00.000Z", sessionId: "sess-ui-1",
  },
});

/** session.close / session.renew derive their payload from the step's aggregate. */
export function payloadFor(kind: string, aggregateId: string | null): JsonObject | null {
  if (kind === "session.close" || kind === "session.renew") {
    const sessionId = aggregateId?.startsWith("session/") === true
      ? aggregateId.slice("session/".length)
      : null;
    if (sessionId === null) return null;
    return kind === "session.close"
      ? { sessionId }
      : { expiresAt: "2027-06-01T00:00:00.000Z", sessionId };
  }
  return DEV_PAYLOADS[kind] ?? null;
}

export interface DispatchReport {
  /** The daemon's own answer text: resultCode, refusal code, or transport code. */
  readonly detail: string;
  readonly ok: boolean;
  readonly stage: "ANSWERED" | "BUILD_REFUSED" | "UNDELIVERED";
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function answerText(response: unknown): { detail: string; ok: boolean } {
  if (!isRecord(response)) return { detail: "unreadable answer", ok: false };
  if (response["ok"] === true) {
    const decision = response["decision"];
    const resultCode = isRecord(decision) ? String(decision["resultCode"] ?? "") : "";
    const disposition = isRecord(decision) ? String(decision["disposition"] ?? "") : "";
    return { detail: `${disposition} ${resultCode}`.trim(), ok: true };
  }
  const refusal = response["refusal"];
  if (isRecord(refusal)) return { detail: String(refusal["code"] ?? "REFUSED"), ok: false };
  const error = response["error"];
  if (isRecord(error)) return { detail: String(error["code"] ?? "REFUSED"), ok: false };
  return { detail: "REFUSED", ok: false };
}

export interface DispatchInput {
  readonly affordance: Record<string, unknown>;
  readonly aggregateId: string | null;
  readonly client: ControlRoomClientSurface;
  readonly kind: string;
  readonly sessionCredential: string;
  readonly transport: Pick<ControlRoomTransport, "sendCommand">;
}

export async function dispatchAffordance(input: DispatchInput): Promise<DispatchReport> {
  const payload = payloadFor(input.kind, input.aggregateId);
  if (payload === null) {
    return { detail: "no development payload for this kind", ok: false, stage: "BUILD_REFUSED" };
  }
  const builders = input.client.commands as Readonly<Record<
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
  const answer = answerText(sent.response);
  return { detail: answer.detail, ok: answer.ok, stage: "ANSWERED" };
}
