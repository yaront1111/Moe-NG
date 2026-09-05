import type { SqliteEventStore } from "@moe/store";
import type { RepositoryExecutionHandle, RepositoryExecutionOwner } from "./repository-execution-contracts.js";
import type { RepositoryLandingCompletion, RepositoryLandingCompletionInput, RepositoryLandingIntent, RepositoryLandingIntentInput } from "./repository-landing-intent-contracts.js";
import type { RepositoryRecoveryResult } from "./repository-recovery-contracts.js";
import { recoveryRefusal } from "./repository-recovery-contracts.js";
import { readRecoveryFact, recoveryDigest, writeRecoveryFact } from "./repository-recovery-facts.js";
import { decodeVerifiedWorkspaceBinding } from "./verified-workspace-contracts.js";
import { validExecutionOwner } from "./repository-execution-record.js";

const INTENT = "moe-repository-landing-intent/1";
const COMPLETION = "moe-repository-landing-completion/1";
const INTENT_KIND = "internal.repository.landing_intent";
const COMPLETION_KIND = "internal.repository.landing_completion";
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const oid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value);
const ref = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/u.test(value);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const validPaths = (paths: unknown): paths is readonly string[] => Array.isArray(paths) && paths.length > 0 && paths.length <= 20_000
  && new Set(paths).size === paths.length && paths.every((path) => ref(path) && !/[\\:]/u.test(path) && !path.startsWith("/")
    && path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git"));
export const repositoryRecoveryOwnerDigest = (owner: RepositoryExecutionOwner): string =>
  recoveryDigest([owner.projectId, owner.nodeRef, owner.storeId, owner.ownershipToken]);
const intentId = (ownerDigest: string, baselineId: string, sessionId: string) => recoveryDigest([INTENT, ownerDigest, baselineId, sessionId]);
const aggregate = (ownerDigest: string) => `repository-landing:${ownerDigest}`;
const completionId = (id: string) => recoveryDigest([COMPLETION, id]);

export function decodeRepositoryLandingIntent(value: unknown): RepositoryLandingIntent | null {
  if (!record(value) || !exact(value, ["version", "intentId", "ownerDigest", "projectId", "nodeRef", "baselineId", "sessionId",
    "gitDirectory", "verifierReceiptId", "binding", "paths", "message"]) || value["version"] !== INTENT
    || !hex(value["intentId"]) || !hex(value["ownerDigest"]) || !hex(value["verifierReceiptId"])
    || !ref(value["projectId"]) || !ref(value["nodeRef"]) || !ref(value["baselineId"]) || !ref(value["sessionId"])
    || !ref(value["gitDirectory"]) || !validPaths(value["paths"]) || typeof value["message"] !== "string" || value["message"].length > 65_536) return null;
  const binding = decodeVerifiedWorkspaceBinding(value["binding"]);
  if (binding === null || value["intentId"] !== intentId(value["ownerDigest"], value["baselineId"], value["sessionId"])) return null;
  return Object.freeze({ version: INTENT, intentId: value["intentId"], ownerDigest: value["ownerDigest"], projectId: value["projectId"],
    nodeRef: value["nodeRef"], baselineId: value["baselineId"], sessionId: value["sessionId"], gitDirectory: value["gitDirectory"],
    verifierReceiptId: value["verifierReceiptId"], binding, paths: Object.freeze([...value["paths"]]), message: value["message"] });
}

function decodeCompletion(value: unknown, intent: RepositoryLandingIntent): RepositoryLandingCompletion | null {
  if (!record(value) || !exact(value, ["version", "intentId", "commit"]) || value["version"] !== COMPLETION
    || value["intentId"] !== intent.intentId || !record(value["commit"])) return null;
  const commit = value["commit"];
  if (!exact(commit, ["branch", "files", "message", "parentSha", "sha"]) || !oid(commit["sha"])
    || commit["sha"].length !== intent.binding.treeSha.length || commit["branch"] !== intent.binding.branchRef.slice(11)
    || commit["parentSha"] !== intent.binding.headSha || commit["message"] !== intent.message
    || JSON.stringify(commit["files"]) !== JSON.stringify(intent.paths)) return null;
  return Object.freeze({ version: COMPLETION, intentId: intent.intentId, commit: Object.freeze({
    branch: intent.binding.branchRef.slice(11), files: intent.paths, message: intent.message, parentSha: intent.binding.headSha, sha: commit["sha"],
  }) });
}

export function recordRepositoryLandingIntent(store: SqliteEventStore, input: RepositoryLandingIntentInput): RepositoryRecoveryResult<{ intent: RepositoryLandingIntent }> {
  const { owner, reservation } = input.handle;
  if (!validExecutionOwner(owner) || reservation.phase !== "LANDING" || reservation.baselineId === null || reservation.sessionId === null
    || reservation.projectId !== owner.projectId || reservation.nodeRef !== owner.nodeRef || reservation.storeId !== owner.storeId
    || input.binding.root !== reservation.identity.root) return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_INVALID");
  const ownerDigest = repositoryRecoveryOwnerDigest(owner);
  const intent = decodeRepositoryLandingIntent({ version: INTENT, intentId: intentId(ownerDigest, reservation.baselineId, reservation.sessionId),
    ownerDigest, projectId: owner.projectId, nodeRef: owner.nodeRef, baselineId: reservation.baselineId, sessionId: reservation.sessionId,
    gitDirectory: reservation.identity.gitDirectory, verifierReceiptId: input.verifierReceiptId, binding: input.binding,
    paths: [...input.paths].sort(), message: input.message });
  if (intent === null) return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_INVALID");
  const written = writeRecoveryFact(store, owner.projectId, intent.intentId, INTENT_KIND, aggregate(ownerDigest), intent);
  return written.ok ? { ok: true, intent } : written;
}

export function recordRepositoryLandingCompletion(store: SqliteEventStore, input: RepositoryLandingCompletionInput): RepositoryRecoveryResult<{ completion: RepositoryLandingCompletion }> {
  const intent = decodeRepositoryLandingIntent(input.intent);
  if (intent === null) return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_INVALID");
  const stored = readRecoveryFact(store, intent.projectId, intent.intentId, INTENT_KIND, aggregate(intent.ownerDigest));
  if (!stored.ok) return stored;
  if (JSON.stringify(stored.value) !== JSON.stringify(intent)) return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_INVALID");
  const completion = decodeCompletion({ version: COMPLETION, intentId: intent.intentId, commit: {
    branch: input.commit.branch, files: intent.paths, message: intent.message, parentSha: input.commit.parentSha, sha: input.commit.sha,
  } }, intent);
  if (completion === null) return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_INVALID");
  const written = writeRecoveryFact(store, intent.projectId, completionId(intent.intentId), COMPLETION_KIND, aggregate(intent.ownerDigest), completion);
  return written.ok ? { ok: true, completion } : written;
}

export function readRepositoryLandingEvidence(store: SqliteEventStore, handle: RepositoryExecutionHandle): RepositoryRecoveryResult<{
  intent: RepositoryLandingIntent; completion: RepositoryLandingCompletion | null;
}> {
  const { owner, reservation } = handle;
  if (!validExecutionOwner(owner) || reservation.baselineId === null || reservation.sessionId === null) return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_MISSING");
  const ownerDigest = repositoryRecoveryOwnerDigest(owner); const id = intentId(ownerDigest, reservation.baselineId, reservation.sessionId);
  const read = readRecoveryFact(store, owner.projectId, id, INTENT_KIND, aggregate(ownerDigest));
  if (!read.ok) return read;
  if (read.value === null) return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_MISSING");
  const intent = decodeRepositoryLandingIntent(read.value);
  if (intent === null || intent.intentId !== id || intent.projectId !== owner.projectId || intent.nodeRef !== owner.nodeRef
    || intent.ownerDigest !== ownerDigest || intent.binding.root !== reservation.identity.root || intent.gitDirectory !== reservation.identity.gitDirectory) {
    return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_INVALID");
  }
  const completed = readRecoveryFact(store, owner.projectId, completionId(id), COMPLETION_KIND, aggregate(ownerDigest));
  if (!completed.ok) return completed;
  const completion = completed.value === null ? null : decodeCompletion(completed.value, intent);
  if (completed.value !== null && completion === null) return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_INVALID");
  return { ok: true, intent, completion };
}
