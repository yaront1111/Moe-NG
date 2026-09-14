import type { JsonValue } from "@moe/contracts";
import type { ReviewLedger, ReviewRoundRecord } from "./review-read-model.js";
import { isPlainJsonObject } from "./review-contracts.js";

/** Host-only exact clean submission. No command payload admits this authority. */
export interface ReviewVerifierFailureSource {
  readonly aggregateVersion: number;
  readonly decisionId: string;
  readonly resultSha256: string;
}

export function verifierFailureSourceMatches(
  source: ReviewVerifierFailureSource | undefined, ledger: ReviewLedger,
): boolean {
  const latest = ledger.rounds.at(-1);
  return source !== undefined && !ledger.unreadable && !ledger.replanned && ledger.accepted === undefined
    && latest?.routing.route === "ACCEPT" && ledger.version === latest.aggregateVersion
    && source.aggregateVersion === latest.aggregateVersion && source.decisionId === latest.decisionId
    && source.resultSha256 === latest.resultSha256;
}

export function storedVerifierFailureSourceMatches(value: JsonValue, prior: ReviewRoundRecord | undefined): boolean {
  if (!isPlainJsonObject(value) || prior === undefined) return false;
  return Object.keys(value).length === 3 && prior.routing.route === "ACCEPT"
    && value["aggregateVersion"] === prior.aggregateVersion && value["decisionId"] === prior.decisionId
    && value["resultSha256"] === prior.resultSha256;
}
