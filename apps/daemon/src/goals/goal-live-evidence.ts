/**
 * THE LIVE LEG of `goal.close` qualification.
 *
 * `goal-qualification.ts` was written against the FOUNDATION path: a node closes only when a
 * durable Foundation verification receipt names it. The running loop mints no such receipt — it
 * produces a review acceptance, the verifier receipt that acceptance names, and (when landing is
 * on) a landing receipt from the wrapper's lander. So every live goal died at
 * `GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT` while carrying complete, durable evidence.
 *
 * This module holds the second leg and the composer both legs share. It adds NO refusal code and
 * NO layer: `GOAL_PREREQUISITE_REFUSAL_CODES` has five pinned consumers, and the roster's own
 * convention — two codes raised by more than one guard, told apart by their MESSAGE — is what a
 * refused landing follows.
 *
 * WHAT THE LIVE LEG DOES NOT RELAX. `reviewClosure` still runs first for both legs: the
 * acceptance must exist, no re-plan may supersede it, the verifier receipt must read back with a
 * matching sha256 and review-input digest, and it must still attest the LATEST review round. The
 * live leg adds the landing rule on top of that; it never stands in for it.
 *
 * THE LEG TAG IS IN EVERY PREIMAGE. A Foundation proof and a live proof of the same node must
 * never derive the same ref, or one could be replayed as the other. `composeClosure` therefore
 * frames the leg name into the acceptance, obligations and zero-authority preimages alike.
 */

import { createHash } from "node:crypto";

import type { JsonObject } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import type { LandingReceiptV1 } from "../repository/landing-receipt-contracts.js";
import { readReviewLedgers } from "../review/review-read-model.js";
import type { AcceptanceRecord } from "../review/review-read-model.js";
import {
  GOAL_CLOSE_REVIEW_PACKAGE_STALE, GOAL_CLOSE_VERIFICATION_NOT_PASSED, GOAL_PREREQUISITE_LAYER,
} from "./goal-close-prerequisite.js";
import type { GoalPrerequisiteRefusalCode } from "./goal-close-prerequisite.js";
import type { DurableReceipt } from "./goal-qualification-reads.js";

export const GOAL_CLOSURE_WITNESS_VERSION = "moe-goal-closure-witness/1" as const;

export interface GoalClosureQualified {
  readonly closureWitness: JsonObject;
  /**
   * Which leg proved each approved node. A SIBLING of the witnesses, never a key inside one:
   * core validates both witnesses against exact key rosters, so this reaches `goal-services.ts`
   * and stops there. Child 2 (task-8145137c) reads it for the affordance offer gate.
   */
  readonly legs: Readonly<Record<string, "FOUNDATION" | "LIVE">>;
  readonly ok: true;
  readonly zeroAuthorityWitness: JsonObject;
}

export interface GoalClosureRefused {
  readonly code: GoalPrerequisiteRefusalCode;
  readonly layer: typeof GOAL_PREREQUISITE_LAYER;
  /** Two codes are raised by more than one guard; the message is what tells them apart. */
  readonly message: string;
  readonly ok: false;
}

export type GoalClosureQualification = GoalClosureQualified | GoalClosureRefused;

/** The ONE refusal constructor both legs use, so no call site can drift on the layer. */
export function refuseClosure(
  code: GoalPrerequisiteRefusalCode, message: string,
): GoalClosureRefused {
  return Object.freeze({ code, layer: GOAL_PREREQUISITE_LAYER, message, ok: false as const });
}

/**
 * The lander's own legitimate empty-diff refusal, spelled here rather than imported.
 *
 * `orchestrator/node-lander.ts:150` raises it when no workspace path differs from the staffing
 * baseline — a node that changed nothing landed nothing, and that is a normal outcome rather
 * than a failure. Qualification must not depend on the orchestrator, so the literal is restated;
 * if the lander ever renames it, this leg refuses NOT_PASSED naming the new code, which is the
 * safe direction to fail.
 */
const LANDING_NOTHING_TO_COMMIT = "NOTHING_TO_COMMIT" as const;

/** What a node's landing evidence says. `NONE` means no landing receipt exists at all. */
export type LiveLanding = "COMMITTED" | "NOTHING_TO_COMMIT" | "NONE";

export type ClosureLeg =
  | Readonly<{
    readonly accepted: AcceptanceRecord;
    readonly leg: "FOUNDATION";
    readonly nodeRef: string;
    readonly receipt: DurableReceipt;
  }>
  | Readonly<{
    readonly accepted: AcceptanceRecord;
    readonly landing: LiveLanding;
    readonly landingReceiptId: string | null;
    readonly leg: "LIVE";
    readonly nodeRef: string;
    readonly verifierReceiptSha256: string;
  }>;

/** Length-framed and version-tagged, so the preimage is injective: no two different ordered
 *  tuples can frame to the same bytes, and a ref never silently means something else. */
export function derivedRef(tag: string, parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(`${GOAL_CLOSURE_WITNESS_VERSION}|${tag}`);
  for (const part of parts) hash.update(`|${String(part.length)}:${part}`);
  return hash.digest("hex");
}

/**
 * The landing rule, applied to the one receipt (if any) this node carries.
 *
 * ABSENCE IS ADMITTED, PRESENCE IS CHECKED. Landing is a wrapper knob (`MOE_NODE_LANDING=0`) and
 * every node finished before landing existed has none, so demanding one would refuse honest
 * closures. A landing that IS there, though, is evidence, and evidence that says the commit did
 * not happen for any reason other than "there was nothing to commit" refuses.
 */
