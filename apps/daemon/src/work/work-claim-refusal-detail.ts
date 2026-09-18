import type { JsonObject } from "@moe/contracts";

import { isIsoInstant } from "./work-claim-contracts.js";
import type { WorkClaimCommandKind } from "./work-claim-contracts.js";
import type { WorkClaimRecord } from "./work-claim-read-model.js";

/**
 * The WHY behind a work-claim refusal, in the caller's own terms.
 *
 * The codes are a closed vocabulary (`work-claim-contracts.ts`) and stay exactly as they are;
 * this module only names the key that was missing or malformed and the shape it takes, or who
 * holds the item and until when. A live seat (UnAI 2026-09-18, node 10) finished its work,
 * outlived its claim, was refused `REVIEW_SUBMISSION_CLAIM_REQUIRED`, tried `work.renew` and
 * `work.claim` with `{workItemId}` alone, read `WORK_CLAIM_PAYLOAD_INVALID` with no detail,
 * then `WORK_CLAIM_NOT_FOUND` on its release, and stopped: a whole attempt lost to a refusal
 * that did not say which key it wanted.
 *
 * Nothing here is authority: the decode in `work-claim-services.ts` still decides, and this
 * text is derived from the same reads AFTER that decision, never instead of it.
 */

export const EXPIRES_AT_SHAPE =
  "an ISO-8601 UTC instant with millisecond precision, like 2026-09-18T12:00:00.000Z, "
  + "later than now";

/** Bounded, JSON-quoted: a caller value must not amplify or smuggle bytes into the detail. */
const VALUE_PREVIEW_CHARS = 48;

/** A caller's work item id as a detail names it: JSON-quoted and bounded, never raw (review of e15af58a). */
function itemWords(workItemId: string): string {
  return JSON.stringify(workItemId.length > VALUE_PREVIEW_CHARS ? `${workItemId.slice(0, VALUE_PREVIEW_CHARS)}…` : workItemId);
}

function describeValue(value: unknown): string {
  if (typeof value === "string") {
    const shown = value.length > VALUE_PREVIEW_CHARS
      ? `${value.slice(0, VALUE_PREVIEW_CHARS)}…` : value;
    return `got ${JSON.stringify(shown)}`;
  }
  if (value === null) return "got null";
  if (Array.isArray(value)) return "got an array";
  return `got ${typeof value === "object" ? "an object" : `a ${typeof value}`}`;
}

/** The exact key roster each kind admits, as the ingress `PAYLOAD_KEYS` row spells it. */
export function payloadShapeOf(kind: WorkClaimCommandKind): string {
  return kind === "work.release" ? "{workItemId}" : "{expiresAt, workItemId}";
}

/** `null` when the payload is well-formed for `kind`; otherwise every issue, in key order. */
export function payloadInvalidDetail(kind: WorkClaimCommandKind, payload: JsonObject): string | null {
  const issues: string[] = [];
  if (kind !== "work.release") {
    const expiresAt = payload["expiresAt"];
    if (expiresAt === undefined) issues.push(`expiresAt must be ${EXPIRES_AT_SHAPE} (missing)`);
    else if (!isIsoInstant(expiresAt)) {
      issues.push(`expiresAt must be ${EXPIRES_AT_SHAPE} (malformed: ${describeValue(expiresAt)})`);
    }
  }
  const workItemId = payload["workItemId"];
  if (workItemId === undefined) issues.push("workItemId must be a non-empty string (missing)");
  else if (typeof workItemId !== "string" || workItemId.length === 0) {
    issues.push(`workItemId must be a non-empty string (malformed: ${describeValue(workItemId)})`);
  }
  if (issues.length === 0) return null;
  return `${kind} takes exactly ${payloadShapeOf(kind)}; ${issues.join("; ")}`;
}

/** No OPEN claim at decide time: never claimed, released, or expired — three different retries. */
export function claimNotFoundDetail(
  kind: WorkClaimCommandKind, workItemId: string,
  existing: WorkClaimRecord | undefined, decidedAt: string,
): string {
  if (existing === undefined) return `${kind}: ${itemWords(workItemId)} has never been claimed`;
  if (existing.status === "RELEASED") {
    return `${kind}: the claim on ${itemWords(workItemId)} was already released (last held by ${existing.claimedBy})`;
  }
  return `${kind}: the claim on ${itemWords(workItemId)} held by ${existing.claimedBy} expired at `
    + `${existing.expiresAt}, before the daemon's ${decidedAt}; a work.claim at expectedVersion = `
    + "the item's claimAggregateVersion takes it again";
}

export function claimHeldDetail(workItemId: string, held: WorkClaimRecord): string {
  return `work.claim: ${itemWords(workItemId)} is held by ${held.claimedBy} until ${held.expiresAt}`;
}

export function notClaimantDetail(
  kind: WorkClaimCommandKind, workItemId: string, held: WorkClaimRecord, principalId: string,
): string {
  const base = `${kind}: ${itemWords(workItemId)} is held by ${held.claimedBy} until ${held.expiresAt}, not by ${principalId}`;
  return kind === "work.release"
    ? `${base}; the holder's seat is live (or its liveness unreadable), so only the holder releases it`
    : `${base}; only the holder renews its own claim`;
}
