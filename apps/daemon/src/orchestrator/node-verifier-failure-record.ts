import { REVIEW_SCHEMA_VERSION } from "../review/review-contracts.js";
import { runReviewCommand } from "../review/review-services.js";
import { readReviewLedger } from "../review/review-read-model.js";
import type { ReviewRoundRecord } from "../review/review-read-model.js";
import { verifierFailurePayload } from "./node-verifier-failure.js";
import type { NodeVerifierConfig, VerifierRunCapture } from "./node-verifier.js";
import type { VerifierAuthorityFacts } from "../review/verifier-receipt-ledger.js";

/** The host records a failed execution as part of its exact source submission, never as
 * a new coding permit. This seam has no HTTP/MCP command or caller-supplied origin flag.
 *
 * `withdraws` names the accepted verifier receipt a failed DELIVERY takes back (UnAI 2026-09-19:
 * accepted nodes whose work never landed stayed accepted forever). Such a round is sent at the
 * CURRENT ledger version: the receipt and the acceptance each moved the aggregate past `latest`,
 * so `latest.aggregateVersion` would be refused REVIEW_EXPECTED_VERSION_STALE every time. */
export function recordNodeVerifierFailure(
  config: Pick<NodeVerifierConfig, "deps" | "operatorCredential" | "projectId" | "store">,
  nodeRef: string, latest: ReviewRoundRecord,
  capture: VerifierRunCapture, authority: VerifierAuthorityFacts, withdraws?: string,
): Readonly<{ ok: boolean; code: string }> {
  const auth = config.deps.authenticator.authenticate(config.operatorCredential);
  if (auth.verdict !== "AUTHENTICATED") return { ok: false, code: "AUTHENTICATION_FAILED" };
  if (auth.principal.projectId !== config.projectId || !auth.principal.capabilities.includes("review.write")) {
    return { ok: false, code: "CAPABILITY_DENIED" };
  }
  if (capture.exitCode === 0) return { ok: false, code: "VERIFIER_SOURCE_NOT_FAILED" };
  const request = { schemaVersion: REVIEW_SCHEMA_VERSION,
    commandId: `${withdraws === undefined ? "verify-failure" : "delivery-withdrawn"}-${latest.decisionId}`,
    correlationId: "node-verifier", decidedAt: new Date().toISOString(),
    expectedVersion: withdraws === undefined ? latest.aggregateVersion
      : readReviewLedger(config.store, config.projectId, nodeRef).version,
    kind: "review.submit", projectId: config.projectId, principalId: auth.principal.principalId,
    payload: verifierFailurePayload(nodeRef, latest.round + 1, capture, authority.packageItems) };
  const sent = runReviewCommand(config.store, new TextEncoder().encode(JSON.stringify(request)), undefined, undefined,
    { aggregateVersion: latest.aggregateVersion, decisionId: latest.decisionId, resultSha256: latest.resultSha256,
      ...(withdraws === undefined ? {} : { withdraws }) });
  return { ok: sent.ok, code: sent.ok ? sent.decision.resultCode : sent.code };
}