function landingLeg(
  accepted: AcceptanceRecord, nodeRef: string, landing: LandingReceiptV1 | undefined,
): ClosureLeg | GoalClosureRefused {
  const live = {
    accepted, leg: "LIVE" as const, nodeRef,
    verifierReceiptSha256: accepted.verifierReceiptSha256,
  };
  if (landing === undefined) {
    return Object.freeze({ ...live, landing: "NONE" as const, landingReceiptId: null });
  }
  // A landing left over from an EARLIER verifier receipt attests bytes the acceptance never
  // saw; admitting it would let a stale commit stand in for the accepted one.
  if (landing.verifierReceiptId !== accepted.verifierReceiptId) {
    return refuseClosure(GOAL_CLOSE_REVIEW_PACKAGE_STALE,
      "the landing receipt attests a different verifier receipt");
  }
  if (landing.outcome === "COMMITTED") {
    return Object.freeze({
      ...live, landing: "COMMITTED" as const, landingReceiptId: landing.receiptId,
    });
  }
  const code = landing.refusal?.code ?? "";
  if (code !== LANDING_NOTHING_TO_COMMIT) {
    return refuseClosure(GOAL_CLOSE_VERIFICATION_NOT_PASSED,
      `the landing receipt refused ${code}`);
  }
  return Object.freeze({
    ...live, landing: LANDING_NOTHING_TO_COMMIT, landingReceiptId: landing.receiptId,
  });
}

/**
 * The live evidence for ONE approved node whose acceptance the caller has already qualified.
 *
 * Exactly one subject is passed to `readReviewLedgers` so the ledger walk stays cheap; the
 * landings map is keyed by the BARE node key, while the receipt itself sits on the sibling
 * `landing:<nodeRef>` aggregate so a commit never moves the node's own review version.
 *
 * FAILS CLOSED WITHOUT THROWING. `qualifyGoalClosure` has an outer catch, but relying on it
 * would answer every store fault with the acceptance code; a fault reading LANDING evidence is
 * about the landing, so it is caught and named here.
 */
export function readLiveNodeEvidence(
  store: SqliteEventStore, projectId: string, nodeRef: string, accepted: AcceptanceRecord,
): ClosureLeg | GoalClosureRefused {
  let landing: LandingReceiptV1 | undefined;
  try {
    landing = readReviewLedgers(store, projectId, new Set([nodeRef])).landings.get(nodeRef);
  } catch {
    return refuseClosure(GOAL_CLOSE_VERIFICATION_NOT_PASSED,
      "the durable landing evidence could not be read");
  }
  return landingLeg(accepted, nodeRef, landing);
}

/** The per-entry acceptance preimage: the leg tag first, then that leg's OWN evidence. */
function acceptanceParts(entry: ClosureLeg): readonly string[] {
  return [
    entry.leg,
    entry.nodeRef,
    ...entry.leg === "FOUNDATION"
      ? [entry.receipt.receiptSha256]
      : [entry.verifierReceiptSha256, entry.landing, entry.landingReceiptId ?? "NONE"],
    entry.accepted.verifierReceiptSha256,
    entry.accepted.reviewInputDigest,
  ];
}

/** Obligations: the Foundation receipt's own field, or the verifier receipt the live leg holds. */
function obligationParts(entry: ClosureLeg): readonly string[] {
  return [
    entry.leg, entry.nodeRef,
    entry.leg === "FOUNDATION" ? entry.receipt.obligations : entry.verifierReceiptSha256,
  ];
}

/**
 * Zero authority: only a FOUNDATION entry names a lease and an effect, because only a Foundation
 * attempt ever took one. A live entry contributes its tagged node key, so the proof still binds
 * the whole approved set rather than silently shrinking to the Foundation subset.
 */
function zeroAuthorityParts(entry: ClosureLeg): readonly string[] {
  return entry.leg === "FOUNDATION"
    ? [entry.receipt.leaseIdentity, entry.receipt.effectIdentity]
    : ["LIVE", entry.nodeRef];
}

/**
 * The two witnesses the core validates, derived from whatever leg each node closed on.
 *
 * The witness objects keep EXACTLY core's key rosters (`goal-validation.ts` CLOSURE_KEYS and
 * ZERO_KEYS): `validClosure` and `validZeroAuthority` compare key sets, so a `leg` key inside a
 * witness would refuse at the core. The leg therefore lives in the derived-ref preimages and in
 * the sibling `legs` field, which `goal-services.ts` never forwards.
 */
export function composeClosure(
  approvalRef: string, nodes: readonly string[], legs: readonly ClosureLeg[], activations: number,
): GoalClosureQualified {
  return Object.freeze({
    closureWitness: {
      acceptanceClosureRef: derivedRef("acceptance",
        [approvalRef, ...legs.flatMap(acceptanceParts)]),
      completionNodeAcceptedRef: derivedRef("completion-nodes", nodes),
      noCurrentPreparationGeneration: true,
      noPendingDraftOrSupersession: true,
      obligationsHoldRef: derivedRef("obligations", legs.flatMap(obligationParts)),
      truthClass: "DAEMON_VERIFIED",
    },
    legs: Object.freeze(Object.fromEntries(legs.map((entry) => [entry.nodeRef, entry.leg]))),
    ok: true as const,
    zeroAuthorityWitness: {
      truthClass: "DAEMON_VERIFIED",
      zeroAuthorityProofRef: derivedRef("zero-authority", [
        String(activations), ...legs.flatMap(zeroAuthorityParts),
      ]),
    },
  });
}
