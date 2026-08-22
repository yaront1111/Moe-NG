/**
 * Durable persistence of the plan.propose authority BODIES.
 *
 * The core carrier admits a canonical PlanRevision and AcceptanceContract, cross-checks them and
 * seals a six-field IDENTITY into `PlanningSubmissionSealed` — then drops the bodies. This module
 * builds the SECOND LEG of the same decision so the content survives: plan and criteria bodies
 * cannot exist without `PlanProposed`, nor `PlanProposed` without them.
 *
 * SCOPE, per the comment-d10bc0c5 ruling: this is a BODIES record, not b42db644's planning
 * authority envelope. That envelope's submission section requires a PLAN_REVIEW lifecycle with
 * sealed hashes, and no plan.propose chain can reach one (comment-4f54a956) — composing it is
 * task-bb923a7b's seam, and nothing here fabricates a sealed state to stand in for it.
 *
 * COMPOSES, NEVER REIMPLEMENTS. Both bodies are encoded and re-decoded by `@moe/core`'s own
 * codecs, whose encode path runs full admission internally, so a malformed or digest-inconsistent
 * body is refused by CORE with CORE's code and layer, passed through here verbatim. Both digests
 * are RECOMPUTED through the published derivations: a carried digest decides nothing.
 *
 * THE LAYER CONSTANT IS MODULE-PRIVATE. The security roster counts every exported column-zero
 * `*_LAYER(S)`; the closed TYPE is exported instead, and `bootstrap-ledger.ts` spells the literal.
 */
import { createHash } from "node:crypto";

import {
  decodeAcceptanceContractBytes,
  decodePlanRevisionBytes,
  deriveAcceptanceContractDigest,
  derivePlanRevisionDigest,
  encodeAcceptanceContract,
  encodePlanRevision,
} from "@moe/core";
import type { AcceptanceContractRefusal, PlanRevisionRefusal } from "@moe/core";
import type { ExpectedVersionDecisionLeg, SqliteEventStore } from "@moe/store";

const LAYER = "PLANNING_AUTHORITY_PERSISTENCE" as const;
/** One aggregate per run, so the bodies of two runs can never share a fence. */
const AGGREGATE_PREFIX = "planning-authority/";
const AUTHORITY_EVENT_TYPE = "PlanningAuthorityBodiesSealed";
const AUTHORITY_MEMBER = "authority";
const AUTHORITY_KEYS: readonly string[] = ["acceptanceContract", "planRevision"];

export type PlanningAuthorityPersistenceLayer = typeof LAYER;
/**
 * Closed on purpose. A refusal here is either this module's own or a core body codec's, and
 * naming the union is what makes `proposePlan` passing it into `refuse` a COMPILE-TIME check that
 * `SERVICE_REFUSED_BY` still carries every layer this seam can produce.
 */
export type PlanningAuthorityRefusalLayer =
  | AcceptanceContractRefusal["layer"] | PlanRevisionRefusal["layer"]
  | PlanningAuthorityPersistenceLayer;

export const PLANNING_AUTHORITY_PERSISTENCE_CODES = Object.freeze([
  "PLANNING_AUTHORITY_MALFORMED",
  "PLANNING_AUTHORITY_REQUIRED",
  "PLANNING_AUTHORITY_STATE_UNSEALED",
  "PLANNING_AUTHORITY_SUBMISSION_HASH_MISMATCH",
] as const);
export type PlanningAuthorityPersistenceCode =
  (typeof PLANNING_AUTHORITY_PERSISTENCE_CODES)[number];

/** What the commit seam merges into the decision result so a reader can find the bodies. */
export interface PlanningAuthorityBinding {
  readonly authorityRef: string;
  readonly bodiesDigest: string;
  readonly criteriaDigest: string;
  readonly planHash: string;
}

export interface PlanningAuthorityLegInput {
  readonly lastCommand: unknown;
  readonly request: { readonly principalId: string; readonly projectId: string };
  readonly runId: string;
  readonly state: unknown;
  readonly store: SqliteEventStore;
}

