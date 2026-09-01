/**
 * The daemon finalize seam: folding `planning.finalize_submission` and composing b42db644's
 * planning-authority envelope from the DURABLE bodies record.
 *
 * WHY THIS EXISTS. `finalize` (planning-run-submission.ts:140-170) is the only writer of
 * lifecycle PLAN_REVIEW, `sealedHashes` and `graphRevisionRef`, and until this module it had no
 * production fold anywhere in the daemon — so no run ever reached PLAN_REVIEW durably and the
 * envelope's `readSubmission` gate had no composable producer at any seam (comment-4f54a956).
 *
 * WHY IT RIDES `plan.propose`. Design 201 and 1021 make finalization part of the SAME compound
 * `plan.propose(kind=...)` submission — "the sole compound plan.propose(kind=INITIAL) later
 * creates the immutable plan+graph revision after safe planner finalization" — and design 289,
 * 310 and 342 make it a LATER, runner-proven boundary judged against the drained durable state.
 * So the chain TERMINAL widens under the existing command kind rather than a new one being
 * minted: no new caller-selected authority, and the wired payload roster ["commands","runId"]
 * is untouched. The terminal roster and the caller-bodies detector live in the ingress half.
 *
 * THE RECORD IS THE ONLY BODY SOURCE. The bodies come from `planning-authority/<runId>` and from
 * nowhere else. Composition runs entirely through the certified codec, whose ten cross-bindings
 * are the guard — this module re-derives nothing and restates no code, so a refusal always names
 * the vocabulary that produced it, and the closed layer TYPE below is the COMPILE-TIME check
 * that `SERVICE_REFUSED_BY` still carries every layer this seam can surface.
 */
import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";
import { decodeAcceptanceContractBytes, decodePlanRevisionBytes } from "@moe/core";
import type { PlanningRunEvent, PlanningRunState } from "@moe/core";
import type { ExpectedVersionDecisionLeg, SqliteEventStore } from "@moe/store";

import {
  commitAccepted,
  commitAcceptedLegs,
  refuse,
  versionOf,
} from "../bootstrap/bootstrap-ledger.js";
import type { HandlerContext, ServiceOutcome } from "../bootstrap/bootstrap-ledger.js";
import { persistApprovalGate } from "./approval-gate.js";
import {
  encodePlanningAuthorityEnvelope,
  PLANNING_AUTHORITY_ENVELOPE_VERSION,
} from "./planning-authority-envelope.js";
import type { PlanningAuthorityRefusal } from "./planning-authority-envelope.js";
import { ownValue } from "./planning-authority-finalize-ingress.js";
import { planningAuthorityAggregateId } from "./planning-authority-persistence.js";
import { buildRunPolicyLeg } from "./run-policy-leg.js";

export const PLANNING_AUTHORITY_ENVELOPE_EVENT_TYPE = "PlanningAuthorityEnvelopeSealed";
export const PLANNING_SUBMISSION_FINALIZED_EVENT_TYPE = "PlanningSubmissionFinalized";
const BODIES_EVENT_TYPE = "PlanningAuthorityBodiesSealed";

/** Closed so `refuse` type-checks it against `SERVICE_REFUSED_BY` at every call site. */
export type PlanningAuthorityEnvelopeRefusalLayer = PlanningAuthorityRefusal["layer"];

export interface PlanningAuthorityEnvelopeBinding {
  readonly authorityRef: string;
  readonly envelopeDigest: string;
}

export interface PlanningAuthorityEnvelopeLegInput {
  readonly request: { readonly projectId: string };
  readonly runId: string;
  readonly state: unknown;
  readonly store: SqliteEventStore;
}

export type PlanningAuthorityEnvelopeLegResult =
  | { readonly kind: "ABSENT" }
  | {
    readonly code: string; readonly kind: "REFUSED";
    readonly layer: PlanningAuthorityEnvelopeRefusalLayer;
  }
  | {
    readonly binding: PlanningAuthorityEnvelopeBinding; readonly kind: "LEG";
    readonly leg: ExpectedVersionDecisionLeg;
  };

