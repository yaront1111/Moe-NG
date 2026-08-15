import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";
import type { ProjectState } from "@moe/core";
import { DurableStoreError } from "@moe/store";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import {
  RECOVERY_COMPLETE_PAYLOAD_KEYS,
  RECOVERY_COMPLETION_COMMAND_KIND,
  RECOVERY_COMPLETION_LAYER,
  RECOVERY_COMPLETION_SCHEMA_VERSION,
  recoveryCompletionDigest,
  recoveryCompletionRefusal,
  recoveryCoverageProofDigest,
} from "./recovery-completion-digest.js";
import type {
  RecoveryCompletionEvidence,
  RecoveryCompletionRefused,
} from "./recovery-completion-digest.js";
import { readAnchoredIncarnation } from "./recovery-incarnation-anchor.js";
import { RECOVERY_INVENTORY_LAYER } from "./recovery-inventory-contract.js";
import type { RecoveryReconciliationRecord } from "./recovery-inventory-contract.js";
import { readRecoveryReconciliation } from "./recovery-inventory-ledger.js";
import { RESTORE_BINDING_SLOT } from "./restore-controller-contract.js";
import { readInstalledRestore } from "./restore-controller.js";

/**
 * Envelope decoding and SERVER-READ evidence for `recovery.complete`.
 *
 * Split from `recovery-completion.ts` purely to hold the per-file line cap: this
 * module answers "what does the store actually hold, and what digest does that
 * bind to", and the service module answers "is this approval allowed to act on
 * it". Nothing here writes, and nothing here trusts a caller field.
 *
 * The reconciliation record, the installed restore, the anchored incarnation and
 * the project state must all agree. Any one of them missing is ABSENT and any
 * disagreement between them is MISMATCH, both fail-closed, because a completion
 * built on three sources that disagree is not evidence of anything.
 */

export const CORE_APPROVAL_LAYER = "CORE_APPROVAL" as const;
export const PROJECT_REDUCER_LAYER = "PROJECT_REDUCER" as const;
export const DAEMON_INGRESS_LAYER = "DAEMON_INGRESS" as const;
export const DURABLE_STORE_LAYER = "DURABLE_STORE" as const;

const HEX64 = /^[0-9a-f]{64}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const REQUEST_KEYS = Object.freeze([
  "commandId", "correlationId", "decidedAt", "expectedVersion", "kind",
  "payload", "principalId", "projectId", "schemaVersion",
]);

export interface RecoveryCompleteRequest {
  readonly approval: unknown;
  readonly authentication: unknown;
  readonly bytes: Uint8Array;
  readonly command: unknown;
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly expectedVersion: number;
  readonly principalId: string;
  readonly projectId: string;
  readonly reconciliationDigest: string;
}

export type RecoveryCompleteDecodeResult =
  | { readonly ok: true; readonly request: RecoveryCompleteRequest }
  | { readonly ok: false; readonly refusal: RecoveryCompletionRefused };

export interface RecoveryCompletionEvidenceFound {
  readonly coverageProofHash: string;
  readonly digest: string;
  readonly evidence: RecoveryCompletionEvidence;
  readonly ok: true;
  readonly record: RecoveryReconciliationRecord;
}

export type RecoveryCompletionEvidenceResult =
  | RecoveryCompletionEvidenceFound
  | RecoveryCompletionRefused;

export const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const isHex64 = (value: unknown): value is string =>
  typeof value === "string" && HEX64.test(value);

export const isInstant = (value: unknown): value is string =>
  typeof value === "string" && ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value));

export const malformedRequest = (): RecoveryCompletionRefused =>
  recoveryCompletionRefusal({
    code: "RECOVERY_COMPLETION_REQUEST_MALFORMED",
    kind: null,
    reason: "The recovery completion request is not the exact envelope this command admits.",
    refusedBy: DAEMON_INGRESS_LAYER,
  });

