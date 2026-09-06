import { createHash } from "node:crypto";
import { identifyReplayRequest } from "@moe/store";
import type { CommandDecisionRecord } from "@moe/store";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import { DAEMON_COMMAND_SEAM } from "../http/http-async-contract.js";
import type { AsyncCommandHandler } from "../http/http-async-contract.js";
import type { CommandHandlerInput, DurableDecision } from "../http/http-contract.js";
import { productionDeployPorts } from "./deploy-command.js";
import type { DeployCommandOptions } from "./deploy-command.js";
import { readDeployReceipt } from "./deploy-ledger.js";
import { admitEnvironmentName, deployReceiptId } from "./deploy-receipt-contracts.js";
import type { DeployReceiptV1 } from "./deploy-receipt-contracts.js";
import { createDeployService } from "./deploy-service.js";

export type RollbackCommandOptions = Omit<DeployCommandOptions, "buildContext">;
export const DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE = "DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE" as const;
const KIND = "deployment.rollback" as const;
const INTENT_KIND = "internal.deployment.rollback_requested";
const INTENT_PRINCIPAL = "daemon:rollback-command";
const encoder = new TextEncoder();
const bytes = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));

function refuse(code: string, detail = code, status = 422): never {
  throw new DomainRefusal(code, DAEMON_COMMAND_SEAM, detail, status);
}

function exactRequest({ envelope }: CommandHandlerInput): { environment: string; receiptId: string; restore: boolean } {
  const payload = envelope.payload;
  const keys = Object.keys(payload);
  const environment = admitEnvironmentName(payload["environment"]);
  const receiptId = payload["toReceiptRef"];
  if (envelope.commandKind !== KIND || !Number.isSafeInteger(envelope.expectedVersion) || envelope.expectedVersion < 0
    || envelope.commandId.length === 0 || keys.length !== 3
    || keys.some(key => !["environment", "toReceiptRef", "restoreDatabase"].includes(key))
    || environment === null || typeof receiptId !== "string" || !/^[0-9a-f]{64}$/u.test(receiptId)
    || typeof payload["restoreDatabase"] !== "boolean") refuse("DEPLOY_ROLLBACK_REQUEST_INVALID");
  return { environment, receiptId, restore: payload["restoreDatabase"] };
}

function assertIdentity(record: CommandDecisionRecord, kind: string, requestBytes: Uint8Array): void {
  if (record.commandKind !== kind || record.effectDisposition !== "EFFECTS_COMMITTED") {
    refuse("DEPLOY_ROLLBACK_COMMAND_ID_SPENT", undefined, 409);
  }
  if (identifyReplayRequest(record, requestBytes) !== record.replayRequestSha256) {
    refuse("DEPLOY_ROLLBACK_COMMAND_BYTES_CONFLICT", undefined, 409);
  }
}

function outcome(record: CommandDecisionRecord, receipt: DeployReceiptV1, replayed: boolean): DurableDecision {
  if (receipt.refusal !== null) {
    throw new DomainRefusal(receipt.refusal.code, receipt.refusal.layer, receipt.refusal.detail);
  }
  return { commandId: record.key.commandId, disposition: replayed ? "REPLAYED" : "DECIDED",
    effectId: record.decisionId, resultCode: record.resultCode };
}

/** The immutable intent consumes the offered project version before any remote operation.
 * A process that dies without a receipt leaves a pending request, never permission to retry
 * uncertain effects. Receipt-backed recovery may finish only the already admitted request. */
