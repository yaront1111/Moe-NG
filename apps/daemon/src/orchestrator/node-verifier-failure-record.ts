import { REVIEW_SCHEMA_VERSION } from "../review/review-contracts.js";
import { runReviewCommand } from "../review/review-services.js";
import type { ReviewRoundRecord } from "../review/review-read-model.js";
import { verifierFailurePayload } from "./node-verifier-failure.js";
import type { NodeVerifierConfig, VerifierRunCapture } from "./node-verifier.js";
import type { VerifierAuthorityFacts } from "../review/verifier-receipt-ledger.js";

/** The host records a failed execution as part of its exact source submission, never as
 * a new coding permit. This seam has no HTTP/MCP command or caller-supplied origin flag. */
export function recordNodeVerifierFailure(
  config: NodeVerifierConfig, nodeRef: string, latest: ReviewRoundRecord,
  capture: VerifierRunCapture, authority: VerifierAuthorityFacts,
): Readonly<{ ok: boolean; code: string }> {
  const auth = config.deps.authenticator.authenticate(config.operatorCredential);
  if (auth.verdict !== "AUTHENTICATED") return { ok: false, code: "AUTHENTICATION_FAILED" };
  if (auth.principal.projectId !== config.projectId || !auth.principal.capabilities.includes("review.write")) {
    return { ok: false, code: "CAPABILITY_DENIED" };
  }
  if (capture.exitCode === 0) return { ok: false, code: "VERIFIER_SOURCE_NOT_FAILED" };
  const request = { schemaVersion: REVIEW_SCHEMA_VERSION, commandId: `verify-failure-${latest.decisionId}`,
    correlationId: "node-verifier", decidedAt: new Date().toISOString(), expectedVersion: latest.aggregateVersion,
    kind: "review.submit", projectId: config.projectId, principalId: auth.principal.principalId,
    payload: verifierFailurePayload(nodeRef, latest.round + 1, capture, authority.packageItems) };
  const sent = runReviewCommand(config.store, new TextEncoder().encode(JSON.stringify(request)), undefined, undefined,
    { aggregateVersion: latest.aggregateVersion, decisionId: latest.decisionId, resultSha256: latest.resultSha256 });
  return { ok: sent.ok, code: sent.ok ? sent.decision.resultCode : sent.code };
}
