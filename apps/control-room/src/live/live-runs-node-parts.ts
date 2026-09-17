/**
 * The node-level parts of the runs read client, split out of live-runs.ts when the review facts
 * of 2026-09-15 (stalled rounds, finding owners) took that file past the 400-line rail.
 * Exact-key snapshots, verbatim; nothing here reads the network.
 */
import type { RunNodeClaimView, RunNodeFindingView, RunNodeLandingView, RunNodeReceiptView, RunNodeReviewView } from "./live-runs.js";
import { exactDataRecord, listOf } from "./live-wire-primitives.js";

export const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
export const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
export const count = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
export const stringList = (value: unknown): readonly string[] | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string") ? Object.freeze([...(value as string[])]) : null;

export function claimOf(value: unknown): RunNodeClaimView | null {
  const record = exactDataRecord(value, ["active", "claimedBy", "expiresAt", "status"]);
  if (record === null || typeof record.active !== "boolean" || !nonEmptyString(record.claimedBy)
    || !nonEmptyString(record.expiresAt) || (record.status !== "OPEN" && record.status !== "RELEASED")) return null;
  return Object.freeze({ active: record.active, claimedBy: record.claimedBy, expiresAt: record.expiresAt, status: record.status });
}

const FINDING_KEYS = ["detail", "round", "ruleId", "severity", "subject"] as const;

/** `undefined` is a malformed attribution: the frame is refused rather than shown without its owner. */
function attributionOf(value: unknown): RunNodeFindingView["attributedTo"] | undefined {
  if (value === null) return null;
  const record = exactDataRecord(value, ["criterionIds", "nodeKey"]);
  const criterionIds = record === null ? null : stringList(record.criterionIds);
  if (record === null || !nonEmptyString(record.nodeKey) || criterionIds === null || criterionIds.length === 0) return undefined;
  return Object.freeze({ criterionIds, nodeKey: record.nodeKey });
}

function findingOf(value: unknown): RunNodeFindingView | null {
  // Daemons from 2026-09-15 add `attributedTo`; an older daemon's exact shape still reads.
  const attributed = exactDataRecord(value, [...FINDING_KEYS, "attributedTo"]);
  const record = attributed ?? exactDataRecord(value, FINDING_KEYS);
  if (record === null || typeof record.detail !== "string" || !count(record.round) || !nonEmptyString(record.ruleId)
    || !nonEmptyString(record.severity) || typeof record.subject !== "string") return null;
  const attributedTo = attributed === null ? undefined : attributionOf(attributed.attributedTo);
  if (attributed !== null && attributedTo === undefined) return null;
  return Object.freeze({ ...(attributedTo === undefined ? {} : { attributedTo }),
    detail: record.detail, round: record.round, ruleId: record.ruleId, severity: record.severity, subject: record.subject });
}

export function receiptOf(value: unknown): RunNodeReceiptView | null {
  const record = exactDataRecord(value, ["byteCount", "exitCode", "outputSha256", "test", "workspace", "testedTreeSha"]);
  if (record === null || !count(record.byteCount) || !count(record.exitCode) || !nonEmptyString(record.outputSha256)
    || typeof record.test !== "string" || typeof record.workspace !== "string"
    || (record.testedTreeSha !== null && (typeof record.testedTreeSha !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(record.testedTreeSha)))) return null;
  return Object.freeze({ byteCount: record.byteCount, exitCode: record.exitCode, outputSha256: record.outputSha256,
    test: record.test, workspace: record.workspace, testedTreeSha: record.testedTreeSha });
}

export function landingOf(value: unknown): RunNodeLandingView | null {
  const record = exactDataRecord(value, ["branch", "code", "files", "outcome", "sha"]);
  if (record === null || !nullableString(record.branch) || !nullableString(record.code)
    || !nullableString(record.sha) || (record.outcome !== "COMMITTED" && record.outcome !== "REFUSED")) return null;
  const files = stringList(record.files);
  if (files === null) return null;
  return Object.freeze({ branch: record.branch, code: record.code, files, outcome: record.outcome, sha: record.sha });
}

const REVIEW_KEYS = ["escalated", "findings", "latestRoute", "rounds", "unreadable", "unsuccessfulRounds", "version"] as const;

function countList(value: unknown): readonly number[] | undefined {
  return Array.isArray(value) && value.every((entry) => count(entry)) ? Object.freeze([...value as number[]]) : undefined;
}

export function reviewOf(value: unknown): RunNodeReviewView | null {
  // Daemons from 2026-09-15 add `stalledRounds`; an older daemon's exact shape still reads.
  const staller = exactDataRecord(value, [...REVIEW_KEYS, "stalledRounds"]);
  const record = staller ?? exactDataRecord(value, REVIEW_KEYS);
  if (record === null || typeof record.escalated !== "boolean" || !nullableString(record.latestRoute)
    || !count(record.rounds) || typeof record.unreadable !== "boolean" || !count(record.unsuccessfulRounds)
    || !count(record.version)) return null;
  const findings = listOf(record.findings, findingOf);
  const stalledRounds = staller === null ? undefined : countList(staller.stalledRounds);
  if (findings === null || (staller !== null && stalledRounds === undefined)) return null;
  return Object.freeze({
    escalated: record.escalated, findings, latestRoute: record.latestRoute, rounds: record.rounds,
    ...(stalledRounds === undefined ? {} : { stalledRounds }),
    unreadable: record.unreadable, unsuccessfulRounds: record.unsuccessfulRounds, version: record.version,
  });
}