export interface FinalizedFold {
  readonly events: readonly PlanningRunEvent[];
  readonly state: PlanningRunState;
}

const encoder = new TextEncoder();

const refused = (
  code: string, layer: PlanningAuthorityEnvelopeRefusalLayer,
): PlanningAuthorityEnvelopeLegResult => Object.freeze({ code, kind: "REFUSED" as const, layer });

const bytesOf = (value: unknown): unknown =>
  typeof value === "string" ? Uint8Array.from(Buffer.from(value, "base64")) : undefined;

/**
 * The durable bodies record, or ABSENT. A record whose bytes do not decode is NOT absent: it
 * yields an empty record whose missing body bytes are refused by the CORE body codec, so a
 * corrupt record can never be silently reported as a run that carried no authority.
 */
function bodiesRecordOf(store: SqliteEventStore, aggregateId: string): JsonObject | null {
  const first = store.readEvents(aggregateId)
    .filter((event) => event.eventType === BODIES_EVENT_TYPE)[0];
  if (first === undefined) return null;
  const decoded = decodeBoundedJsonBytes(first.payload);
  const value: JsonValue | undefined = decoded.ok ? decoded.value : undefined;
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as JsonObject;
}

interface SealedSubmission {
  readonly goalRef: unknown; readonly graphRevisionRef: unknown; readonly lifecycle: unknown;
  readonly sealedHashes: unknown; readonly submissionHash: unknown;
}

const sealedOf = (state: unknown): SealedSubmission => ({
  goalRef: ownValue(state, "goalRef"),
  graphRevisionRef: ownValue(state, "graphRevisionRef"),
  lifecycle: ownValue(state, "lifecycle"),
  sealedHashes: ownValue(state, "sealedHashes"),
  submissionHash: ownValue(state, "submissionHash"),
});

/**
 * Composes the envelope and hands it to the certified codec BEFORE any write, so a refusal
 * leaves no event and no decision behind. Bodies come from the durable record; the submission
 * section comes from the just-folded state; the two identity fields the record contributes —
 * `revisionId` and `criteriaDigest` — are exactly the ones the codec cross-checks against the
 * decoded bodies, which is what makes those checks load-bearing here rather than tautological.
 */
export function buildPlanningAuthorityEnvelopeLeg(
  input: PlanningAuthorityEnvelopeLegInput,
): PlanningAuthorityEnvelopeLegResult {
  const sealed = sealedOf(input.state);
  // A fold that did not SEAL carries no authority: `finalize`'s refusal arm rejects the run and
  // writes no `sealedHashes`, so there is nothing to compose and composing anyway would refuse
  // the whole rejection. This is a SCOPE decision, not a restatement of the codec's gate — every
  // fold that DID seal still goes through `encodePlanningAuthorityEnvelope` unconditionally.
  if (sealed.lifecycle !== "PLAN_REVIEW") return Object.freeze({ kind: "ABSENT" as const });
  const authorityRef = planningAuthorityAggregateId(input.runId);
  const record = bodiesRecordOf(input.store, authorityRef);
  if (record === null) return Object.freeze({ kind: "ABSENT" as const });
  const revision = decodePlanRevisionBytes(bytesOf(record["planRevisionBytesBase64"]));
  if (!revision.ok) return refused(revision.code, revision.layer);
  const contract = decodeAcceptanceContractBytes(bytesOf(record["acceptanceContractBytesBase64"]));
  if (!contract.ok) return refused(contract.code, contract.layer);
  const submission = {
    criteriaDigest: record["criteriaDigest"],
    goalRef: sealed.goalRef,
    graphRevisionRef: sealed.graphRevisionRef,
    lifecycle: sealed.lifecycle,
    projectId: input.request.projectId,
    runId: input.runId,
    sealedHashes: sealed.sealedHashes,
    submissionHash: sealed.submissionHash,
  };
  const encoded = encodePlanningAuthorityEnvelope({
    acceptanceContract: contract.contract,
    bindings: {
      goalRef: sealed.goalRef, projectId: input.request.projectId,
      revisionId: record["revisionId"], runId: input.runId,
    },
    planRevision: revision.revision,
    submission,
    version: PLANNING_AUTHORITY_ENVELOPE_VERSION,
  });
  if (!encoded.ok) return refused(encoded.code, encoded.layer);
  return envelopeLeg(input, authorityRef, submission, encoded.bytes);
}

