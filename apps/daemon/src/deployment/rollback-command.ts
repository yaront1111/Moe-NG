import { createHash } from "node:crypto";
import { decodeBoundedJsonBytes } from "@moe/contracts";
import { identifyReplayRequest } from "@moe/store";
import type { CommandDecisionRecord } from "@moe/store";
import { nodeBackupPorts } from "../backups/backup-ports.js";
import type { BackupPorts } from "../backups/backup-ports.js";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import { DAEMON_COMMAND_SEAM } from "../http/http-async-contract.js";
import type { AsyncCommandHandler } from "../http/http-async-contract.js";
import type { CommandHandlerInput, DurableDecision } from "../http/http-contract.js";
import { candidateEnvironmentPort } from "./deploy-candidate-environment.js";
import { productionDeployPorts } from "./deploy-command.js";
import type { DeployCommandOptions } from "./deploy-command.js";
import { readDeployReceipt } from "./deploy-ledger.js";
import { admitEnvironmentName, deployReceiptId } from "./deploy-receipt-contracts.js";
import type { DeployReceiptV1 } from "./deploy-receipt-contracts.js";
import { createDeployService } from "./deploy-service.js";
import { applyRollbackRestore } from "./rollback-restore.js";

export type RollbackCommandOptions = Omit<DeployCommandOptions, "buildContext"> & {
  /** THE DESTINATION-BOUND RESTORE PORT. ABSENT means the real one, so a production dispatch
   *  reaches `nodeBackupPorts()` and not only an injected double. */
  readonly backupPorts?: Pick<BackupPorts, "restoreDatabaseInto">;
  /** WHERE THIS HOST'S MIGRATIONS LIVE, host-scoped and forwarded from the composition root.
   *  `buildContext` stays omitted above because a rollback never BUILDS; this is the same
   *  directory under a name that says what the rollback actually needs it for — resolving which
   *  database the environment means, through the shared deploy-migration resolver. */
  readonly migrationWorkspace?: string;
};
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

