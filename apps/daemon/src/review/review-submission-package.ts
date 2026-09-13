import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "@moe/contracts";
import type { ReviewPackageItemInput } from "@moe/review";
import type { VerifiedWorkspaceBinding } from "../repository/verified-workspace-contracts.js";
import type { ReviewSubmissionSource } from "./review-submission-source.js";
import { reviewArtifactTextFields } from "./review-submission-artifact.js";

export interface PreparedReviewSubmission {
  readonly evidence: JsonObject;
  readonly items: readonly ReviewPackageItemInput[];
}

/** Canonical renderer for this version's JSON-only host facts; never a graph/plan hash codec. */
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as JsonObject)[key] as JsonValue)}`).join(",")}}`;
  return JSON.stringify(value);
}

/**
 * All new artifacts are exact immutable UTF-8 text, persisted in the same result as the round.
 * This daemon receipt records a CAPTURE, with UNKNOWN proof. It cannot assert test success,
 * reviewer independence, criterion satisfaction, or integration acceptance.
 */
export function prepareReviewSubmissionPackage(input: {
  readonly source: ReviewSubmissionSource; readonly binding: VerifiedWorkspaceBinding;
  readonly projectId: string; readonly subjectRef: string;
}): PreparedReviewSubmission {
  const artifacts: JsonObject[] = [];
  const artifact = (kind: string, value: unknown, locator?: string): ReviewPackageItemInput => {
    const text = canonical(value as JsonValue);
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    const address = locator ?? `review-submission:sha256:${digest}`;
    artifacts.push(Object.freeze({ digest, locator: address, ...reviewArtifactTextFields(text) }));
    return Object.freeze({ digest, kind, locator: address });
  };
  const { source, binding, projectId, subjectRef } = input;
  const criteria = source.criteria.map((criterion) => artifact("CRITERION", criterion, criterion.criterionId));
  const hashes = [
    { digest: source.graphContentHash, kind: "GRAPH_HASH", locator: source.graphRevisionRef },
    { digest: source.planHash, kind: "PLAN_HASH", locator: source.authorityRef },
  ];
  const tree = artifact("INTEGRATED_TREE", { version: "moe-review-workspace/1", binding });
  const receipt = artifact("DAEMON_RECEIPT", { version: "moe-review-submission-observation/1",
    operation: "CAPTURE_WORKSPACE", projectId, subjectRef, source, binding,
    proof: "UNKNOWN", truthClass: "OBSERVED", testsRun: false });
  const rubric = artifact("RUBRIC", { version: "moe-runtime-review-rubric/1",
    rules: ["Review every bound criterion against the captured candidate.",
      "Keep missing or unverifiable evidence UNKNOWN.",
      "Only the daemon verifier may produce test proof and acceptance authority."],
    excludes: ["WORKER_TRANSCRIPT", "SELF_ASSESSMENT", "JOURNAL_ENTRY", "HANDOFF_PERSUASION"] });
  const submitted = artifact("SUBMITTED_BYTES", { version: "moe-runtime-review-input/1",
    projectId, subjectRef, source, binding, items: [...criteria, ...hashes, tree, receipt, rubric] });
  return Object.freeze({
    evidence: Object.freeze({ version: "moe-review-submission-evidence/1", artifacts: Object.freeze(artifacts) }),
    items: Object.freeze([...criteria, ...hashes, tree, receipt, rubric, submitted]),
  });
}
