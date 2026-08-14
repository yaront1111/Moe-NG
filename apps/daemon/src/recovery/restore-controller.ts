import type { DatabaseSync } from "node:sqlite";

import { reduceProject, type ProjectState } from "@moe/core";
import { DurableStoreError, RECOVERY_BINDING_CODEC_VERSION, encodeRecoveryBinding,
  type SqliteEventStore, verifyBackupGeneration } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { readAnchoredIncarnation } from "./recovery-incarnation-anchor.js";
import { readSuccessionChain } from "./recovery-succession.js";
import {
  RESTORE_BINDING_SLOT,
  RESTORE_CONTROLLER_SCHEMA_VERSION,
  controllerRefusal,
  decodeRestoreRecord,
  encodeRestoreRecord,
  preparedRestoreIdentity,
  restoreRefusal,
  snapshotRestoreRequest,
} from "./restore-controller-contract.js";
import { inspectGenesisFence } from "./restore-genesis-classifier.js";
import type {
  InstalledRestoreRecord,
  RestoreControllerFaultPoint,
  RestoreControllerRequest,
  RestoreInspection,
  RestoreRefused,
  RestoreResult,
} from "./restore-controller-contract.js";

type EncodedBinding = Extract<ReturnType<typeof encodeRecoveryBinding>, { readonly ok: true }>;
type ProjectAccepted = Extract<ReturnType<typeof reduceProject>, { readonly ok: true }>;
type CommitApply = Parameters<SqliteEventStore["commitWithApply"]>[1];
type DecisionInput = Parameters<SqliteEventStore["commitExpectedVersionDecision"]>[0];
type VerifiedGeneration = Extract<ReturnType<typeof verifyBackupGeneration>, { ok: true }>
  | RestoreRefused;

const encoder = new TextEncoder();
const DELETE_BINDING_SQL = "DELETE FROM recovery_bindings WHERE slot = ?";
const INSERT_BINDING_SQL = `INSERT INTO recovery_bindings (
  slot, incarnation_ref, key_epoch_ref, binding_codec_version,
  binding_digest, binding_bytes, installed_at
) VALUES (?, ?, ?, ?, ?, ?, ?)`;

export function readInstalledRestore(
  store: SqliteEventStore,
  projectId: string,
): RestoreInspection {
  let read: ReturnType<SqliteEventStore["readRecoveryBinding"]>;
  try {
    read = store.readRecoveryBinding(RESTORE_BINDING_SLOT);
  } catch (error) {
    return error instanceof DurableStoreError
      ? restoreRefusal("DURABLE_STORE", error.code)
      : controllerRefusal("RESTORE_RECORD_UNREADABLE");
  }
  if (!read.ok) return restoreRefusal(read.layer, read.code);
  if (read.outcome === "ABSENT") return Object.freeze({ ok: true, outcome: "ABSENT" });
  const record = decodeRestoreRecord(read.binding.payload);
  // NOT "null means genesis": the classifier demands positive exact proof and
  // otherwise returns this very same controller refusal. Absence of a restore
  // record is never, by itself, the presence of a fence.
  if (record === null) return inspectGenesisFence(store, projectId, read.binding);
  if (
    record.incarnationRef !== read.binding.incarnationRef
    || record.keyEpochRef !== read.binding.keyEpochRef
  ) {
    return controllerRefusal("RESTORE_RECORD_UNREADABLE");
  }
  return Object.freeze({
    bindingDigest: read.bindingDigest,
    ok: true,
    outcome: "INSTALLED",
    record,
  });
}

function declares(request: RestoreControllerRequest, point: RestoreControllerFaultPoint): boolean {
  return request.faults?.includes(point) === true;
}

function priorProject(store: SqliteEventStore, projectId: string): ProjectState | undefined {
  const state = stateOf(readDurableLedger(store, projectId), projectId);
  return state === undefined || state === null ? undefined : (state as unknown as ProjectState);
}

