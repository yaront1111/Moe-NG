import { DurableStoreError, type SqliteEventStore } from "@moe/store";
import { readPublicationIntent, readPublicationObservation } from "./publication-effect-ledger.js";
import type { PublicationObservation } from "./publication-effect-ledger.js";
import { readPublishLedger, recordPublishReceipt } from "./publish-ledger.js";
import type { PublishRequest } from "./publish-ledger.js";
import type { PublishReceiptV1 } from "./publish-receipt-contracts.js";
import { publishResolveRefusal } from "./publish-resolve-contracts.js";
import type { PublishResolveRefusal } from "./publish-resolve-contracts.js";

/**
 * `repository.publish_resolve`: the OPERATOR's answer to a publish stuck UNKNOWN, recorded as a FACT.
 *
 * WHY IT NEVER TOUCHES THE HOLD. The PUBLISHING reservation belongs to the wrapper's publisher
 * controller, and `release` refuses every other controller (REPOSITORY_EXECUTION_CONTROLLER_MISMATCH):
 * that ownership is what stops two processes racing on one reservation. So this records ONE REFUSED
 * receipt for the decision and the owning publisher releases its own hold on its next pass
 * (PUBLISH_RESOLVED), the way `repository.recover` records facts its owner acts on. It never pushes:
 * a later publish is a fresh decision with its own intent.
 *
 * WHAT IT RESOLVES is exactly what the card calls UNKNOWN (http/run-goal-publication.ts): a request
 * with no receipt whose intent is journaled, or unreadable. The receipt settles the card at once.
 */

/** The receipt code an operator resolve records, by resolution. Nothing else writes these codes. */
export const PUBLISH_RESOLVED_CODES = Object.freeze({
  ABANDON: "PUBLISH_RESOLVED_ABANDON",
  NOT_TRANSMITTED: "PUBLISH_RESOLVED_NOT_TRANSMITTED",
} as const);
export type PublishResolution = keyof typeof PUBLISH_RESOLVED_CODES;
export const isPublishResolvedCode = (code: string): boolean =>
  Object.values(PUBLISH_RESOLVED_CODES).some((known) => known === code);

export type PublishResolveResult = Readonly<{ ok: true; receipt: PublishReceiptV1; replayed: boolean }> | PublishResolveRefusal;

const seenWords = (seen: PublicationObservation | null): string => seen === null ? "no observation of the remote was recorded"
  : `last observation ${seen.observedAt}: remote tip ${seen.observedSha ?? "absent"}, expected ${seen.expectedSha}, push ${seen.reason}`;

function findRequest(store: SqliteEventStore, projectId: string, decisionId: string)
  : Readonly<{ request: PublishRequest; receipt: PublishReceiptV1 | undefined }> | null {
  for (const [, state] of readPublishLedger(store, projectId)) {
    const request = state.requests.find((each) => each.decisionId === decisionId);
    if (request !== undefined) return { request, receipt: state.receipts.get(decisionId) };
  }
  return null;
}

export function resolvePublish(store: SqliteEventStore, input: Readonly<{ projectId: string; decisionId: string;
  resolution: PublishResolution; decidedAt: string }>): PublishResolveResult {
  const { projectId, decisionId, resolution } = input;
  const found = findRequest(store, projectId, decisionId);
  if (found === null) return publishResolveRefusal("PUBLISH_RESOLVE_DECISION_NOT_FOUND", "no publish request has this decision id");
  const { request, receipt } = found;
  if (receipt !== undefined) return publishResolveRefusal("PUBLISH_RESOLVE_NOT_UNKNOWN", `the publish already has a ${receipt.outcome} receipt`);
  let intended = true; // an intent that cannot be read is UNKNOWN on the card, so it is resolvable here too
  try { intended = readPublicationIntent(store, projectId, request.goalId, decisionId) !== null; } catch { /* stays UNKNOWN */ }
  if (!intended) return publishResolveRefusal("PUBLISH_RESOLVE_NOT_UNKNOWN", "the publish never journaled an intent: nothing was attempted");
  // THE DOUBLE-TRANSMISSION GUARD: "not transmitted" is false once the publisher saw the approved sha on the remote.
  const seen = readPublicationObservation(store, projectId, request.goalId, decisionId);
  const approved = request.candidate?.approval ?? null;
  if (resolution === "NOT_TRANSMITTED" && approved !== null && seen?.observedSha === approved.sha) {
    return publishResolveRefusal("PUBLISH_RESOLVE_REMOTE_HOLDS_SHA",
      `the latest observation (${seen.observedAt}) shows the remote at the approved ${approved.sha}: the push landed`);
  }
  const code = PUBLISH_RESOLVED_CODES[resolution];
  const written = recordPublishReceipt(store, { branch: approved?.branch ?? null, decidedAt: input.decidedAt, decisionId,
    goalId: request.goalId, projectId, refusal: { code, detail: `the operator resolved this publish as ${resolution}; ${seenWords(seen)}` },
    remoteUrl: request.remoteUrl, sha: approved?.sha ?? null, url: null });
  if (!written.ok) {
    throw new DurableStoreError(written.code === "EXPECTED_VERSION_CONFLICT" ? written.code : "STORE_CORRUPT",
      `the resolve receipt was not recorded: ${written.code}`);
  }
  // Another writer's receipt landed first (the publisher settled it meanwhile): this publish is no longer UNKNOWN.
  if (written.receipt.refusal?.code !== code) {
    return publishResolveRefusal("PUBLISH_RESOLVE_NOT_UNKNOWN", `the publish already has a ${written.receipt.outcome} receipt`);
  }
  return Object.freeze({ ok: true, receipt: written.receipt, replayed: written.replayed });
}
