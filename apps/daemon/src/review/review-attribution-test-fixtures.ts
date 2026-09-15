import { GOAL_ID, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { readGraphBody } from "../planning/graph-body-record.js";
import { approveGate1, approvePlan, boundWorld, committedRevision, nodeOf, structureOf, submit }
  from "../planning/plan-reject-test-fixtures.js";
import type { ReviewOutcome } from "./review-ledger.js";
import { readReviewLedger } from "./review-read-model.js";
import { runReviewCommand } from "./review-services.js";
import { envelope, packageItems } from "./review-test-fixtures.js";

const encoder = new TextEncoder();

/**
 * A REAL approved plan in UnAI's live shape (addendum 2026-09-15): two root nodes with no edge
 * between them and a consumer of both. `api` stands for uai-r2-evidence-runtime (its own
 * criterion passes, a repository check needs another node's deliverable) and `worker` for
 * uai-r2-registry-release (the owner of that deliverable).
 */
export function attributionPlan() {
  const store = boundWorld();
  const revision = committedRevision(store, true);
  approveGate1(store, revision);
  const sealed = submit(store, revision, { structure: structureOf([
    nodeOf("api", ["crit-api"]), nodeOf("worker", ["crit-worker"]), nodeOf("ui", ["crit-ui"], ["api", "worker"]),
  ], "ui") });
  if (!sealed.ok) throw new Error(sealed.code);
  approvePlan(store, sealed.runId);
  const graph = readGraphBody(store, PROJECT_ID, sealed.graphContentHash);
  if (!graph.ok) throw new Error(graph.code);
  const refOf = (nodeKey: string) => compiledExecutionRef(PROJECT_ID, {
    content: graph.content, goalRef: GOAL_ID, planningRunRef: sealed.runId }, nodeKey);
  const api = refOf("api");
  const ledger = (subjectRef = api) => readReviewLedger(store, PROJECT_ID, subjectRef);
  const send = (kind: string, payload: Record<string, unknown>, commandId: string, subjectRef = api): ReviewOutcome =>
    runReviewCommand(store, encoder.encode(JSON.stringify({
      ...envelope(kind, ledger(subjectRef).version, payload, commandId), projectId: PROJECT_ID })));
  const round = (findings: readonly Record<string, unknown>[], commandId: string, subjectRef = api) =>
    send("review.submit", { findings, packageItems: packageItems(), round: ledger(subjectRef).version + 1, subjectRef },
      commandId, subjectRef);
  return { store, api, refOf, send, round, ledger };
}

export const REGISTRY_CHECK = Object.freeze({
  detail: "pnpm validate:registry exits REGISTRY_RELEASE_MISSING until the worker's release lands",
  ruleId: "registry-release-missing",
  severity: "MAJOR",
  subject: Object.freeze({ kind: "ARTIFACT", locator: ".github/workflows/foundation.yml" }),
});

export function attributed(
  nodeKey: string, criterionIds: readonly string[], base: Record<string, unknown> = REGISTRY_CHECK,
): Record<string, unknown> {
  return { ...base, attributedTo: { criterionIds: [...criterionIds], nodeKey } };
}
