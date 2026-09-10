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
import { applyResolvedRestore, resolveRollbackRestore } from "./rollback-restore.js";
import type { RollbackRestoreResolved } from "./rollback-restore.js";

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
/** The applied-restore MARKER's own decision key and kind. A third principal on the same command
 *  id, so the marker is a decision of its own and cannot be confused with intent or terminal. */
const RESTORE_KIND = "internal.deployment.rollback_restore_applied";
const RESTORE_PRINCIPAL = "daemon:rollback-restore";
/** Request stream versions: 1 after the request event, 2 once the restore marker has landed. */
const REQUESTED_VERSION = 1, RESTORED_VERSION = 2;
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

/**
 * A TERMINAL THAT REFUSED, read back off its own decision — the one durable answer this command
 * can carry with NO receipt behind it. Shape-exact on purpose: anything that is not a refused
 * terminal falls through to the caller's RECEIPT_INVALID rather than being interpreted loosely.
 */
function refusedTerminal(record: CommandDecisionRecord): { code: string; detail: string; layer: string } | null {
  const decoded = decodeBoundedJsonBytes(record.resultBytes);
  if (!decoded.ok || decoded.value === null || typeof decoded.value !== "object" || Array.isArray(decoded.value)) {
    return null;
  }
  const result = decoded.value;
  // `in` rather than an index read: the decoder's values are `JsonObject | readonly JsonValue[]`
  // and only the `in` narrowing rules out the array arm without an assertion.
  if (!("outcome" in result) || !("receiptId" in result) || !("refusal" in result)) return null;
  const refusal = result.refusal;
  if (result.outcome !== "REFUSED" || result.receiptId !== null || refusal === null
    || typeof refusal !== "object" || !("code" in refusal) || !("detail" in refusal) || !("layer" in refusal)) {
    return null;
  }
  const code = refusal.code, detail = refusal.detail, layer = refusal.layer;
  if (typeof code !== "string" || typeof detail !== "string" || typeof layer !== "string") return null;
  return { code, detail, layer };
}

function outcome(record: CommandDecisionRecord, receipt: DeployReceiptV1, replayed: boolean): DurableDecision {
  if (receipt.refusal !== null) {
    throw new DomainRefusal(receipt.refusal.code, receipt.refusal.layer, receipt.refusal.detail);
  }
  return { commandId: record.key.commandId, disposition: replayed ? "REPLAYED" : "DECIDED",
    effectId: record.decisionId, resultCode: record.resultCode };
}

