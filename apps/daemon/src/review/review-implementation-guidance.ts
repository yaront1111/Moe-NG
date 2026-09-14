import { createHash } from "node:crypto";
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { decisionsOf } from "../decision-ledger-memo.js";
import { reviewContinuationAvailable } from "./review-continuation.js";
import { verifyStoredPackageItems } from "./review-package-restore.js";
import { readReviewLedger } from "./review-read-model.js";
import type { ReviewLedger, ReviewRoundRecord } from "./review-read-model.js";
import { readReviewSubmissionSource } from "./review-submission-source.js";
import { canonicalReviewArtifact } from "./review-submission-artifact.js";

export const REVIEW_ESCALATION_GUIDANCE_SCHEMA_VERSION = "moe-review-escalation-guidance/1" as const;
const GUIDANCE_VERSION = "moe-review-implementation-guidance/1";
const record = (value: unknown): JsonObject | null => value !== null && typeof value === "object"
  && !Array.isArray(value) ? value as JsonObject : null;

/** Preserve the human's exact text; never normalize malformed input into a different answer. */
export function validImplementationGuidance(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4_000 && value.trim().length > 0
    && value.isWellFormed() && Buffer.byteLength(value, "utf8") <= 16_000;
}

/** Complete approved source, joined to the exact package the exhausted review assessed. */
export function readReviewGuidanceSource(
  store: SqliteEventStore, projectId: string, subjectRef: string, latest: ReviewRoundRecord | undefined,
): JsonObject | null {
  try {
    if (latest === undefined) return null;
    const source = readReviewSubmissionSource(store, projectId, subjectRef);
    const restored = verifyStoredPackageItems(latest);
    if (source === null || !restored.ok) return null;
    const criteria = source.criteria.map((criterion) => Object.freeze({ criterionId: criterion.criterionId,
      digest: createHash("sha256").update(canonicalReviewArtifact(criterion as unknown as JsonValue), "utf8").digest("hex") }));
    const matches = (kind: string, locator: string, digest: string) => {
      const items = restored.items.filter((item) => item.kind === kind);
      return items.length === 1 && items[0]?.locator === locator && items[0].digest === digest;
    };
    const bound = restored.items.filter((item) => item.kind === "CRITERION");
    if (!matches("GRAPH_HASH", source.graphRevisionRef, source.graphContentHash)
      || !matches("PLAN_HASH", source.authorityRef, source.planHash)
      || bound.length !== criteria.length || new Set(criteria.map((item) => item.criterionId)).size !== criteria.length
      || criteria.some((criterion) => bound.filter((item) => item.locator === criterion.criterionId
        && item.digest === criterion.digest).length !== 1)) return null;
    return Object.freeze({ projectId, subjectRef, authorityRef: source.authorityRef,
      goalRef: source.goalRef, graphContentHash: source.graphContentHash, graphRevisionRef: source.graphRevisionRef,
      nodeKey: source.nodeKey, planHash: source.planHash, runId: source.runId, criteria: Object.freeze(criteria) });
  } catch { return null; }
}

export type ReviewImplementationGuidance = Readonly<{ status: "ABSENT" | "INVALID" }>
  | Readonly<{ status: "PRESENT"; text: string; decisionId: string; decisionVersion: number }>;

export function implementationGuidanceResult(text: string, source: JsonObject): JsonObject {
  return Object.freeze({ version: GUIDANCE_VERSION, text, source });
}

/** Only the exact still-unconsumed approval can carry instructions into the next attempt. */
export function readReviewImplementationGuidance(
  store: SqliteEventStore, projectId: string, subjectRef: string,
  ledger: ReviewLedger = readReviewLedger(store, projectId, subjectRef),
): ReviewImplementationGuidance {
  const invalid = (): ReviewImplementationGuidance => Object.freeze({ status: "INVALID" });
  try {
    if (ledger.unreadable) return invalid();
    if (!reviewContinuationAvailable(ledger)) return Object.freeze({ status: "ABSENT" });
    const approval = ledger.continuation!;
    const decision = decisionsOf(store, 200).find((entry) => entry.decisionId === approval.decisionId);
    if (decision === undefined || decision.commandKind !== "escalation.decide"
      || decision.effectDisposition !== "EFFECTS_COMMITTED" || decision.key.projectId !== projectId
      || decision.targetAggregateId !== subjectRef || decision.currentVersion !== approval.decisionVersion
      || decision.resultSha256 !== approval.decisionResultSha256) return invalid();
    const decoded = decodeBoundedJsonBytes(decision.resultBytes);
    const result = decoded.ok ? record(decoded.value) : null;
    if (result === null || result["decision"] !== "ALLOW_MORE_ATTEMPTS") return invalid();
    if (!Object.hasOwn(result, "implementationGuidance")) return Object.freeze({ status: "ABSENT" });
    const guidance = record(result["implementationGuidance"]);
    if (guidance === null || !validImplementationGuidance(guidance["text"])) return invalid();
    const latest = ledger.rounds.at(-1);
    if (latest?.decisionId !== approval.sourceDecisionId || latest.resultSha256 !== approval.sourceResultSha256) return invalid();
    const source = readReviewGuidanceSource(store, projectId, subjectRef, latest);
    if (source === null || canonicalReviewArtifact(guidance)
      !== canonicalReviewArtifact(implementationGuidanceResult(guidance["text"], source))) return invalid();
    return Object.freeze({ status: "PRESENT", text: guidance["text"], decisionId: approval.decisionId,
      decisionVersion: approval.decisionVersion });
  } catch { return invalid(); }
}