/**
 * RETIRED MEMBER, recorded rather than dropped: `{ kind: "ABSENT" }`. Its world was "the propose
 * terminal carries no authority member", which until task-16a6a2b1 committed the run on a single
 * aggregate — D1's optional-at-the-edge legacy arm. The flip below refuses that terminal, so the
 * member became UNRETURNABLE rather than merely unused. Safe by measurement: one production
 * caller (`planning-services.ts`), one producer — the line the flip replaces.
 * NOT `planning-authority-finalize.ts`'s `{ kind: "ABSENT" }`, a different type on a different
 * seam (the ENVELOPE is absent: not in PLAN_REVIEW, or no record). That one stays.
 */
export type PlanningAuthorityLegResult =
  | {
    readonly code: string; readonly kind: "REFUSED";
    readonly layer: PlanningAuthorityRefusalLayer;
  }
  | {
    readonly binding: PlanningAuthorityBinding; readonly kind: "LEG";
    readonly leg: ExpectedVersionDecisionLeg;
  };

export const planningAuthorityAggregateId = (runId: string): string =>
  `${AGGREGATE_PREFIX}${runId}`;

const encoder = new TextEncoder();

const refused = (
  code: string, layer: PlanningAuthorityRefusalLayer,
): PlanningAuthorityLegResult => Object.freeze({ code, kind: "REFUSED" as const, layer });

const own = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
};

/**
 * Length-framed concatenation, the repository's collision discipline: without the frames a byte
 * moved from the end of one body to the start of the other would leave the digest unchanged.
 *
 * EXPORTED for the read side (`planning-authority-reader.ts`, task-47b2dbc6), which recomputes
 * this digest over the bytes it finds on disk. A second copy of the algorithm there would be a
 * fork: the two could drift apart and the reader would certify bodies this writer never sealed.
 */
export function bodiesDigestOf(planBytes: Uint8Array, contractBytes: Uint8Array): string {
  return createHash("sha256")
    .update(`${planBytes.length}:`, "utf8").update(planBytes)
    .update(`${contractBytes.length}:`, "utf8").update(contractBytes)
    .digest("hex");
}

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/**
 * A plain data read. The member has already survived the core fold, which refuses an accessor or
 * proxy shell outright (`planAuthorityCarry` reads the descriptor and refuses a getter), so a
 * hostile shape cannot arrive here green; this read only has to be exact about PRESENCE. An
 * `undefined` member is no longer a shape this seam interprets — the caller refuses it with
 * PLANNING_AUTHORITY_REQUIRED before any of the reads below run (task-16a6a2b1).
 */
function authorityOf(lastCommand: unknown): Readonly<Record<string, unknown>> | null | undefined {
  const member = own(lastCommand, AUTHORITY_MEMBER);
  if (member === undefined) return undefined;
  if (member === null || typeof member !== "object") return null;
  if (Reflect.ownKeys(member).length !== AUTHORITY_KEYS.length) return null;
  const snapshot: Record<string, unknown> = {};
  for (const key of AUTHORITY_KEYS) {
    const value = own(member, key);
    if (value === undefined) return null;
    snapshot[key] = value;
  }
  return Object.freeze(snapshot);
}

interface AdmittedBodies {
  readonly contractBytes: Uint8Array;
  readonly criteriaDigest: string;
  readonly criteriaRef: string;
  readonly graphContentHash: string;
  readonly graphRevisionRef: string;
  readonly planBytes: Uint8Array;
  readonly planHash: string;
  readonly revisionId: string;
}

/**
 * Encode-then-decode through the published core codecs. The encode path runs full admission and
 * verifies the body's own carried digest, so a refusal here is CORE's verdict and travels out
 * unchanged; the decode hands back core's frozen record, which is what the fields are read from.
 */