/**
 * ADMISSION FIRST, THEN EFFECTS — and the database restore is an effect like any other.
 *
 * The offered project version is checked by the intent commit, and NOTHING that moves a byte of
 * anyone's data runs before it. The restore is split across that line deliberately: its READ half
 * (which database, which dump) runs pre-admission, so a request whose restore cannot be resolved
 * refuses having reserved nothing; its APPLY half runs after the intent commit, inside the
 * reserved environment guard and after the project leg has agreed on the version. A refused
 * admission therefore leaves the schema untouched.
 *
 * A private environment stream has odd versions while reserved and even versions when free.
 * A process that dies without a receipt leaves a pending request, never permission to retry
 * uncertain effects. Receipt-backed recovery may finish only the already admitted request.
 */
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
      if (intent === null) refuse("DEPLOY_ROLLBACK_RECEIPT_INVALID");
      if (!recovered.ok) {
        // A REFUSED TERMINAL HAS NO RECEIPT, and that is not a corrupt decision. Replaying it
        // answers the code and layer that were durably recorded — never a fresh attempt, and
        // never RECEIPT_INVALID, which would report the wrong cause for the rest of time.
        const refusal = refusedTerminal(decided);
        if (refusal === null) refuse("DEPLOY_ROLLBACK_RECEIPT_INVALID");
        throw new DomainRefusal(refusal.code, refusal.layer, refusal.detail, 422);
      }
      validateReceipt(recovered.receipt);
      return outcome(decided, recovered.receipt, true);
    }
    if (intent !== null && !recovered.ok) refuse("DEPLOY_ROLLBACK_IN_PROGRESS", undefined, 409);
    if (intent === null && (recovered.ok || recovered.code !== "DEPLOY_RECEIPT_NOT_FOUND")) {
      refuse("DEPLOY_ROLLBACK_COMMAND_ID_SPENT", undefined, 409);
    }
    /**
     * THE DATABASE ARM'S READ HALF, and its position is half of the arm's safety.
     *
     * HERE, and only the RESOLVE, because every read-only guard above has admitted the request and
     * nothing durable has been written yet: a restore that cannot name its destination or its dump
     * refuses without having reserved the environment guard, and without having moved a byte —
     * `resolveRollbackRestore` is not even handed a port. Earlier, where the blanket refusal used
     * to sit, a request naming an invalid receipt would have had its database restored and then
     * been refused for the receipt.
     *
     * THE APPLY IS NOT HERE. It waits below, past the intent commit, because the offered project
     * version is checked THERE: performing the effect at this line is what let a rollback that
     * would go on to refuse EXPECTED_VERSION_CONFLICT or IN_PROGRESS restore the database first.
     *
     * `intent === null` is the exact test for "this call performs the effect". A non-null intent
     * is receipt-backed RECOVERY of an already-admitted request, and the header above says
     * recovery may finish an admitted request but never retry uncertain effects — re-applying a
     * dump whose first attempt may have succeeded is precisely such a retry.
     *
     * NOT REQUESTED MEANS NOT CALLED: when `request.restore` is false nothing here or below runs,
     * the port is never even constructed, and it therefore records nothing at all.
     */
    let resolved: RollbackRestoreResolved | null = null;
    if (request.restore && intent === null) {
      const resolution = await resolveRollbackRestore({
        credential: options.environmentCredential, now: clock, projectId,
        projectRoot: options.migrationWorkspace, store, workspace: options.migrationWorkspace,
      }, request.environment);
      // The binding's code and the LAYER THAT ANSWERED, forwarded unchanged: an unbound
      // environment still refuses DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE at this seam, and
      // a refusal the environment slice or the deploy resolver minted keeps its own layer.
      if (!resolution.ok) throw new DomainRefusal(resolution.code, resolution.layer, resolution.detail, 422);
      resolved = resolution;
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
      /**
       * THE DATABASE ARM'S APPLY HALF. Past both fences: the project version has been agreed and
       * the environment guard is ours. Everything that can refuse this command without touching
       * the schema has already refused.
       *
       * A CRASH BETWEEN HERE AND THE MARKER leaves the guard odd and no receipt, so the
       * environment reads IN_PROGRESS — the same window the Docker phase below has always had,
       * and deliberate: an effect whose outcome is unknown may not be replayed by a fresh command.
       *
       * THE RESIDUAL, stated rather than hidden: psql applies the dump in one transaction, so an
       * apply that returns has committed. If a LATER phase then refuses, the terminal releases the
       * guard and a fresh command may resolve and apply the same dump again. That is
       * content-idempotent for the schema, but any write that landed between the two applies is
       * destroyed. Narrowing that needs the deploy phase inside the same fence, which is a
       * different change from this one.
       */
      if (resolved !== null) {
        const applied = await applyResolvedRestore(resolved, options.backupPorts ?? nodeBackupPorts());
        if (!applied.ok) {
          // A REFUSED TERMINAL, NOT A RECEIPT. Deploy receipts carry a closed roster of engine
          // codes, so a restore refusal cannot be one without being rewritten into a code the
          // operator never hit — and a REFUSED row would then stand as the environment's CURRENT
          // deploy. The terminal decision carries the refusal instead and releases the guard in
          // the same commit, so a fresh command is admitted. Same shape as `finishMigrationCommand`.
          //
          // IF THIS COMMIT ITSELF THROWS the exception escapes and the guard stays odd, exactly as
          // a throw from the success terminal below has always left it. Not swallowed: the dump is
          // already applied at this point, so an environment left IN_PROGRESS is the honest answer
          // for an effect this process can no longer record.
          const refusedBytes = bytes({ environment: request.environment, outcome: "REFUSED",
            receiptId: null, refusal: { code: applied.code, detail: applied.detail, layer: applied.layer },
            restoreApplied: false, toReceiptRef: request.receiptId });
          const released = store.commitExpectedVersionDecisionLegs({ commandKind: KIND,
            committedResultBytes: refusedBytes, correlationId: envelope.correlationId, decidedAt: clock(),
            key, requestBytes, legs: [
              { aggregateId, expectedVersion: REQUESTED_VERSION, events: [{ eventId: `${aggregateId}-rollback-decided`,
                eventType: "EnvironmentRollbackDecided", payload: refusedBytes }] },
              { aggregateId: guardId, expectedVersion: guardVersion, events: [{ eventId: `${aggregateId}-released`,
                eventType: "EnvironmentRollbackReleased", payload: refusedBytes }] },
            ] });
          if (released.decision.effectDisposition !== "EFFECTS_COMMITTED") {
            refuse(released.decision.resultCode, undefined, 409);
          }
          // The caller's answer is the binding's own, unchanged by having been recorded.
          throw new DomainRefusal(applied.code, applied.layer, applied.detail, 422);
        }
        // THE MARKER, so recovery can tell an applied restore from an unapplied one. `dump` is a
        // path; `databaseUrl` is the credential and never reaches this or any other payload.
        const marker = bytes({ dump: applied.dump });
        const recorded = store.commitExpectedVersionDecisionLegs({ commandKind: RESTORE_KIND,
          committedResultBytes: marker, correlationId: envelope.correlationId, decidedAt,
          key: { ...key, principalId: RESTORE_PRINCIPAL }, requestBytes,
          legs: [{ aggregateId, expectedVersion: REQUESTED_VERSION, events: [{
            eventId: `${aggregateId}-restore-applied`,
            eventType: "EnvironmentRollbackRestoreApplied", payload: marker }] }] });
        // An unrecorded apply is an effect nobody can account for. Refusing here holds the guard
        // odd, which is the honest answer for an outcome this process can no longer prove.
        if (recorded.decision.effectDisposition !== "EFFECTS_COMMITTED") {
          refuse(recorded.decision.resultCode, undefined, 409);
        }
      }
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
    /**
     * DERIVED FROM THE STREAM, never from a local flag, because RECOVERY has no local flag to
     * read: an admitted request finished by a later process learns whether the restore landed
     * only from the marker. It NEVER REFUSES on a missing one — a rollback admitted under the old
     * ordering carries no marker at all, and refusing would strand every such commandId forever.
     */
    const restoreApplied = store.getAggregateVersion(aggregateId) === RESTORED_VERSION;
    const result = bytes({ environment: request.environment, toReceiptRef: request.receiptId,
      receiptId: receipt.receiptId, outcome: receipt.outcome, restoreApplied });
    const committed = store.commitExpectedVersionDecisionLegs({ commandKind: KIND, committedResultBytes: result,
      correlationId: envelope.correlationId, decidedAt: clock(), key, requestBytes,
      legs: [
        { aggregateId, expectedVersion: restoreApplied ? RESTORED_VERSION : REQUESTED_VERSION,
          events: [{ eventId: `${receipt.receiptId}-rollback-decided`, eventType: "EnvironmentRollbackDecided", payload: result }] },
        { aggregateId: guardId, expectedVersion: guardVersion,
          events: [{ eventId: `${aggregateId}-released`, eventType: "EnvironmentRollbackReleased", payload: result }] },
      ] });
    if (committed.decision.effectDisposition !== "EFFECTS_COMMITTED") refuse(committed.decision.resultCode, undefined, 409);
    return outcome(committed.decision, receipt, intent !== null || committed.disposition === "REPLAYED");
  };
}
