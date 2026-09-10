import { POLICY_AUTO_APPROVAL_TIERS, POLICY_REASON_CODES, POLICY_RISK_TIERS } from "@moe/core";
import type { PolicyReasonCode, PolicyRiskTier } from "@moe/core";
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";
import type { CommandDecisionRecord, EventDraft, SqliteEventStore } from "@moe/store";

import type { ReleaseAutoOptIn } from "./release-auto-approval.js";

/**
 * THE DURABLE RECORD OF ONE AUTOMATIC RELEASE APPROVAL: which opt-in the daemon acted under, at
 * which tier, against which slice, for which (goal, sha).
 *
 * IT IS NOT A RUNTIME COMMAND KIND. `internal.release.auto_approval` is minted only here, under a
 * reserved principal, exactly as `internal.release.receipt` is (release-receipt-contracts.ts:24-26)
 * -- so it is absent from `RUNTIME_COMMAND_KINDS`, no payload roster names it, and no
 * GENERATED_CONTRACT_DIGEST mirror rotates because of it. An arm pins that absence.
 *
 * IT LIVES ON ITS OWN AGGREGATE, `release-auto:<goalId>`, NEVER on `release:<goalId>`. The
 * reconciler evaluates every candidate once a minute; writing to the release aggregate would bump
 * the version a human's Decide card was minted against, and that card would 409 once a minute for
 * as long as the goal stayed stuck. Separating the aggregates is what keeps an automatic
 * evaluation invisible to a human who is mid-decision.
 *
 * THE DECODER REFUSES WHAT THIS MODULE DID NOT WRITE. Exact keys, a tier drawn from the frozen
 * core roster, and reason codes drawn from the frozen core list: a record whose tier or reason
 * vocabulary drifted is REFUSED rather than read around, because the one thing a provenance
 * record must never do is name an opt-in that was never declared.
 */

export const RELEASE_AUTO_APPROVAL_COMMAND_KIND = "internal.release.auto_approval" as const;
export const RELEASE_AUTO_APPROVAL_PRINCIPAL_ID = "daemon:release-auto-approval" as const;
export const RELEASE_AUTO_APPROVAL_VERSION = "moe-release-auto-approval/1" as const;

/** Its OWN aggregate. See the module header for why it is never `release:<goalId>`. */
export function releaseAutoAggregateId(goalId: string): string {
  return `release-auto:${goalId}`;
}

export interface ReleaseAutoApprovalRecord {
  readonly commandId: string;
  readonly goalId: string;
  readonly optIn: ReleaseAutoOptIn;
  readonly reasonCodes: readonly PolicyReasonCode[];
  readonly sha: string;
  readonly sliceRef: string;
  readonly subjectTier: PolicyRiskTier;
  readonly version: typeof RELEASE_AUTO_APPROVAL_VERSION;
}

export interface RecordReleaseAutoApprovalInput {
  readonly commandId: string;
  readonly decidedAt: string;
  readonly goalId: string;
  readonly optIn: ReleaseAutoOptIn;
  readonly projectId: string;
  readonly reasonCodes: readonly PolicyReasonCode[];
  readonly sha: string;
  readonly sliceRef: string;
  readonly subjectTier: PolicyRiskTier;
}

export type ReleaseAutoApprovalRecordResult =
  | Readonly<{ readonly ok: true; readonly record: ReleaseAutoApprovalRecord }>
  | Readonly<{
    readonly code: "RELEASE_AUTO_APPROVAL_INVALID" | "EXPECTED_VERSION_CONFLICT";
    readonly ok: false;
  }>;

const RECORD_KEYS = [
  "commandId", "goalId", "optIn", "reasonCodes", "sha", "sliceRef", "subjectTier", "version",
] as const;
const OPT_IN_KEYS = ["action", "tier"] as const;
const encoder = new TextEncoder();

function exactObject(value: JsonValue | undefined, keys: readonly string[]): JsonObject | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
    ? value as JsonObject
    : null;
}

function ref(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function persistedOptIn(value: JsonValue | undefined): ReleaseAutoOptIn | null {
  const item = exactObject(value, OPT_IN_KEYS);
  if (item === null || !ref(item["action"])) return null;
  // The AUTO ceiling, not the full tier roster: see `ReleaseAutoOptIn` for why an R2 opt-in is
  // not an auto-approval declaration and must not survive a round trip as one.
  const tier = POLICY_AUTO_APPROVAL_TIERS.find((one) => one === item["tier"]);
  return tier === undefined ? null : Object.freeze({ action: item["action"], tier });
}

function persistedReasonCodes(value: JsonValue | undefined): readonly PolicyReasonCode[] | null {
  if (!Array.isArray(value)) return null;
  const codes: PolicyReasonCode[] = [];
  for (const entry of value) {
    const code = POLICY_REASON_CODES.find((one) => one === entry);
    if (code === undefined) return null;
    codes.push(code);
  }
  return Object.freeze(codes);
}

/** Decode the stored bytes, or REFUSE. Nothing is read around; nothing is defaulted. */
export function decodeReleaseAutoApprovalBytes(
  input: unknown,
): ReleaseAutoApprovalRecord | null {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok) return null;
  const value = exactObject(decoded.value, RECORD_KEYS);
  if (value === null || value["version"] !== RELEASE_AUTO_APPROVAL_VERSION) return null;
  const optIn = persistedOptIn(value["optIn"]);
  const reasonCodes = persistedReasonCodes(value["reasonCodes"]);
  const subjectTier = POLICY_RISK_TIERS.find((one) => one === value["subjectTier"]);
  if (optIn === null || reasonCodes === null || subjectTier === undefined
    || !ref(value["commandId"]) || !ref(value["goalId"]) || !ref(value["sha"])
    || !ref(value["sliceRef"])) {
    return null;
  }
  return Object.freeze({
    commandId: value["commandId"],
    goalId: value["goalId"],
    optIn,
    reasonCodes,
    sha: value["sha"],
    sliceRef: value["sliceRef"],
    subjectTier,
    version: RELEASE_AUTO_APPROVAL_VERSION,
  });
}

