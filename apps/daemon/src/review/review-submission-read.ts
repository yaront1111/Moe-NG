import { createHash } from "node:crypto";
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { decisionsOf } from "../decision-ledger-memo.js";
import { decodeVerifiedWorkspaceBinding, sameVerifiedWorkspace } from "../repository/verified-workspace-contracts.js";
import type { VerifiedWorkspaceBinding } from "../repository/verified-workspace-contracts.js";
import type { ReviewRoundRecord } from "./review-read-model.js";
import { verifyStoredPackageItems } from "./review-package-restore.js";
import { readReviewArtifactText } from "./review-submission-artifact.js";

export type SubmittedReviewWorkspace = { readonly status: "ABSENT" | "INVALID" }
  | { readonly status: "PRESENT"; readonly binding: VerifiedWorkspaceBinding };
const record = (value: JsonValue | undefined): JsonObject | null =>
  value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
const digest = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const invalid = (): SubmittedReviewWorkspace => Object.freeze({ status: "INVALID" });

/**
 * New submission evidence is optional only for legacy rounds. Presence with any broken digest,
 * binding, item or scope remains INVALID; it can never fall back to the legacy path.
 */
export function readSubmittedReviewWorkspace(
  store: SqliteEventStore, projectId: string, subjectRef: string, round: ReviewRoundRecord,
): SubmittedReviewWorkspace {
  try {
    const decision = decisionsOf(store, 200).find((entry) => entry.decisionId === round.decisionId
      && entry.key.projectId === projectId && entry.targetAggregateId === subjectRef);
    if (decision === undefined || decision.commandKind !== "review.submit"
      || decision.effectDisposition !== "EFFECTS_COMMITTED" || decision.resultSha256 !== round.resultSha256) return invalid();
    // The store reader already re-proved result bytes with identifyDecisionResult, which uses
    // versioned framing. A raw SHA-256 here would compare a different identity and reject all rows.
    const decoded = decodeBoundedJsonBytes(decision.resultBytes);
    const result = decoded.ok ? record(decoded.value) : null;
    if (result === null) return invalid();
    if (!Object.hasOwn(result, "submissionEvidence")) return Object.freeze({ status: "ABSENT" });
    const evidence = record(result["submissionEvidence"]);
    const artifacts = evidence?.["artifacts"];
    if (evidence?.["version"] !== "moe-review-submission-evidence/1" || !Array.isArray(artifacts)) return invalid();
    const restored = verifyStoredPackageItems(round);
    if (!restored.ok) return invalid();
    const byIdentity = new Map<string, string>();
    for (const value of artifacts) {
      const artifact = record(value);
      if (artifact === null) return invalid();
      const text = readReviewArtifactText(artifact);
      if (text === null || typeof artifact["digest"] !== "string"
        || typeof artifact["locator"] !== "string" || digest(text) !== artifact["digest"]) return invalid();
      const key = JSON.stringify([artifact["locator"], artifact["digest"]]);
      if (byIdentity.has(key)) return invalid();
      byIdentity.set(key, text);
    }
    // Graph and plan hashes are owned by their existing durable codecs. Every other item must
    // resolve to exactly one of this round's immutable artifacts, including the rendered input.
    const bound = restored.items.filter((item) => item.kind !== "GRAPH_HASH" && item.kind !== "PLAN_HASH");
    if (bound.length !== byIdentity.size || bound.some((item) =>
      !byIdentity.has(JSON.stringify([item.locator, item.digest])))) return invalid();
    const artifactOf = (kind: string): JsonObject | null => {
      const items = restored.items.filter((item) => item.kind === kind);
      if (items.length !== 1) return null;
      const item = items[0];
      if (item === undefined) return null;
      const text = byIdentity.get(JSON.stringify([item.locator, item.digest]));
      if (text === undefined) return null;
      const parsed = decodeBoundedJsonBytes(new TextEncoder().encode(text));
      return parsed.ok ? record(parsed.value) : null;
    };
    const receipt = artifactOf("DAEMON_RECEIPT");
    const tree = artifactOf("INTEGRATED_TREE");
    const submitted = artifactOf("SUBMITTED_BYTES");
    const binding = decodeVerifiedWorkspaceBinding(receipt?.["binding"]);
    const treeBinding = decodeVerifiedWorkspaceBinding(tree?.["binding"]);
    const submittedBinding = decodeVerifiedWorkspaceBinding(submitted?.["binding"]);
    if (receipt?.["version"] !== "moe-review-submission-observation/1"
      || receipt["projectId"] !== projectId || receipt["subjectRef"] !== subjectRef
      || receipt["proof"] !== "UNKNOWN" || receipt["testsRun"] !== false
      || receipt["operation"] !== "CAPTURE_WORKSPACE" || receipt["truthClass"] !== "OBSERVED"
      || tree?.["version"] !== "moe-review-workspace/1"
      || submitted?.["version"] !== "moe-runtime-review-input/1"
      || submitted["projectId"] !== projectId || submitted["subjectRef"] !== subjectRef
      || binding === null || treeBinding === null || submittedBinding === null
      || !sameVerifiedWorkspace(binding, treeBinding) || !sameVerifiedWorkspace(binding, submittedBinding)) return invalid();
    return Object.freeze({ status: "PRESENT", binding });
  } catch { return invalid(); }
}
