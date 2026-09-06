import { createHash } from "node:crypto";
import { decodeBoundedJsonBytes, decodeRuntimeCommandEnvelopeBytes } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";
import { identifyReplayRequest } from "@moe/store";
import type { CommandDecisionRecord, SqliteEventStore } from "@moe/store";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import { DAEMON_COMMAND_SEAM } from "../http/http-async-contract.js";
import type { AsyncCommandHandler } from "../http/http-async-contract.js";
import type { CommandHandlerInput, DurableDecision } from "../http/http-contract.js";
import { validPublicationBranch, validPublicationSha } from "../repository/publication-approval-contracts.js";
import { releaseDossierAggregateId } from "./release-dossier-contracts.js";
import { readReleaseReceipt } from "./release-receipt-ledger.js";

const KIND = "release.decide" as const;
const INTENT_KIND = "internal.release.command_requested";
const INTENT_PRINCIPAL = "daemon:release-command";
const encoder = new TextEncoder();
const bytes = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));
type Terminal = Readonly<{ outcome: "DECIDED"; effectId: string | null; resultCode: string }>
  | Readonly<{ outcome: "REFUSED"; code: string; detail: string; httpStatus: number; layer: string }>;
interface Options {
  readonly clock?: () => string;
  readonly operatorPrincipalId: string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

function refuse(code: string, status = 422): never {
  throw new DomainRefusal(code, DAEMON_COMMAND_SEAM, code, status);
}

function admittedInput(input: CommandHandlerInput, options: Options): CommandHandlerInput {
  if (input.principal.principalId !== options.operatorPrincipalId) {
    throw new DomainRefusal("OPERATOR_PRINCIPAL_REQUIRED", "DAEMON_AUTHORIZATION",
      "this command requires the configured operator principal", 403);
  }
  if (input.principal.projectId !== options.projectId) refuse("RELEASE_PROJECT_MISMATCH", 403);
  const decoded = decodeRuntimeCommandEnvelopeBytes(bytes(input.envelope));
  if (!decoded.ok) refuse(decoded.error.code);
  const envelope = decoded.envelope, payload = envelope.payload;
  const keys = Object.keys(payload);
  if (envelope.commandKind !== KIND || keys.length !== 4
    || keys.some(key => !["base", "decision", "goalId", "sha"].includes(key))
    || !validPublicationBranch(payload["base"]) || !validPublicationSha(payload["sha"])
    || typeof payload["goalId"] !== "string" || payload["goalId"].length === 0
    || (payload["decision"] !== "APPROVE" && payload["decision"] !== "REJECT")) refuse("INPUT_INVALID");
  if (envelope.targetAggregateId !== releaseDossierAggregateId(payload["goalId"])) refuse("RELEASE_TARGET_INVALID");
  return { envelope, principal: { ...input.principal } };
}

function assertIdentity(record: CommandDecisionRecord, kind: string, requestBytes: Uint8Array): void {
  if (record.commandKind !== kind || record.effectDisposition !== "EFFECTS_COMMITTED") refuse("RELEASE_COMMAND_ID_SPENT", 409);
  if (identifyReplayRequest(record, requestBytes) !== record.replayRequestSha256) refuse("RELEASE_COMMAND_BYTES_CONFLICT", 409);
}

/** A refreshed offer cannot bypass a prior command still owning this release target. */
function hasPendingRelease(store: SqliteEventStore, target: string): boolean {
  const pending = new Set<string>();
  for (const event of store.readEvents(target)) {
    if (event.eventType === "ReleaseCommandAdmitted") {
      if (!/^[a-f0-9]{64}-admitted$/u.test(event.eventId)) refuse("RELEASE_COMMAND_RESULT_INVALID");
      pending.add(event.eventId.slice(0, -"-admitted".length));
    } else if (event.eventType === "ReleaseCommandDecided") {
      if (!/^[a-f0-9]{64}-decided$/u.test(event.eventId)) refuse("RELEASE_COMMAND_RESULT_INVALID");
      pending.delete(event.eventId.slice(0, -"-decided".length));
    }
  }
  return pending.size > 0;
}

function decodeTerminal(record: CommandDecisionRecord): Terminal {
  const decoded = decodeBoundedJsonBytes(record.resultBytes);
  if (!decoded.ok || decoded.value === null || Array.isArray(decoded.value) || typeof decoded.value !== "object") {
    refuse("RELEASE_COMMAND_RESULT_INVALID");
  }
  const value = decoded.value as JsonObject;
  if (value["outcome"] === "DECIDED" && Object.keys(value).length === 3
    && typeof value["resultCode"] === "string" && (value["effectId"] === null || typeof value["effectId"] === "string")) {
    return { outcome: "DECIDED", effectId: value["effectId"], resultCode: value["resultCode"] };
  }
  if (value["outcome"] === "REFUSED" && Object.keys(value).length === 5
    && typeof value["code"] === "string" && typeof value["detail"] === "string" && typeof value["layer"] === "string"
    && typeof value["httpStatus"] === "number" && Number.isInteger(value["httpStatus"])
    && value["httpStatus"] >= 400 && value["httpStatus"] <= 599) {
    return { outcome: "REFUSED", code: value["code"], detail: value["detail"], layer: value["layer"], httpStatus: value["httpStatus"] };
  }
  return refuse("RELEASE_COMMAND_RESULT_INVALID");
}

function answer(result: Terminal, input: CommandHandlerInput, options: Options, replayed: boolean): DurableDecision {
  if (result.outcome === "REFUSED") throw new DomainRefusal(result.code, result.layer, result.detail, result.httpStatus);
  const payload = input.envelope.payload;
  if (result.resultCode === "REJECTED") {
    if (payload["decision"] !== "REJECT" || result.effectId !== null) refuse("RELEASE_COMMAND_RESULT_INVALID");
  } else if (result.resultCode === "RELEASED" && result.effectId !== null && payload["decision"] === "APPROVE") {
    const receipt = readReleaseReceipt(options.store, options.projectId, result.effectId);
    if (!receipt.ok || receipt.receipt.goalId !== payload["goalId"] || receipt.receipt.sha !== payload["sha"]
      || receipt.receipt.outcome !== "RELEASED") refuse("RELEASE_COMMAND_RESULT_INVALID");
  } else refuse("RELEASE_COMMAND_RESULT_INVALID");
  return { commandId: input.envelope.commandId, disposition: replayed ? "REPLAYED" : "DECIDED",
    effectId: result.effectId, resultCode: result.resultCode };
}

/** The transport decision port delegates replay to services. This journal owns command
 * identity, including rejected decisions, while release receipts continue to own PR evidence.
 * Admission atomically consumes the offered release version before any service effect. */
export function createReleaseDecideCommand(options: Options, execute: AsyncCommandHandler): AsyncCommandHandler {
  const { store, projectId } = options;
  const clock = options.clock ?? (() => new Date().toISOString());
  return async incoming => {
    const input = admittedInput(incoming, options), { envelope, principal } = input;
    const payload = envelope.payload;
    // Credentials and caller digests are not durable authority. Recompute identity from
    // the admitted intent and server-known principal; retain revision and lease fences.
    const requestBytes = bytes({ kind: KIND, projectId, principalId: principal.principalId,
      targetAggregateId: envelope.targetAggregateId, expectedVersion: envelope.expectedVersion,
      payload: { base: payload["base"], decision: payload["decision"], goalId: payload["goalId"], sha: payload["sha"] },
      graphRevisionHash: envelope.graphRevisionHash, policyRevisionHash: envelope.policyRevisionHash,
      leaseAuthority: envelope.leaseAuthority });
    const key = { commandId: envelope.commandId, principalId: principal.principalId, projectId };
    const existing = store.getCommandDecision(key);
    if (existing !== null) {
      assertIdentity(existing, KIND, requestBytes);
      return answer(decodeTerminal(existing), input, options, true);
    }
    const intentKey = { ...key, principalId: INTENT_PRINCIPAL };
    const pending = store.getCommandDecision(intentKey);
    if (pending !== null) {
      assertIdentity(pending, INTENT_KIND, requestBytes);
      // A (goal,SHA) receipt has no command/base identity and cannot resolve an uncertain command.
      refuse("RELEASE_COMMAND_IN_PROGRESS", 409);
    }
    if (store.getAggregateVersion(envelope.targetAggregateId) !== envelope.expectedVersion) refuse("EXPECTED_VERSION_CONFLICT", 409);
    if (hasPendingRelease(store, envelope.targetAggregateId)) refuse("RELEASE_COMMAND_IN_PROGRESS", 409);
    const requestId = createHash("sha256").update(bytes(key)).digest("hex");
    const admitted = store.commitExpectedVersionDecisionLegs({ commandKind: INTENT_KIND,
      committedResultBytes: requestBytes, correlationId: envelope.correlationId, decidedAt: clock(),
      key: intentKey, requestBytes, legs: [
        { aggregateId: `release-request:${requestId}`, expectedVersion: 0,
          events: [{ eventId: `${requestId}-requested`, eventType: "ReleaseCommandRequested", payload: requestBytes }] },
        { aggregateId: envelope.targetAggregateId, expectedVersion: envelope.expectedVersion,
          events: [{ eventId: `${requestId}-admitted`, eventType: "ReleaseCommandAdmitted", payload: requestBytes }] },
      ] });
    if (admitted.decision.effectDisposition !== "EFFECTS_COMMITTED") refuse(admitted.decision.resultCode, 409);
    if (admitted.disposition === "REPLAYED") refuse("RELEASE_COMMAND_IN_PROGRESS", 409);
    let result: Terminal;
    try {
      const decision = await execute(input);
      if (decision.commandId !== envelope.commandId) refuse("RELEASE_COMMAND_RESULT_INVALID");
      result = { outcome: "DECIDED", effectId: decision.effectId, resultCode: decision.resultCode };
      answer(result, input, options, false);
    } catch (error) {
      // Unknown failures may follow an uncertain external effect. Preserve pending intent.
      if (!(error instanceof DomainRefusal)) throw error;
      result = { outcome: "REFUSED", code: error.code, detail: error.detail, layer: error.layer, httpStatus: error.httpStatus };
    }
    const terminalBytes = bytes(result);
    const committed = store.commitExpectedVersionDecision({ commandKind: KIND, committedResultBytes: terminalBytes,
      correlationId: envelope.correlationId, decidedAt: clock(), key, requestBytes,
      targetAggregateId: envelope.targetAggregateId, expectedVersion: store.getAggregateVersion(envelope.targetAggregateId),
      events: [{ eventId: `${requestId}-decided`, eventType: "ReleaseCommandDecided", payload: terminalBytes }] });
    if (committed.decision.effectDisposition !== "EFFECTS_COMMITTED") refuse(committed.decision.resultCode, 409);
    return answer(decodeTerminal(committed.decision), input, options, committed.disposition === "REPLAYED");
  };
}