export const evidenceAbsent = (
  reason: string,
  upstream?: { readonly code: string; readonly layer: string },
): RecoveryCompletionRefused =>
  recoveryCompletionRefusal({
    code: "RECOVERY_COMPLETION_EVIDENCE_ABSENT", reason,
    refusedBy: RECOVERY_COMPLETION_LAYER, upstream: upstream ?? null,
  });

export const evidenceMismatched = (reason: string): RecoveryCompletionRefused =>
  recoveryCompletionRefusal({
    code: "RECOVERY_COMPLETION_EVIDENCE_MISMATCH", reason, refusedBy: RECOVERY_COMPLETION_LAYER,
  });

export const completionStale = (upstreamCode: string | null): RecoveryCompletionRefused =>
  recoveryCompletionRefusal({
    code: "RECOVERY_COMPLETION_STALE",
    reason: "The project moved since the version this completion observed.",
    refusedBy: RECOVERY_COMPLETION_LAYER,
    upstream: upstreamCode === null ? null : { code: upstreamCode, layer: DURABLE_STORE_LAYER },
  });

export const completionIdempotencyConflict = (): RecoveryCompletionRefused =>
  recoveryCompletionRefusal({
    code: "RECOVERY_COMPLETION_IDEMPOTENCY_CONFLICT",
    reason: "This command identity is already bound to different request bytes.",
    refusedBy: RECOVERY_COMPLETION_LAYER,
    upstream: { code: "IDEMPOTENCY_CONFLICT", layer: DURABLE_STORE_LAYER },
  });

/** A genuine store fault is never reported as a benign refusal of the request. */
export const storeUnavailable = (error: unknown): RecoveryCompletionRefused =>
  recoveryCompletionRefusal({
    code: "RECOVERY_COMPLETION_STORE_UNAVAILABLE",
    reason: "The durable store could not answer a read this completion depends on.",
    refusedBy: RECOVERY_COMPLETION_LAYER,
    upstream: error instanceof DurableStoreError
      ? { code: error.code, layer: DURABLE_STORE_LAYER }
      : null,
  });

function readEnvelope(input: unknown): Record<string, unknown> | null {
  if (!(input instanceof Uint8Array)) return null;
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok) return null;
  const value = decoded.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== REQUEST_KEYS.length || !keys.every((key) => REQUEST_KEYS.includes(key))) {
    return null;
  }
  if (
    record["kind"] !== RECOVERY_COMPLETION_COMMAND_KIND
    || record["schemaVersion"] !== RECOVERY_COMPLETION_SCHEMA_VERSION
    || !nonEmpty(record["commandId"]) || !nonEmpty(record["correlationId"])
    || !nonEmpty(record["principalId"]) || !nonEmpty(record["projectId"])
    || !isInstant(record["decidedAt"])
    || typeof record["expectedVersion"] !== "number"
    || !Number.isSafeInteger(record["expectedVersion"]) || record["expectedVersion"] < 0
  ) {
    return null;
  }
  return record;
}

/**
 * Envelope only. Section VALUES pass through untouched and only key sets are
 * fenced: an extra payload key is REFUSED rather than dropped, because silently
 * ignoring a caller-supplied `witness` would look like it was honoured.
 */
export function decodeRecoveryCompleteRequest(input: unknown): RecoveryCompleteDecodeResult {
  const record = readEnvelope(input);
  if (record === null || !(input instanceof Uint8Array)) {
    return { ok: false, refusal: malformedRequest() };
  }
  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, refusal: malformedRequest() };
  }
  const payloadKeys = Object.keys(payload);
  const admitted = RECOVERY_COMPLETE_PAYLOAD_KEYS as readonly string[];
  if (payloadKeys.length !== admitted.length || !payloadKeys.every((k) => admitted.includes(k))) {
    return { ok: false, refusal: malformedRequest() };
  }
  const section = payload as JsonObject;
  if (!isHex64(section["reconciliationDigest"])) {
    return { ok: false, refusal: malformedRequest() };
  }
  return {
    ok: true,
    request: Object.freeze({
      approval: section["approval"],
      authentication: section["authentication"],
      bytes: input,
      command: section["command"],
      commandId: record["commandId"] as string,
      correlationId: record["correlationId"] as string,
      decidedAt: record["decidedAt"] as string,
      expectedVersion: record["expectedVersion"] as number,
      principalId: record["principalId"] as string,
      projectId: record["projectId"] as string,
      reconciliationDigest: section["reconciliationDigest"],
    }),
  };
}