export function createRollbackCommandHandler(options: RollbackCommandOptions): AsyncCommandHandler {
  const { store, projectId, operatorPrincipalId } = options;
  const clock = options.clock ?? (() => new Date().toISOString());
  return async (input): Promise<DurableDecision> => {
    const { envelope, principal } = input;
    if (principal.principalId !== operatorPrincipalId) {
      throw new DomainRefusal("OPERATOR_PRINCIPAL_REQUIRED", "DAEMON_AUTHORIZATION",
        "this command requires the configured operator principal", 403);
    }
    if (principal.projectId !== projectId) refuse("DEPLOY_ROLLBACK_PROJECT_MISMATCH", undefined, 403);
    if (envelope.targetAggregateId !== projectId) refuse("DEPLOY_ROLLBACK_TARGET_INVALID");
    const request = exactRequest(input);
    const requestBytes = bytes({ kind: KIND, projectId, principalId: principal.principalId,
      targetAggregateId: envelope.targetAggregateId, expectedVersion: envelope.expectedVersion,
      payload: { environment: request.environment, toReceiptRef: request.receiptId, restoreDatabase: request.restore } });
    const key = { commandId: envelope.commandId, principalId: principal.principalId, projectId };
    const decided = store.getCommandDecision(key);
    if (decided !== null) assertIdentity(decided, KIND, requestBytes);
    const intentKey = { ...key, principalId: INTENT_PRINCIPAL };
    const intent = store.getCommandDecision(intentKey);
    if (intent !== null) assertIdentity(intent, INTENT_KIND, requestBytes);
    // BackupPorts.restoreDatabase verifies a dump in a temporary isolated database.
    // It has no bound production restore destination and cannot satisfy this operation.
    if (request.restore) refuse(DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE,
      "no database restoration port is bound to the selected deployment environment");
    const selected = readDeployReceipt(store, projectId, request.receiptId);
    if (!selected.ok || selected.receipt.environment !== request.environment
      || selected.receipt.outcome !== "DEPLOYED" || selected.receipt.imageDigest === null) {
      refuse("DEPLOY_ROLLBACK_RECEIPT_INVALID");
    }
    const receiptId = deployReceiptId(projectId, request.environment, envelope.commandId);
    const recovered = readDeployReceipt(store, projectId, receiptId);
    const selectedReceipt = selected.receipt;
    const validateReceipt = (receipt: DeployReceiptV1): void => {
      if (receipt.sha !== selectedReceipt.sha || receipt.environment !== request.environment
        || receipt.decisionId !== envelope.commandId
        || (receipt.outcome === "DEPLOYED" && receipt.imageDigest !== selectedReceipt.imageDigest)) {
        refuse("DEPLOY_ROLLBACK_RECEIPT_INVALID");
      }
    };
    if (decided !== null) {
      if (intent === null || !recovered.ok) refuse("DEPLOY_ROLLBACK_RECEIPT_INVALID");
      validateReceipt(recovered.receipt);
      return outcome(decided, recovered.receipt, true);
    }
    if (intent !== null && !recovered.ok) refuse("DEPLOY_ROLLBACK_IN_PROGRESS", undefined, 409);
    if (intent === null && (recovered.ok || recovered.code !== "DEPLOY_RECEIPT_NOT_FOUND")) {
      refuse("DEPLOY_ROLLBACK_COMMAND_ID_SPENT", undefined, 409);
    }
    const decidedAt = clock();
    if (intent === null) {
      const aggregateId = `rollback-request:${createHash("sha256").update(bytes(key)).digest("hex")}`;
      const admitted = store.commitExpectedVersionDecisionLegs({ commandKind: INTENT_KIND,
        committedResultBytes: requestBytes, correlationId: envelope.correlationId, decidedAt,
        key: intentKey, requestBytes, legs: [
          { aggregateId, expectedVersion: 0, events: [{ eventId: `${aggregateId}-requested`,
            eventType: "EnvironmentRollbackRequested", payload: requestBytes }] },
          { aggregateId: projectId, expectedVersion: envelope.expectedVersion,
            events: [{ eventId: `${receiptId}-rollback-admitted`, eventType: "EnvironmentRollbackAdmitted", payload: requestBytes }] },
        ] });
      if (admitted.decision.effectDisposition !== "EFFECTS_COMMITTED") {
        refuse(admitted.decision.resultCode, undefined, 409);
      }
      // Another process may have won admission after our read. It alone owns execution.
      if (admitted.disposition === "REPLAYED") refuse("DEPLOY_ROLLBACK_IN_PROGRESS", undefined, 409);
    }
    let receipt: DeployReceiptV1;
    if (recovered.ok) {
      validateReceipt(recovered.receipt);
      receipt = recovered.receipt;
    } else {
      const report = await createDeployService({ ...options,
        ports: options.ports ?? productionDeployPorts(store, projectId) }).rollback({
        decisionId: envelope.commandId, environment: request.environment, receiptId: request.receiptId,
      });
      if (report.receipt === null || report.outcome !== report.receipt.outcome) {
        refuse("DEPLOY_ROLLBACK_RECEIPT_INVALID", report.detail);
      }
      validateReceipt(report.receipt);
      receipt = report.receipt;
    }
    const result = bytes({ environment: request.environment, toReceiptRef: request.receiptId,
      receiptId: receipt.receiptId, outcome: receipt.outcome });
    const committed = store.commitExpectedVersionDecision({ commandKind: KIND, committedResultBytes: result,
      correlationId: envelope.correlationId, decidedAt: clock(), key, requestBytes,
      targetAggregateId: projectId, expectedVersion: store.getAggregateVersion(projectId),
      events: [{ eventId: `${receipt.receiptId}-rollback-decided`, eventType: "EnvironmentRollbackDecided", payload: result }] });
    if (committed.decision.effectDisposition !== "EFFECTS_COMMITTED") refuse(committed.decision.resultCode, undefined, 409);
    return outcome(committed.decision, receipt, intent !== null || committed.disposition === "REPLAYED");
  };
}