function envelopeLeg(
  input: PlanningAuthorityEnvelopeLegInput,
  authorityRef: string,
  submission: { readonly criteriaDigest: unknown; readonly sealedHashes: unknown },
  bytes: Uint8Array,
): PlanningAuthorityEnvelopeLegResult {
  const envelopeDigest = createHash("sha256").update(bytes).digest("hex");
  const payload = {
    criteriaDigest: submission.criteriaDigest,
    envelopeBytesBase64: Buffer.from(bytes).toString("base64"),
    envelopeDigest,
    planHash: ownValue(submission.sealedHashes, "planHash"),
    projectId: input.request.projectId,
    runId: input.runId,
  };
  return Object.freeze({
    binding: Object.freeze({ authorityRef, envelopeDigest }),
    kind: "LEG" as const,
    leg: Object.freeze({
      aggregateId: authorityRef,
      events: Object.freeze([Object.freeze({
        eventId: `${input.runId}-${PLANNING_AUTHORITY_ENVELOPE_EVENT_TYPE}`,
        eventType: PLANNING_AUTHORITY_ENVELOPE_EVENT_TYPE,
        payload: encoder.encode(JSON.stringify(payload)),
      })]),
      expectedVersion: input.store.getAggregateVersion(authorityRef),
    }),
  });
}

/**
 * The FINALIZE terminal's commit. Both legs are built BEFORE any durable write, so a refusal from
 * either leaves zero residue; an ABSENT leg is the arm where the fold did not seal and the fold
 * commits exactly as the reducer dictated. Either way ONE decision, so neither leg can survive
 * without the finalize event nor the finalize event without them.
 *
 * THE RISK LEG IS WHY A SEALED RUN ALWAYS HAS A TIER (task-a888038d). `buildRunPolicyLeg` reads
 * the SEALED graph the fold just produced, evaluates it through core against the installed
 * policy, and REFUSES when the result is untierable — which refuses the seal, because they are
 * one decision. There is no branch in which a run reaches PLAN_REVIEW carrying no evaluation.
 */
export function commitFinalizedSubmission(
  context: HandlerContext, runId: string, prior: JsonValue | undefined, folded: FinalizedFold,
): ServiceOutcome {
  const { ledger, request, store } = context;
  const envelope = buildPlanningAuthorityEnvelopeLeg({
    request, runId, state: folded.state, store,
  });
  if (envelope.kind === "REFUSED") return refuse(request.kind, envelope.code, envelope.layer);
  // Only the four SERVER facts and the folded state travel: `RunPolicyLegInput` has no payload
  // member, so no caller byte can reach the evaluation even by a later edit.
  const risk = buildRunPolicyLeg({
    decidedAt: request.decidedAt, ledger, principalId: request.principalId,
    projectId: request.projectId, runId, state: folded.state, store,
  });
  if (risk.kind === "REFUSED") return refuse(request.kind, risk.code, risk.layer);
  const carried = envelope.kind === "LEG" ? envelope.binding : {};
  const plan = {
    aggregateId: runId,
    eventPayload: folded.events as unknown as JsonValue,
    eventType: PLANNING_SUBMISSION_FINALIZED_EVENT_TYPE,
    expectedVersion: versionOf(ledger, runId),
    result: persistApprovalGate({
      ...carried, state: folded.state as unknown as JsonValue,
      submissionHash: folded.state.submissionHash,
    }, prior, request.payload["humanAuthorityGate"]),
  };
  const legs = [
    ...(envelope.kind === "LEG" ? [envelope.leg] : []),
    ...(risk.kind === "LEG" ? [risk.leg] : []),
  ];
  return legs.length > 0
    ? commitAcceptedLegs(store, request, plan, legs)
    : commitAccepted(store, request, plan);
}