/** One synchronous own-descriptor snapshot; an accessor cannot answer twice. */
export function projectStateOf(
  store: SqliteEventStore,
  projectId: string,
): ProjectState | null {
  const state = stateOf(readDurableLedger(store, projectId), projectId);
  if (state === null || state === undefined || typeof state !== "object" || Array.isArray(state)) {
    return null;
  }
  const snapshot = Object.fromEntries(
    Object.entries(Object.getOwnPropertyDescriptors(state))
      .filter(([, descriptor]) => descriptor.enumerable === true && descriptor.get === undefined)
      .map(([key, descriptor]) => [key, descriptor.value]),
  );
  return Object.freeze(snapshot) as unknown as ProjectState;
}

/** Reads the activation policy the restored project is durably running under. */
function policyRevisionOf(store: SqliteEventStore, projectId: string): string | null {
  let cursor = 0;
  let policy: string | null = null;
  for (;;) {
    const page = store.readAggregateEvents(projectId, cursor, 1_000);
    for (const event of page.items) {
      if (event.eventType !== "ProjectActivated") continue;
      const decoded = decodeBoundedJsonBytes(event.payload);
      if (!decoded.ok || decoded.value === null || typeof decoded.value !== "object"
        || Array.isArray(decoded.value)) return null;
      const witness = (decoded.value as JsonObject)["witness"];
      if (witness === null || typeof witness !== "object" || Array.isArray(witness)) return null;
      const candidate = (witness as JsonObject)["policyRevisionHash"];
      if (!isHex64(candidate) || (policy !== null && candidate !== policy)) return null;
      policy = candidate;
    }
    if (!page.hasMore) return policy;
    if (page.nextCursor === null || page.nextCursor <= cursor) return null;
    cursor = page.nextCursor;
  }
}

function assemble(
  record: RecoveryReconciliationRecord,
  backupCursor: string,
  policyRevisionRef: string,
  restoreCommandId: string,
  restoreGenerationDigest: string,
): RecoveryCompletionEvidenceFound {
  const evidence: RecoveryCompletionEvidence = Object.freeze({
    anchorBindingDigest: record.anchorBindingDigest,
    backupCursor,
    backupGenerationDigest: record.backupGenerationDigest,
    configuredClasses: Object.freeze([...record.configuredClasses]),
    incarnationRef: record.incarnationRef,
    items: Object.freeze(record.items.map((item) => Object.freeze({
      class: item.class, disposition: item.disposition, identity: item.identity,
      population: item.population, quarantineRef: item.quarantineRef,
      sourceProofDigest: item.sourceProofDigest,
    }))),
    keyEpochRef: record.keyEpochRef,
    policyRevisionRef,
    projectId: record.projectId,
    projectTag: record.projectTag,
    proofs: Object.freeze(record.proofs.map((proof) => Object.freeze({
      class: proof.class, itemCount: proof.itemCount,
      sourceProofDigest: proof.sourceProofDigest, truth: proof.truth,
    }))),
    reconciliationRecordDigest: record.recordDigest,
    restoreBindingSlot: RESTORE_BINDING_SLOT,
    restoreCommandId,
    restoreGenerationDigest,
  });
  return Object.freeze({
    coverageProofHash: recoveryCoverageProofDigest(evidence.configuredClasses, evidence.proofs),
    digest: recoveryCompletionDigest(evidence),
    evidence,
    ok: true as const,
    record,
  });
}