function admitBodies(
  authority: Readonly<Record<string, unknown>>,
): AdmittedBodies | PlanningAuthorityLegResult {
  const planEncoded = encodePlanRevision(authority["planRevision"]);
  if (!planEncoded.ok) return refused(planEncoded.code, planEncoded.layer);
  const contractEncoded = encodeAcceptanceContract(authority["acceptanceContract"]);
  if (!contractEncoded.ok) return refused(contractEncoded.code, contractEncoded.layer);
  const revision = decodePlanRevisionBytes(planEncoded.bytes);
  if (!revision.ok) return refused(revision.code, revision.layer);
  const contract = decodeAcceptanceContractBytes(contractEncoded.bytes);
  if (!contract.ok) return refused(contract.code, contract.layer);
  const planDigest = derivePlanRevisionDigest(revision.revision);
  if (!planDigest.ok) return refused(planDigest.code, planDigest.layer);
  const criteria = deriveAcceptanceContractDigest(contract.contract);
  if (!criteria.ok) return refused(criteria.code, criteria.layer);
  return Object.freeze({
    contractBytes: contractEncoded.bytes,
    criteriaDigest: criteria.criteriaDigest,
    criteriaRef: contract.contract.contractId,
    graphContentHash: revision.revision.graphBinding.graphContentHash,
    graphRevisionRef: revision.revision.graphBinding.graphRevisionRef,
    planBytes: planEncoded.bytes,
    planHash: planDigest.planHash,
    revisionId: revision.revision.revisionId,
  });
}

/**
 * Builds the authority leg for a proposal that carries bodies, or reports the legacy arm.
 *
 * The fence comes from `store.getAggregateVersion`, NOT from `versionOf(ledger, ...)`:
 * `readDurableLedger` folds only `decision.targetAggregateId`, so a SECONDARY leg's aggregate is
 * invisible to it and a ledger fence would read 0 forever — every write after the first would be
 * a stale-version conflict.
 */
export function buildPlanningAuthorityLeg(
  input: PlanningAuthorityLegInput,
): PlanningAuthorityLegResult {
  const authority = authorityOf(input.lastCommand);
  // D1 IS CLOSED AT THE EDGE (task-16a6a2b1). A terminal with no authority member used to
  // return the ABSENT leg and commit the run anyway; there is no legacy path to fall back on.
  if (authority === undefined) return refused("PLANNING_AUTHORITY_REQUIRED", LAYER);
  if (authority === null) return refused("PLANNING_AUTHORITY_MALFORMED", LAYER);
  const submissionHash = own(input.state, "submissionHash");
  const goalRef = own(input.state, "goalRef");
  if (typeof submissionHash !== "string" || typeof goalRef !== "string") {
    return refused("PLANNING_AUTHORITY_STATE_UNSEALED", LAYER);
  }
  const bodies = admitBodies(authority);
  if ("kind" in bodies) return bodies;
  if (bodies.planHash !== submissionHash) {
    return refused("PLANNING_AUTHORITY_SUBMISSION_HASH_MISMATCH", LAYER);
  }
  const authorityRef = planningAuthorityAggregateId(input.runId);
  const bodiesDigest = bodiesDigestOf(bodies.planBytes, bodies.contractBytes);
  const payload = {
    acceptanceContractBytesBase64: base64(bodies.contractBytes),
    bodiesDigest,
    criteriaDigest: bodies.criteriaDigest,
    criteriaRef: bodies.criteriaRef,
    goalRef,
    graphContentHash: bodies.graphContentHash,
    graphRevisionRef: bodies.graphRevisionRef,
    planHash: bodies.planHash,
    planRevisionBytesBase64: base64(bodies.planBytes),
    projectId: input.request.projectId,
    revisionId: bodies.revisionId,
    runId: input.runId,
    submissionHash,
  };
  return Object.freeze({
    binding: Object.freeze({
      authorityRef, bodiesDigest, criteriaDigest: bodies.criteriaDigest, planHash: bodies.planHash,
    }),
    kind: "LEG" as const,
    leg: Object.freeze({
      aggregateId: authorityRef,
      events: Object.freeze([Object.freeze({
        eventId: `${input.runId}-${AUTHORITY_EVENT_TYPE}`,
        eventType: AUTHORITY_EVENT_TYPE,
        payload: encoder.encode(JSON.stringify(payload)),
      })]),
      expectedVersion: input.store.getAggregateVersion(authorityRef),
    }),
  });
}