function writeBindingRow(database: DatabaseSync, encoded: EncodedBinding): void {
  const { binding } = encoded;
  database.prepare(DELETE_BINDING_SQL).run(binding.slot);
  database.prepare(INSERT_BINDING_SQL).run(
    binding.slot,
    binding.incarnationRef,
    binding.keyEpochRef,
    binding.bindingCodecVersion,
    encoded.digest,
    encoded.bytes,
    binding.installedAt,
  );
}

export function verifyRestoreGeneration(
  request: RestoreControllerRequest,
): VerifiedGeneration {
  try {
    const verified = verifyBackupGeneration(request.container, request.trust, {
      observedLogicalPaths: request.logicalPaths,
    });
    return verified.ok ? verified : restoreRefusal(verified.layer, verified.reason);
  } catch {
    return restoreRefusal("BACKUP_GENERATION", "REQUEST_SHAPE_INVALID");
  }
}

function settledOutcome(
  store: SqliteEventStore,
  request: RestoreControllerRequest,
  preparedIdentity: string,
): RestoreResult | null {
  const installed = readInstalledRestore(store, request.projectId);
  if (!installed.ok) return installed;
  // A verified genesis fence is NOT a settled restore: the store has never
  // restored, so the restore below proceeds and atomically replaces the fence
  // through the existing transaction. Treated exactly like ABSENT here.
  if (installed.outcome === "ABSENT" || installed.outcome === "GENESIS_FENCED") return null;
  const { record } = installed;
  if (record.preparedIdentity === preparedIdentity) {
    return Object.freeze({
      authority: "DURABLE_DECISION",
      bindingDigest: installed.bindingDigest,
      disposition: "ALREADY_QUIESCED",
      ok: true,
      preparedIdentity,
      record,
    });
  }
  if (record.incarnationRef === request.incarnationRef || record.keyEpochRef === request.keyEpochRef) {
    return controllerRefusal("RESTORE_FENCE_REPLAYED");
  }
  return null;
}

function decide(
  store: SqliteEventStore,
  request: RestoreControllerRequest,
  generationDigest: string,
  expectedVersion: number,
): ReturnType<typeof reduceProject> {
  return reduceProject(priorProject(store, request.projectId), {
    commandId: request.restoreCommandId,
    expectedVersion,
    kind: "recovery.restore_quiesce",
    witness: {
      backupGenerationHash: generationDigest,
      recoveryIncarnationRef: request.incarnationRef,
      truthClass: "DAEMON_VERIFIED",
    },
  });
}

function commitAccepted(
  store: SqliteEventStore,
  request: RestoreControllerRequest,
  preparedIdentity: string,
  record: InstalledRestoreRecord,
  verdict: ProjectAccepted,
  expectedVersion: number,
): RestoreResult {
  const encoded = encodeRecoveryBinding({
    bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
    incarnationRef: record.incarnationRef,
    installedAt: request.decidedAt,
    keyEpochRef: record.keyEpochRef,
    payload: encodeRestoreRecord(record),
    slot: RESTORE_BINDING_SLOT,
  });
  if (!encoded.ok) return restoreRefusal(encoded.layer, encoded.code);
  if (declares(request, "AFTER_REDUCER_BEFORE_COMMIT")) {
    return controllerRefusal("RESTORE_INTERRUPTED");
  }
  const [event] = verdict.events;
  if (event === undefined) return controllerRefusal("RESTORE_RECORD_UNREADABLE");
  return commitTransaction(store, request, preparedIdentity, encoded, event, verdict, expectedVersion);
}

function decisionInput(
  request: RestoreControllerRequest,
  preparedIdentity: string,
  event: ProjectAccepted["events"][number],
  verdict: ProjectAccepted,
  expectedVersion: number,
): DecisionInput {
  const commandId = `restore-quiesce:${preparedIdentity}`;
  return {
    commandKind: "recovery.restore_quiesce",
    committedResultBytes: encoder.encode(JSON.stringify(verdict.state)),
    correlationId: request.correlationId,
    decidedAt: request.decidedAt,
    events: [{
      eventId: `${commandId}:quiesced`,
      eventType: event.kind,
      payload: encoder.encode(JSON.stringify(event)),
    }],
    expectedVersion,
    key: { commandId, principalId: request.principalId, projectId: request.projectId },
    requestBytes: encoder.encode(JSON.stringify({
      kind: "recovery.restore_quiesce",
      preparedIdentity,
    })),
    targetAggregateId: request.projectId,
  };
}

