import { createHash } from "node:crypto";
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";
import { identifyReplayRequest } from "@moe/store";
import type { CommandDecisionRecord, SqliteEventStore } from "@moe/store";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import { DAEMON_COMMAND_SEAM } from "../http/http-async-contract.js";
import type { CommandHandlerInput } from "../http/http-contract.js";

export const MIGRATE_DOWN_KIND = "deployment.migrate_down" as const;
const INTENT_KIND = "internal.deployment.migrate_down_requested";
const INTENT_PRINCIPAL = "daemon:migrate-down-command";
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
export const migrateDownRefuse = (code: string, status = 422): never => {
  throw new DomainRefusal(code, DAEMON_COMMAND_SEAM, code, status);
};

export type MigrationCommandTerminal = Readonly<{ outcome: "RECEIPTED"; receiptId: string }>
  | Readonly<{ outcome: "REFUSED"; code: string; layer: string; detail: string; httpStatus: number }>;

export function migrationCommandIdentity(input: CommandHandlerInput, projectId: string) {
  const { envelope, principal } = input;
  if (principal.projectId !== projectId) migrateDownRefuse("MIGRATE_DOWN_PROJECT_MISMATCH", 403);
  if (envelope.targetAggregateId !== projectId) migrateDownRefuse("MIGRATE_DOWN_TARGET_INVALID");
  const payload = envelope.payload;
  const environment = payload["environment"], sourceRequestId = payload["toMigrationRequestId"];
  if (envelope.commandKind !== MIGRATE_DOWN_KIND || envelope.commandId.length === 0
    || !Number.isSafeInteger(envelope.expectedVersion) || envelope.expectedVersion < 0
    || Object.keys(payload).length !== 2 || typeof environment !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(environment)
    || typeof sourceRequestId !== "string" || sourceRequestId.length === 0 || sourceRequestId.length > 4096) {
    return migrateDownRefuse("MIGRATE_DOWN_REQUEST_INVALID");
  }
  const requestBytes = encode({ kind: MIGRATE_DOWN_KIND, projectId, principalId: principal.principalId,
    targetAggregateId: envelope.targetAggregateId, expectedVersion: envelope.expectedVersion,
    payload: { environment, toMigrationRequestId: sourceRequestId } });
  const key = { commandId: envelope.commandId, principalId: principal.principalId, projectId };
  const aggregateId = `migrate-down-request:${createHash("sha256").update(encode(key)).digest("hex")}`;
  const guardAggregateId = `migrate-down-environment:${createHash("sha256")
    .update(encode([projectId, environment])).digest("hex")}`;
  return { environment, sourceRequestId, requestBytes, key, expectedVersion: envelope.expectedVersion,
    aggregateId, guardAggregateId, correlationId: envelope.correlationId,
    intentKey: { ...key, principalId: INTENT_PRINCIPAL } };
}
export type MigrationCommandIdentity = ReturnType<typeof migrationCommandIdentity>;

function assertIdentity(
  record: CommandDecisionRecord, kind: string, identity: MigrationCommandIdentity, expectedVersion: number,
): void {
  if (record.commandKind !== kind || record.effectDisposition !== "EFFECTS_COMMITTED") {
    migrateDownRefuse("MIGRATE_DOWN_COMMAND_ID_SPENT", 409);
  }
  if (record.targetAggregateId !== identity.aggregateId || record.expectedVersion !== expectedVersion) {
    migrateDownRefuse("MIGRATE_DOWN_COMMAND_RESULT_INVALID");
  }
  if (identifyReplayRequest(record, identity.requestBytes) !== record.replayRequestSha256) {
    migrateDownRefuse("MIGRATE_DOWN_COMMAND_BYTES_CONFLICT", 409);
  }
}

function intentGuardVersion(record: CommandDecisionRecord): number {
  const decoded = decodeBoundedJsonBytes(record.resultBytes);
  if (!decoded.ok || decoded.value === null || Array.isArray(decoded.value) || typeof decoded.value !== "object") {
    return migrateDownRefuse("MIGRATE_DOWN_COMMAND_RESULT_INVALID");
  }
  const value = decoded.value as JsonObject, version = value["guardVersion"];
  if (Object.keys(value).length !== 1 || typeof version !== "number" || !Number.isSafeInteger(version)
    || version <= 0 || version % 2 !== 1) return migrateDownRefuse("MIGRATE_DOWN_COMMAND_RESULT_INVALID");
  return version;
}

export function migrationCommandHistory(store: SqliteEventStore, identity: MigrationCommandIdentity) {
  const decided = store.getCommandDecision(identity.key);
  const intent = store.getCommandDecision(identity.intentKey);
  if (decided !== null) assertIdentity(decided, MIGRATE_DOWN_KIND, identity, 1);
  if (intent !== null) { assertIdentity(intent, INTENT_KIND, identity, 0); intentGuardVersion(intent); }
  if (decided !== null && intent === null) migrateDownRefuse("MIGRATE_DOWN_COMMAND_RESULT_INVALID");
  return { decided, intent };
}