function crossCheck(
  store: SqliteEventStore,
  projectId: string,
  record: RecoveryReconciliationRecord,
): RecoveryCompletionEvidenceResult {
  let installed: ReturnType<typeof readInstalledRestore>;
  let anchored: ReturnType<typeof readAnchoredIncarnation>;
  let policyRevisionRef: string | null;
  let state: ProjectState | null;
  try {
    installed = readInstalledRestore(store, projectId);
    anchored = readAnchoredIncarnation(store, projectId, record.incarnationRef);
    policyRevisionRef = policyRevisionOf(store, projectId);
    state = projectStateOf(store, projectId);
  } catch (error) {
    return storeUnavailable(error);
  }
  if (!installed.ok) {
    return evidenceAbsent("No installed restore is readable for this project.", {
      code: installed.code, layer: installed.layer,
    });
  }
  if (installed.outcome !== "INSTALLED") {
    return evidenceAbsent(`The restore slot is ${installed.outcome}, not an installed restore.`);
  }
  if (anchored === null) {
    return evidenceAbsent("The record's incarnation is not durably anchored.");
  }
  if (state === null) return evidenceAbsent("The project has no durable state to complete.");
  if (policyRevisionRef === null) {
    return evidenceAbsent("The restored project has no readable activation policy revision.");
  }
  const restore = installed.record;
  if (
    anchored.keyEpochRef !== record.keyEpochRef
    || anchored.bindingDigest !== record.anchorBindingDigest
    || anchored.backupGenerationDigest !== record.backupGenerationDigest
    || restore.incarnationRef !== record.incarnationRef
    || restore.backupCursor !== record.backupCursor
    || restore.keyEpochRef !== record.keyEpochRef
    || restore.generationDigest !== record.backupGenerationDigest
    || restore.restoreCommandId !== anchored.restoreCommandId
    || record.projectId !== projectId
  ) {
    return evidenceMismatched("The restore, the anchor and the reconciliation record disagree.");
  }
  if (state.lifecycle !== "QUIESCED" || state.recoveryRequired !== true) {
    return evidenceMismatched("The project is not quiesced and awaiting recovery completion.");
  }
  return assemble(
    record, restore.backupCursor, policyRevisionRef,
    restore.restoreCommandId, restore.generationDigest,
  );
}

/**
 * The server-read evidence tuple and the digest an R3 approval must bind to.
 * Exported so an operator — and the suite — learns the digest through the same
 * code path the command uses, instead of recomputing it somewhere else.
 */
export function readRecoveryCompletionEvidence(
  store: SqliteEventStore,
  projectId: string,
  reconciliationDigest: string,
): RecoveryCompletionEvidenceResult {
  let read: ReturnType<typeof readRecoveryReconciliation>;
  try {
    read = readRecoveryReconciliation(store, projectId, reconciliationDigest);
  } catch (error) {
    return storeUnavailable(error);
  }
  if (!read.ok) {
    return recoveryCompletionRefusal({
      code: read.code, reason: read.reason, refusedBy: read.layer, upstream: read.upstream,
    });
  }
  const record = read.record;
  if (record.truth !== "COMPLETE" || record.coordinator !== null) {
    return recoveryCompletionRefusal({
      code: "UNKNOWN_TRUTH",
      reason: "The reconciliation record does not assert a complete external world.",
      refusedBy: RECOVERY_INVENTORY_LAYER,
      upstream: record.upstream ?? record.coordinator,
    });
  }
  // A COMPLETE record CAN carry quarantined items: deriveRecoveryReconciliationTruth
  // downgrades only for an UNKNOWN proof or an UNKNOWN disposition. This is the
  // only gate between a quarantined external object and a cleared quiesce.
  if (record.items.some(
    (item) => item.disposition === "QUARANTINED" || item.quarantineRef !== null,
  )) {
    return recoveryCompletionRefusal({
      code: "RECOVERY_RECONCILIATION_REQUIRED",
      reason: "External inventory items remain quarantined and unresolved.",
      refusedBy: RECOVERY_INVENTORY_LAYER,
    });
  }
  return crossCheck(store, projectId, record);
}