function assertIdentity(record: CommandDecisionRecord, kind: string, requestBytes: Uint8Array, aggregateId: string): void {
  if (record.commandKind !== kind || record.effectDisposition !== "EFFECTS_COMMITTED"
    || record.targetAggregateId !== aggregateId) {
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

/** The immutable intent checks the offered project version before any remote operation.
 * A private environment stream has odd versions while reserved and even versions when free.
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
    const aggregateId = `rollback-request:${createHash("sha256").update(bytes(key)).digest("hex")}`;
    const guardId = `rollback-environment:${createHash("sha256").update(bytes({ projectId, environment: request.environment })).digest("hex")}`;
    const decided = store.getCommandDecision(key);
    if (decided !== null) assertIdentity(decided, KIND, requestBytes, aggregateId);
    const intentKey = { ...key, principalId: INTENT_PRINCIPAL };
    const intent = store.getCommandDecision(intentKey);
    if (intent !== null) assertIdentity(intent, INTENT_KIND, requestBytes, aggregateId);
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
    /**
     * THE DATABASE ARM, and its position is the whole of its safety.
     *
     * HERE, because every read-only guard above has now admitted the request and NOTHING durable
     * has been written yet: a restore that cannot resolve refuses without having reserved the
     * environment guard, and one that fails refuses without having half-rolled-back the
     * deployment. Earlier — where the blanket refusal used to sit — a request naming an invalid
     * receipt would have had its database restored and then been refused for the receipt.
     *
     * `intent === null` is the exact test for "this call performs the effect". A non-null intent
     * is receipt-backed RECOVERY of an already-admitted request, and the header above says
     * recovery may finish an admitted request but never retry uncertain effects — re-applying a
     * dump whose first attempt may have succeeded is precisely such a retry.
     *
     * NOT REQUESTED MEANS NOT CALLED: when `request.restore` is false nothing below runs, the
     * port is never even constructed, and it therefore records nothing at all.
     */
    if (request.restore && intent === null) {
      const restored = await applyRollbackRestore({
        credential: options.environmentCredential, now: clock, projectId,
        projectRoot: options.migrationWorkspace, store, workspace: options.migrationWorkspace,
      }, request.environment, options.backupPorts ?? nodeBackupPorts());
      // The binding's code and the LAYER THAT ANSWERED, forwarded unchanged: an unbound
      // environment still refuses DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE at this seam, and
      // a refusal the environment slice or the deploy resolver minted keeps its own layer.
      if (!restored.ok) throw new DomainRefusal(restored.code, restored.layer, restored.detail, 422);
    }
    const decidedAt = clock();
    let guardVersion: number;
    if (intent === null) {
      const priorGuardVersion = store.getAggregateVersion(guardId);
      if (priorGuardVersion % 2 !== 0) refuse("DEPLOY_ROLLBACK_IN_PROGRESS", undefined, 409);
      guardVersion = priorGuardVersion + 1;
      const admitted = store.commitExpectedVersionDecisionLegs({ commandKind: INTENT_KIND,
        committedResultBytes: bytes({ guardVersion }), correlationId: envelope.correlationId, decidedAt,
        key: intentKey, requestBytes, legs: [
          { aggregateId, expectedVersion: 0, events: [{ eventId: `${aggregateId}-requested`,
            eventType: "EnvironmentRollbackRequested", payload: requestBytes }] },
          { aggregateId: projectId, expectedVersion: envelope.expectedVersion, events: [] },
          { aggregateId: guardId, expectedVersion: priorGuardVersion,
            events: [{ eventId: `${aggregateId}-reserved`, eventType: "EnvironmentRollbackReserved", payload: requestBytes }] },
        ] });
      if (admitted.decision.effectDisposition !== "EFFECTS_COMMITTED") {
        refuse(admitted.decision.resultCode, undefined, 409);
      }
      // Another process may have won admission after our read. It alone owns execution.
      if (admitted.disposition === "REPLAYED") refuse("DEPLOY_ROLLBACK_IN_PROGRESS", undefined, 409);
    } else {
      const decoded = decodeBoundedJsonBytes(intent.resultBytes);
      const value = decoded.ok && decoded.value !== null && !Array.isArray(decoded.value)
        && typeof decoded.value === "object" && "guardVersion" in decoded.value ? decoded.value.guardVersion : null;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value % 2 !== 1) {
        refuse("DEPLOY_ROLLBACK_RECEIPT_INVALID");
      }
      guardVersion = value;
    }
    let receipt: DeployReceiptV1;
    if (recovered.ok) {
      validateReceipt(recovered.receipt);
      receipt = recovered.receipt;
    } else {
      // A ROLLED-BACK CANDIDATE IS STILL A CANDIDATE. It is started by the same `startCandidate`,
      // so it needs the same delivery: restoring an image whose process has no variables would
      // trade one broken deploy for another. Composed on the same wiring condition as the deploy's.
      const report = await createDeployService({ ...options,
        ports: options.ports ?? {
          ...productionDeployPorts(store, projectId),
          ...(options.environmentCredential === undefined ? {} : {
            environment: candidateEnvironmentPort({
              credential: options.environmentCredential, now: clock, projectId, store,
            }),
          }),
        } }).rollback({
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
    const committed = store.commitExpectedVersionDecisionLegs({ commandKind: KIND, committedResultBytes: result,
      correlationId: envelope.correlationId, decidedAt: clock(), key, requestBytes,
      legs: [
        { aggregateId, expectedVersion: 1,
          events: [{ eventId: `${receipt.receiptId}-rollback-decided`, eventType: "EnvironmentRollbackDecided", payload: result }] },
        { aggregateId: guardId, expectedVersion: guardVersion,
          events: [{ eventId: `${aggregateId}-released`, eventType: "EnvironmentRollbackReleased", payload: result }] },
      ] });
    if (committed.decision.effectDisposition !== "EFFECTS_COMMITTED") refuse(committed.decision.resultCode, undefined, 409);
    return outcome(committed.decision, receipt, intent !== null || committed.disposition === "REPLAYED");
  };
}
