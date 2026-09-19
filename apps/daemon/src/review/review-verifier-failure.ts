import type { JsonValue } from "@moe/contracts";
import type { ReviewLedger, ReviewRoundRecord } from "./review-read-model.js";
import { isPlainJsonObject } from "./review-contracts.js";

/** Host-only exact clean submission. No command payload admits this authority. */
export interface ReviewVerifierFailureSource {
  readonly aggregateVersion: number;
  readonly decisionId: string;
  readonly resultSha256: string;
  /**
   * The accepted verifier receipt this failed round takes back. Acceptance used to be final, so
   * a node whose accepted work then failed to DELIVER could never be staffed again (UnAI
   * 2026-09-19: a node branch that conflicted at integration, a landing refused over tracked
   * runtime metadata, a landing credited as nothing while 34 files sat in the node's tree).
   * Never stored under this name: the round result carries it as `withdrawsAcceptance`.
   */
  readonly withdraws?: string;
}

export function verifierFailureSourceMatches(
  source: ReviewVerifierFailureSource | undefined, ledger: ReviewLedger,
): boolean {
  const latest = ledger.rounds.at(-1);
  if (source === undefined || ledger.unreadable || ledger.replanned || latest?.routing.route !== "ACCEPT"
    || source.aggregateVersion !== latest.aggregateVersion || source.decisionId !== latest.decisionId
    || source.resultSha256 !== latest.resultSha256) return false;
  // A withdrawal names the acceptance itself, so it carries no version clause: the receipt and
  // the acceptance each moved the aggregate past the round they attest.
  return source.withdraws === undefined
    ? ledger.accepted === undefined && ledger.version === latest.aggregateVersion
    : ledger.accepted?.verifierReceiptId === source.withdraws;
}

export function storedVerifierFailureSourceMatches(value: JsonValue, prior: ReviewRoundRecord | undefined): boolean {
  if (!isPlainJsonObject(value) || prior === undefined) return false;
  return Object.keys(value).length === 3 && prior.routing.route === "ACCEPT"
    && value["aggregateVersion"] === prior.aggregateVersion && value["decisionId"] === prior.decisionId
    && value["resultSha256"] === prior.resultSha256;
}
