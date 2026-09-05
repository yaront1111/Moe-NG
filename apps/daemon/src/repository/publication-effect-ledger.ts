import type { SqliteEventStore } from "@moe/store";
import { createHash } from "node:crypto";
import { decodeBoundedJsonBytes } from "@moe/contracts";
import { decodePublicationCandidate, samePublicationApproval } from "./publication-approval-contracts.js";
import type { PublicationEffectIntent } from "./publication-effect-contracts.js";
import type { RepositoryExecutionOwner } from "./repository-execution-contracts.js";
import { NODE_PUBLISHER_PRINCIPAL_ID, publishAggregateId } from "./publish-receipt-contracts.js";

const KIND = "internal.repository.publication_intent";
const VERSION = "moe-publication-intent/1";
const encoder = new TextEncoder();
const hash = (parts: readonly string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const intentId = (projectId: string, goalId: string, decisionId: string) => hash([VERSION, projectId, goalId, decisionId]);
export const publicationOwnerDigest = (owner: RepositoryExecutionOwner): string =>
  hash([owner.projectId, owner.nodeRef, owner.storeId, owner.ownershipToken]);
const sameIntent = (left: PublicationEffectIntent, right: PublicationEffectIntent): boolean =>
  left.version === right.version && left.projectId === right.projectId && left.goalId === right.goalId
  && left.decisionId === right.decisionId && left.ownerDigest === right.ownerDigest
  && left.controllerId === right.controllerId && left.reservationRevision === right.reservationRevision
  && left.intendedAt === right.intendedAt && samePublicationApproval(left.candidate.approval, right.candidate.approval)
  && left.candidate.identity.root === right.candidate.identity.root
  && left.candidate.identity.gitDirectory === right.candidate.identity.gitDirectory;

export function readPublicationIntent(store: SqliteEventStore, projectId: string, goalId: string, decisionId: string): PublicationEffectIntent | null {
  const record = store.getCommandDecision({ projectId, principalId: NODE_PUBLISHER_PRINCIPAL_ID, commandId: intentId(projectId, goalId, decisionId) });
  if (record === null) return null;
  const decoded = decodeBoundedJsonBytes(record.resultBytes);
  if (!decoded.ok || typeof decoded.value !== "object" || decoded.value === null || Array.isArray(decoded.value)) throw new Error("PUBLISH_INTENT_INVALID");
  const value = decoded.value as Record<string, unknown>;
  const keys = ["candidate", "controllerId", "decisionId", "goalId", "intendedAt", "ownerDigest", "projectId", "reservationRevision", "version"];
  const candidate = decodePublicationCandidate(value["candidate"]);
  if (Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))
    || record.commandKind !== KIND || record.effectDisposition !== "EFFECTS_COMMITTED"
    || record.targetAggregateId !== publishAggregateId(goalId) || value["version"] !== VERSION
    || value["projectId"] !== projectId || value["goalId"] !== goalId || value["decisionId"] !== decisionId
    || candidate === null || typeof value["ownerDigest"] !== "string" || !/^[a-f0-9]{64}$/u.test(value["ownerDigest"])
    || typeof value["controllerId"] !== "string" || value["controllerId"] === ""
    || typeof value["reservationRevision"] !== "number" || !Number.isSafeInteger(value["reservationRevision"]) || value["reservationRevision"] < 1
    || typeof value["intendedAt"] !== "string" || value["intendedAt"] !== record.decidedAt) throw new Error("PUBLISH_INTENT_INVALID");
  return Object.freeze({ version: VERSION, projectId, goalId, decisionId, candidate, ownerDigest: value["ownerDigest"],
    reservationRevision: value["reservationRevision"], controllerId: value["controllerId"], intendedAt: value["intendedAt"] });
}

export function recordPublicationIntent(store: SqliteEventStore, input: PublicationEffectIntent): Readonly<{ intent: PublicationEffectIntent; replayed: boolean }> {
  const prior = readPublicationIntent(store, input.projectId, input.goalId, input.decisionId);
  if (prior !== null) {
    if (!sameIntent(prior, input)) throw new Error("PUBLISH_INTENT_CONFLICT");
    return { intent: prior, replayed: true };
  }
  const commandId = intentId(input.projectId, input.goalId, input.decisionId);
  const bytes = encoder.encode(JSON.stringify(input));
  const aggregateId = publishAggregateId(input.goalId);
  const written = store.commitExpectedVersionDecision({ commandKind: KIND, committedResultBytes: bytes,
    correlationId: "publication-intent", decidedAt: input.intendedAt,
    events: [{ eventId: `${commandId}-intended`, eventType: "RepositoryPublicationIntended", payload: encoder.encode(JSON.stringify({ decisionId: input.decisionId })) }],
    expectedVersion: store.getAggregateVersion(aggregateId),
    key: { commandId, principalId: NODE_PUBLISHER_PRINCIPAL_ID, projectId: input.projectId },
    requestBytes: bytes, targetAggregateId: aggregateId });
  if (written.decision.effectDisposition !== "EFFECTS_COMMITTED") throw new Error("PUBLISH_INTENT_CONFLICT");
  const intent = readPublicationIntent(store, input.projectId, input.goalId, input.decisionId);
  if (intent === null) throw new Error("PUBLISH_INTENT_INVALID");
  if (!sameIntent(intent, input)) throw new Error("PUBLISH_INTENT_CONFLICT");
  return { intent, replayed: written.disposition === "REPLAYED" };
}