function ownDecision(
  store: SqliteEventStore, projectId: string, commandId: string,
): CommandDecisionRecord | null {
  let decision: CommandDecisionRecord | null;
  try {
    decision = store.getCommandDecision({
      commandId, principalId: RELEASE_AUTO_APPROVAL_PRINCIPAL_ID, projectId,
    });
  } catch {
    return null;
  }
  if (decision === null) return null;
  return decision.effectDisposition === "EFFECTS_COMMITTED"
    && decision.commandKind === RELEASE_AUTO_APPROVAL_COMMAND_KIND
    ? decision
    : null;
}

/**
 * The automatic approval recorded under this commandId, or null.
 *
 * The join is re-checked on the READ: a record whose stored `commandId` disagrees with the key it
 * was found under, or whose target aggregate is not this goal's, is null rather than trusted.
 */
export function readReleaseAutoApproval(
  store: SqliteEventStore, projectId: string, commandId: string,
): ReleaseAutoApprovalRecord | null {
  const decision = ownDecision(store, projectId, commandId);
  if (decision === null) return null;
  const record = decodeReleaseAutoApprovalBytes(decision.resultBytes);
  if (record === null || record.commandId !== commandId
    || decision.targetAggregateId !== releaseAutoAggregateId(record.goalId)) {
    return null;
  }
  return record;
}

/**
 * Record one automatic approval, keyed by the reconciler's deterministic commandId so a retry
 * replays rather than appending a second claim about the same (goal, sha).
 */
export function recordReleaseAutoApproval(
  store: SqliteEventStore, input: RecordReleaseAutoApprovalInput,
): ReleaseAutoApprovalRecordResult {
  const historical = readReleaseAutoApproval(store, input.projectId, input.commandId);
  if (historical !== null) return { ok: true, record: historical };
  const record: ReleaseAutoApprovalRecord = {
    commandId: input.commandId,
    goalId: input.goalId,
    optIn: input.optIn,
    reasonCodes: input.reasonCodes,
    sha: input.sha,
    sliceRef: input.sliceRef,
    subjectTier: input.subjectTier,
    version: RELEASE_AUTO_APPROVAL_VERSION,
  };
  const resultBytes = encoder.encode(JSON.stringify(record));
  // Written bytes are decoded back BEFORE they are committed: a record this module could not read
  // is a record no reviewer could read either, and provenance that cannot be read is not evidence.
  if (decodeReleaseAutoApprovalBytes(resultBytes) === null) {
    return { code: "RELEASE_AUTO_APPROVAL_INVALID", ok: false };
  }
  const aggregateId = releaseAutoAggregateId(input.goalId);
  const event: EventDraft = {
    eventId: `${input.commandId}-ReleaseAutoApprovalRecorded`,
    eventType: "ReleaseAutoApprovalRecorded",
    payload: encoder.encode(JSON.stringify({
      action: input.optIn.action, goalId: input.goalId, sha: input.sha, tier: input.optIn.tier,
    })),
  };
  const response = store.commitExpectedVersionDecision({
    commandKind: RELEASE_AUTO_APPROVAL_COMMAND_KIND,
    committedResultBytes: resultBytes,
    correlationId: "release-auto-approval",
    decidedAt: input.decidedAt,
    events: [event],
    expectedVersion: store.getAggregateVersion(aggregateId),
    key: {
      commandId: input.commandId,
      principalId: RELEASE_AUTO_APPROVAL_PRINCIPAL_ID,
      projectId: input.projectId,
    },
    requestBytes: encoder.encode(JSON.stringify({
      commandId: input.commandId, goalId: input.goalId, sha: input.sha,
      version: RELEASE_AUTO_APPROVAL_VERSION,
    })),
    targetAggregateId: aggregateId,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return { code: "EXPECTED_VERSION_CONFLICT", ok: false };
  }
  const persisted = readReleaseAutoApproval(store, input.projectId, input.commandId);
  return persisted === null
    ? { code: "RELEASE_AUTO_APPROVAL_INVALID", ok: false }
    : { ok: true, record: persisted };
}