function commitTransaction(
  store: SqliteEventStore,
  request: RestoreControllerRequest,
  preparedIdentity: string,
  encoded: EncodedBinding,
  event: ProjectAccepted["events"][number],
  verdict: ProjectAccepted,
  expectedVersion: number,
): RestoreResult {
  const apply: CommitApply = (context): void => {
    writeBindingRow(context.database, encoded);
    if (declares(request, "INSIDE_COMMIT_APPLY")) throw new Error("restore interrupted");
  };
  try {
    const input = decisionInput(request, preparedIdentity, event, verdict, expectedVersion);
    const committed = store.commitExpectedVersionDecisionWithApply(input, apply);
    if (committed.decision.effectDisposition !== "EFFECTS_COMMITTED") {
      return restoreRefusal("DURABLE_STORE", committed.decision.resultCode);
    }
  } catch (error) {
    if (declares(request, "INSIDE_COMMIT_APPLY")) return controllerRefusal("RESTORE_INTERRUPTED");
    if (error instanceof DurableStoreError) return restoreRefusal("DURABLE_STORE", error.code);
    return controllerRefusal("RESTORE_INTERRUPTED");
  }
  return Object.freeze({
    authority: "DURABLE_DECISION",
    bindingDigest: encoded.digest,
    disposition: "QUIESCED",
    event,
    ok: true,
    preparedIdentity,
    state: verdict.state,
  });
}

export function runSnapshottedRestoreQuiesce(
  store: SqliteEventStore,
  request: RestoreControllerRequest,
): RestoreResult {
  const verified = verifyRestoreGeneration(request);
  if (!verified.ok) return verified;
  const generationDigest = verified.manifest.generationDigest;
  const preparedIdentity = preparedRestoreIdentity({
    generationDigest,
    incarnationRef: request.incarnationRef,
    keyEpochRef: request.keyEpochRef,
    restoreCommandId: request.restoreCommandId,
  });
  const settled = settledOutcome(store, request, preparedIdentity);
  if (settled !== null) return settled;
  const anchored = readAnchoredIncarnation(store, request.projectId, request.incarnationRef);
  if (anchored === null) return controllerRefusal("RESTORE_INCARNATION_UNANCHORED");
  if (anchored.backupGenerationDigest !== generationDigest) {
    return controllerRefusal("RESTORE_GENERATION_NOT_BOUND");
  }
  if (anchored.restoreCommandId !== request.restoreCommandId) {
    return controllerRefusal("RESTORE_COMMAND_NOT_BOUND");
  }
  if (anchored.keyEpochRef !== request.keyEpochRef) {
    return controllerRefusal("RESTORE_KEY_EPOCH_MISMATCH");
  }
  const chain = readSuccessionChain(store, request.projectId, request.incarnationRef);
  if (!chain.ok) return restoreRefusal(chain.layer, chain.code);
  const record = Object.freeze({
    generationDigest,
    incarnationRef: request.incarnationRef,
    keyEpochRef: request.keyEpochRef,
    preparedIdentity,
    restoreCommandId: request.restoreCommandId,
    schemaVersion: RESTORE_CONTROLLER_SCHEMA_VERSION,
  });
  const expectedVersion = store.getAggregateVersion(request.projectId);
  const verdict = decide(store, request, generationDigest, expectedVersion);
  if (!verdict.ok) return restoreRefusal("PROJECT_REDUCER", verdict.error.code, verdict.error);
  return commitAccepted(store, request, preparedIdentity, record, verdict, expectedVersion);
}

export function runRestoreQuiesce(store: SqliteEventStore, input: unknown): RestoreResult {
  const request = snapshotRestoreRequest(input);
  return request === null
    ? controllerRefusal("RESTORE_REQUEST_SHAPE_INVALID")
    : runSnapshottedRestoreQuiesce(store, request);
}