export function readMigrationCommandTerminal(record: CommandDecisionRecord): MigrationCommandTerminal {
  const decoded = decodeBoundedJsonBytes(record.resultBytes);
  if (!decoded.ok || decoded.value === null || Array.isArray(decoded.value) || typeof decoded.value !== "object") {
    return migrateDownRefuse("MIGRATE_DOWN_COMMAND_RESULT_INVALID");
  }
  const v = decoded.value as JsonObject;
  if (v["outcome"] === "RECEIPTED" && Object.keys(v).length === 2
    && typeof v["receiptId"] === "string" && /^[a-f0-9]{64}$/u.test(v["receiptId"])) {
    return { outcome: "RECEIPTED", receiptId: v["receiptId"] };
  }
  if (v["outcome"] === "REFUSED" && Object.keys(v).length === 5
    && typeof v["code"] === "string" && typeof v["layer"] === "string" && typeof v["detail"] === "string"
    && typeof v["httpStatus"] === "number" && Number.isInteger(v["httpStatus"])
    && v["httpStatus"] >= 400 && v["httpStatus"] <= 599) {
    return { outcome: "REFUSED", code: v["code"], layer: v["layer"], detail: v["detail"], httpStatus: v["httpStatus"] };
  }
  return migrateDownRefuse("MIGRATE_DOWN_COMMAND_RESULT_INVALID");
}

/** The project leg only guards its reducer-owned version. A private environment guard stays
 * odd while a command owns it, including interrupted effects without a durable receipt. */
export function reserveMigrationCommand(
  store: SqliteEventStore, identity: MigrationCommandIdentity, decidedAt: string,
): void {
  const { aggregateId, guardAggregateId } = identity;
  const guardVersion = store.getAggregateVersion(guardAggregateId);
  if (guardVersion % 2 !== 0) migrateDownRefuse("MIGRATE_DOWN_IN_PROGRESS", 409);
  const admitted = store.commitExpectedVersionDecisionLegs({ commandKind: INTENT_KIND,
    committedResultBytes: encode({ guardVersion: guardVersion + 1 }), correlationId: identity.correlationId, decidedAt,
    key: identity.intentKey, requestBytes: identity.requestBytes, legs: [
      { aggregateId, expectedVersion: 0, events: [{ eventId: `${aggregateId}-requested`,
        eventType: "EnvironmentMigrateDownRequested", payload: identity.requestBytes }] },
      { aggregateId: identity.key.projectId, expectedVersion: identity.expectedVersion,
        events: [] },
      { aggregateId: guardAggregateId, expectedVersion: guardVersion,
        events: [{ eventId: `${aggregateId}-guard-acquired`, eventType: "EnvironmentMigrateDownGuardAcquired",
          payload: identity.requestBytes }] },
    ] });
  if (admitted.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    migrateDownRefuse(admitted.decision.resultCode, 409);
  }
  if (admitted.disposition === "REPLAYED") migrateDownRefuse("MIGRATE_DOWN_IN_PROGRESS", 409);
}

export function finishMigrationCommand(
  store: SqliteEventStore, identity: MigrationCommandIdentity, terminal: MigrationCommandTerminal,
  decidedAt: string, eventPayload: unknown = terminal,
): CommandDecisionRecord {
  const history = migrationCommandHistory(store, identity);
  if (history.decided !== null) return history.decided;
  if (history.intent === null) return migrateDownRefuse("MIGRATE_DOWN_COMMAND_RESULT_INVALID");
  const guardVersion = intentGuardVersion(history.intent);
  // No receipt means effects may have happened without durable evidence. Only the explicit
  // project-lock refusal proves the engine did not enter its effect section.
  const releaseGuard = terminal.outcome === "RECEIPTED" || terminal.code === "MIGRATION_IN_PROGRESS";
  const result = store.commitExpectedVersionDecisionLegs({ commandKind: MIGRATE_DOWN_KIND,
    committedResultBytes: encode(terminal), correlationId: identity.correlationId, decidedAt,
    key: identity.key, requestBytes: identity.requestBytes, legs: [
      { aggregateId: identity.aggregateId, expectedVersion: 1, events: [{
        eventId: `${identity.aggregateId}-decided`,
        eventType: "EnvironmentMigrateDownDecided", payload: encode(eventPayload),
      }] },
      { aggregateId: identity.guardAggregateId, expectedVersion: guardVersion,
        events: releaseGuard ? [{ eventId: `${identity.aggregateId}-guard-released`,
          eventType: "EnvironmentMigrateDownGuardReleased", payload: encode(terminal) }] : [] },
    ] });
  if (result.decision.effectDisposition !== "EFFECTS_COMMITTED") migrateDownRefuse(result.decision.resultCode, 409);
  assertIdentity(result.decision, MIGRATE_DOWN_KIND, identity, 1);
  return result.decision;
}
