import type { CommandDecisionRecord, EventDraft, SqliteEventStore } from "@moe/store";

import {
  RELEASE_DOSSIER_COMMAND_KIND, RELEASE_DOSSIER_PRINCIPAL_ID, RELEASE_DOSSIER_VERSION,
  decodeReleaseDossierBytes, releaseDossierAggregateId, releaseDossierId,
} from "./release-dossier-contracts.js";
import type { ReleaseDossierV1 } from "./release-dossier-contracts.js";

/**
 * Durable reads and writes for the release dossier, on the goal's release aggregate
 * (`release:<goalId>`) rather than on the goal itself, so recording evidence never
 * moves a version a reader of the goal never saw. Mirrors repository/landing-ledger.ts:
 * every write goes through `commitExpectedVersionDecision` under a reserved principal,
 * and every read re-validates the decision against the bytes it carries.
 *
 * The MARKDOWN ITSELF is stored, not the facts it was rendered from. The PR body is
 * then the STORED bytes rather than a second rendering — a second rendering is how a
 * PR and the durable record come to disagree, and it is what makes two releases
 * diffable against each other rather than against a moving generator.
 */

const encoder = new TextEncoder();

export type ReleaseDossierReadResult =
  | Readonly<{
    readonly decision: CommandDecisionRecord;
    readonly dossier: ReleaseDossierV1;
    readonly ok: true;
  }>
  | Readonly<{
    readonly code: "RELEASE_DOSSIER_NOT_FOUND" | "RELEASE_DOSSIER_INVALID";
    readonly ok: false;
  }>;

export type ReleaseDossierRecordResult =
  | Readonly<{ readonly dossier: ReleaseDossierV1; readonly ok: true; readonly replayed: boolean }>
  | Readonly<{
    readonly code: "EXPECTED_VERSION_CONFLICT" | "RELEASE_DOSSIER_INVALID";
    readonly ok: false;
  }>;

export interface RecordReleaseDossierInput {
  readonly decidedAt: string;
  readonly goalId: string;
  readonly markdown: string;
  readonly projectId: string;
  readonly sha: string;
}

function ownDecision(
  store: SqliteEventStore, projectId: string, commandId: string,
): CommandDecisionRecord | null | "INVALID" {
  let decision: CommandDecisionRecord | null;
  try {
    decision = store.getCommandDecision({
      commandId, principalId: RELEASE_DOSSIER_PRINCIPAL_ID, projectId,
    });
  } catch {
    return "INVALID";
  }
  if (decision === null) return null;
  if (decision.effectDisposition !== "EFFECTS_COMMITTED"
    || decision.commandKind !== RELEASE_DOSSIER_COMMAND_KIND
    || decision.key.commandId !== commandId
    || decision.key.principalId !== RELEASE_DOSSIER_PRINCIPAL_ID
    || decision.key.projectId !== projectId) return "INVALID";
  return decision;
}

export function readReleaseDossier(
  store: SqliteEventStore, projectId: string, dossierId: string,
): ReleaseDossierReadResult {
  const decision = ownDecision(store, projectId, dossierId);
  if (decision === null) return { code: "RELEASE_DOSSIER_NOT_FOUND", ok: false };
  if (decision === "INVALID") return { code: "RELEASE_DOSSIER_INVALID", ok: false };
  const decoded = decodeReleaseDossierBytes(decision.resultBytes);
  if (!decoded.ok || decoded.dossier.projectId !== projectId
    || decoded.dossier.dossierId !== dossierId
    || decision.targetAggregateId !== releaseDossierAggregateId(decoded.dossier.goalId)) {
    return { code: "RELEASE_DOSSIER_INVALID", ok: false };
  }
  return { decision, dossier: decoded.dossier, ok: true };
}

/**
 * Record the dossier for one (project, goal, sha). The id is a pure function of that
 * triple, so a repeated release of the same sha REPLAYS the stored record instead of
 * appending a second one — two dossiers for one release could disagree, and a reader
 * would have no way to tell which was the released evidence.
 */
export function recordReleaseDossier(
  store: SqliteEventStore, input: RecordReleaseDossierInput,
): ReleaseDossierRecordResult {
  const dossierId = releaseDossierId(input.projectId, input.goalId, input.sha);
  const historical = readReleaseDossier(store, input.projectId, dossierId);
  if (historical.ok) return { dossier: historical.dossier, ok: true, replayed: true };
  if (historical.code === "RELEASE_DOSSIER_INVALID") return { code: historical.code, ok: false };
  const dossier: ReleaseDossierV1 = {
    dossierId,
    goalId: input.goalId,
    markdown: input.markdown,
    projectId: input.projectId,
    sha: input.sha,
    version: RELEASE_DOSSIER_VERSION,
  };
  const resultBytes = encoder.encode(JSON.stringify(dossier));
  if (!decodeReleaseDossierBytes(resultBytes).ok) {
    return { code: "RELEASE_DOSSIER_INVALID", ok: false };
  }
  const aggregateId = releaseDossierAggregateId(input.goalId);
  const event: EventDraft = {
    eventId: `${dossierId}-ReleaseDossierRecorded`,
    eventType: "ReleaseDossierRecorded",
    payload: encoder.encode(JSON.stringify({
      byteLength: resultBytes.byteLength, dossierId, goalId: input.goalId, sha: input.sha,
    })),
  };
  const response = store.commitExpectedVersionDecision({
    commandKind: RELEASE_DOSSIER_COMMAND_KIND,
    committedResultBytes: resultBytes,
    correlationId: "release-dossier",
    decidedAt: input.decidedAt,
    events: [event],
    expectedVersion: store.getAggregateVersion(aggregateId),
    key: {
      commandId: dossierId, principalId: RELEASE_DOSSIER_PRINCIPAL_ID, projectId: input.projectId,
    },
    requestBytes: encoder.encode(JSON.stringify({
      dossierId, goalId: input.goalId, sha: input.sha, version: RELEASE_DOSSIER_VERSION,
    })),
    targetAggregateId: aggregateId,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return { code: "EXPECTED_VERSION_CONFLICT", ok: false };
  }
  const persisted = readReleaseDossier(store, input.projectId, dossierId);
  if (!persisted.ok) return { code: "RELEASE_DOSSIER_INVALID", ok: false };
  return { dossier: persisted.dossier, ok: true, replayed: false };
}
