/**
 * The PENDING-PLAN read model: the run an approver is about to decide, read back over HTTP so a
 * human can see the plan and acceptance criteria they are attesting BEFORE approval.decide, which
 * today posts a fixture record against a run no route ever returns.
 *
 * AUTHENTICATE BEFORE DECODE, and behind the planning capability. The read carries the same
 * authority that proposes and approves a plan (`plan.propose` and `approval.decide` both map to
 * CAPABILITIES.PLANNING), so this route gates on that one existing capability rather than minting
 * a read-only one, exactly as `/graph/get` does. The body is decoded only after the gate.
 *
 * THE SEALED BODIES ARE RE-DECODED AND RE-DIGESTED, NEVER TRUSTED. The pending plan and criteria
 * live in the `PlanningAuthorityBodiesSealed` event on `planning-authority/<runId>`; the run
 * aggregate folds only lifecycle, submissionHash, authorityRef and (after finalize) envelopeDigest.
 * Both bodies are decoded through the published `@moe/core` codecs, whose decode path re-derives
 * each body's own digest and rejects a non-canonical spelling. Then two cross-checks bind the bytes
 * on disk to this run: the writer's framed `bodiesDigestOf` recompute (a valid body substituted for
 * another valid body passes every codec and is caught here alone), and the plan's re-derived
 * planHash against the run's authoritative submissionHash. Any failure reports the bodies as
 * UNSEALED — authority/plan/acceptance all null — and never a throw and never tampered content.
 *
 * `bodiesDigestOf` and `planningAuthorityAggregateId` are IMPORTED from the writer, not copied: a
 * second copy of either would be a fork the two could drift apart on, and a drifted reader would
 * certify bodies this writer never sealed. This module edits nothing under `planning/`.
 *
 * THE LAYER CONSTANT STAYS MODULE-PRIVATE. `boundary-roster.security.ts` counts every exported
 * column-zero `*_LAYER(S)`; a pure read earns no hostile trio, so this follows the precedent the
 * planning-authority reader modules set and exports only what a consumer switches on.
 */
import { PROJECT_CONFIGURATION_MAX_REF_CHARS, decodeBoundedJsonBytes } from "@moe/contracts";
import {
  decodeAcceptanceContractBytes,
  decodePlanRevisionBytes,
  derivePlanRevisionDigest,
} from "@moe/core";
import type { AcceptanceContract, PlanRevision } from "@moe/core";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import {
  bodiesDigestOf,
  planningAuthorityAggregateId,
} from "../planning/planning-authority-persistence.js";
import { authenticateHttpRequest } from "./http-adapter.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export const PLANNING_RUN_READ_PATH = "/planning/run/read" as const;

const PLANNING_RUN_READ_LAYER = "PLANNING_RUN_READ" as const;

/** The bodies the writer seals on `planning-authority/<runId>`; matched as a string because no
 *  site exports it. RENAME HAZARD, reported not fixed: a rename at the writer nulls this selector
 *  and presents as an unsealed run. */
const BODIES_EVENT_TYPE = "PlanningAuthorityBodiesSealed";

/** The run lifecycle approval demands; anything short of it is still planning, not a refusal. */
const REVIEWABLE_LIFECYCLE = "PLAN_REVIEW";

/**
 * Refusals this read ORIGINATES. Closed on purpose: a caller switches on it exhaustively, and a
 * lifecycle short of PLAN_REVIEW is NOT here (it is answered with `reviewable:false`), nor is
 * unsealed bodies (answered with `authority:null`). Transport faults - a malformed `{runId}` body,
 * an absent port - carry the listener's own codes and never enter this vocabulary.
 */
export const PLANNING_RUN_READ_CODES = Object.freeze([
  "PLANNING_RUN_READ_CAPABILITY_DENIED",
  "PLANNING_RUN_READ_PROJECT_MISMATCH",
  "PLANNING_RUN_READ_RUN_UNKNOWN",
] as const);

export type PlanningRunReadCode = (typeof PLANNING_RUN_READ_CODES)[number];

export interface PlanningRunStepView {
  readonly description: string;
  readonly kind: string;
  readonly stepId: string;
}

export interface PlanningRunPlanView {
  readonly affectedCriterionIds: readonly string[];
  readonly affectedNodeIds: readonly string[];
  readonly planHash: string;
  readonly steps: readonly PlanningRunStepView[];
}

export interface PlanningRunEvidenceView {
  readonly evidenceRef: string;
  readonly kind: string;
  readonly requirementId: string;
}

export interface PlanningRunObligationView {
  readonly criterionId: string;
  readonly evidenceRequirements: readonly PlanningRunEvidenceView[];
  readonly statement: string;
  readonly verificationRecipeRefs: readonly string[];
}

export interface PlanningRunAcceptanceView {
  readonly criteriaDigest: string;
  readonly obligations: readonly PlanningRunObligationView[];
}

export interface PlanningRunAuthorityView {
  readonly authorityRef: string;
  readonly bodiesDigest: string;
  /** Sealed only by `planning.finalize_submission`; null while the run is still PLANNING. */
  readonly envelopeDigest: string | null;
}

export interface PlanningRunView {
  readonly acceptance: PlanningRunAcceptanceView | null;
  readonly authority: PlanningRunAuthorityView | null;
  readonly lifecycle: string;
  readonly outcome: "RUN";
  readonly plan: PlanningRunPlanView | null;
  readonly reviewable: boolean;
  readonly runId: string;
  readonly submissionHash: string;
}

export interface PlanningRunRefused {
  readonly code: PlanningRunReadCode;
  readonly layer: typeof PLANNING_RUN_READ_LAYER;
  readonly outcome: "REFUSED";
}

export type PlanningRunReadResult = PlanningRunView | PlanningRunRefused;

/** ONE READER AND THE BOUND PROJECT. No commit and no writer: "this query writes nothing" is a
 *  property of the type, not a rule to remember while editing a transport. */
export interface PlanningRunReadPort {
  readonly boundProjectId: string;
  readPlanningRun(runId: string): PlanningRunReadResult;
}

interface VerifiedBodies {
  readonly acceptance: AcceptanceContract;
  readonly bodiesDigest: string;
  readonly plan: PlanRevision;
}

function refused(code: PlanningRunReadCode): PlanningRunRefused {
  return Object.freeze({ code, layer: PLANNING_RUN_READ_LAYER, outcome: "REFUSED" as const });
}

const objectOf = (value: unknown): Readonly<Record<string, unknown>> | null =>
  value === null || typeof value !== "object" || Array.isArray(value)
    ? null : (value as Readonly<Record<string, unknown>>);

const stringOf = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** `store.readEvents`, fail-closed: a store that cannot answer for the authority aggregate is an
 *  unsealed run, never a throw across the transport. */
function readAggregate(store: SqliteEventStore, aggregateId: string): readonly StoredEvent[] {
  try {
    return store.readEvents(aggregateId);
  } catch {
    return [];
  }
}

const bytesOf = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64, "base64"));

/**
 * The sealed bodies as they are ON DISK, decoded and bound to this run, or null when the run has
 * no readable seal. Exactly one bodies event is required: zero is a run that has not sealed, and
 * more than one is ambiguous - both fail closed rather than reading whichever arrived first.
 */
function verifyBodies(
  store: SqliteEventStore, authorityRef: string, submissionHash: string,
): VerifiedBodies | null {
  const matches = readAggregate(store, authorityRef)
    .filter((event) => event.eventType === BODIES_EVENT_TYPE);
  if (matches.length !== 1) return null;
  const decoded = decodeBoundedJsonBytes((matches[0] as StoredEvent).payload);
  const payload = decoded.ok ? objectOf(decoded.value) : null;
  if (payload === null) return null;
  const planBase64 = stringOf(payload["planRevisionBytesBase64"]);
  const contractBase64 = stringOf(payload["acceptanceContractBytesBase64"]);
  const sealedDigest = stringOf(payload["bodiesDigest"]);
  if (planBase64 === null || contractBase64 === null || sealedDigest === null) return null;
  const planBytes = bytesOf(planBase64);
  const contractBytes = bytesOf(contractBase64);
  // The codecs decide admissibility, canonicality and each body's own carried digest, so a byte
  // tamper of either body is refused here and travels no further.
  const plan = decodePlanRevisionBytes(planBytes);
  if (!plan.ok) return null;
  const acceptance = decodeAcceptanceContractBytes(contractBytes);
  if (!acceptance.ok) return null;
  // The framed recompute, the WRITER's own function: whether these bytes are the bytes the seal
  // covers. A valid body swapped for another valid body passes every codec and is caught only here.
  if (bodiesDigestOf(planBytes, contractBytes) !== sealedDigest) return null;
  // Re-derived and bound to the RUN aggregate, not to the payload beside it: the plan's planHash IS
  // the run's submissionHash by construction, so a whole-payload replant on the authority aggregate
  // (with a self-consistent framed digest) still cannot answer for this run.
  const planDigest = derivePlanRevisionDigest(plan.revision);
  if (!planDigest.ok || planDigest.planHash !== submissionHash) return null;
  return Object.freeze({
    acceptance: acceptance.contract, bodiesDigest: sealedDigest, plan: plan.revision,
  });
}

function planView(revision: PlanRevision): PlanningRunPlanView {
  return Object.freeze({
    affectedCriterionIds: Object.freeze([...revision.affectedCriterionIds]),
    affectedNodeIds: Object.freeze([...revision.affectedNodeIds]),
    planHash: revision.planHash,
    steps: Object.freeze(revision.steps.map((step) => Object.freeze({
      description: step.description, kind: step.kind, stepId: step.stepId,
    }))),
  });
}

function acceptanceView(contract: AcceptanceContract): PlanningRunAcceptanceView {
  return Object.freeze({
    criteriaDigest: contract.criteriaDigest,
    obligations: Object.freeze(contract.obligations.map((obligation) => Object.freeze({
      criterionId: obligation.criterionId,
      evidenceRequirements: Object.freeze(obligation.evidenceRequirements.map((evidence) =>
        Object.freeze({
          evidenceRef: evidence.evidenceRef, kind: evidence.kind, requirementId: evidence.requirementId,
        }))),
      statement: obligation.statement,
      verificationRecipeRefs: Object.freeze([...obligation.verificationRecipeRefs]),
    }))),
  });
}

/**
 * The pending run of `runId` in the bound project, or the refusal that names why there is none.
 * A run whose durable record exists but carries no lifecycle or submission hash is served UNKNOWN,
 * never a half frame: a caller must not read "no plan" as an answer about a run that never sealed.
 */
export function readPlanningRun(
  store: SqliteEventStore, projectId: string, runId: string,
): PlanningRunReadResult {
  const ledger = readDurableLedger(store, projectId);
  const record = objectOf(stateOf(ledger, runId));
  if (record === null) return refused("PLANNING_RUN_READ_RUN_UNKNOWN");
  const submissionHash = stringOf(record["submissionHash"]);
  const lifecycle = stringOf(objectOf(record["state"])?.["lifecycle"]);
  if (submissionHash === null || lifecycle === null) {
    return refused("PLANNING_RUN_READ_RUN_UNKNOWN");
  }
  const authorityRef = planningAuthorityAggregateId(runId);
  const bodies = verifyBodies(store, authorityRef, submissionHash);
  const envelopeDigest = stringOf(record["envelopeDigest"]);
  return Object.freeze({
    acceptance: bodies === null ? null : acceptanceView(bodies.acceptance),
    authority: bodies === null ? null : Object.freeze({
      authorityRef, bodiesDigest: bodies.bodiesDigest, envelopeDigest,
    }),
    lifecycle,
    outcome: "RUN" as const,
    plan: bodies === null ? null : planView(bodies.plan),
    reviewable: lifecycle === REVIEWABLE_LIFECYCLE,
    runId,
    submissionHash,
  });
}

export function createPlanningRunReadPort(config: {
  readonly projectId: string;
  readonly store: SqliteEventStore;
}): PlanningRunReadPort {
  return Object.freeze({
    boundProjectId: config.projectId,
    readPlanningRun: (runId: string): PlanningRunReadResult =>
      readPlanningRun(config.store, config.projectId, runId),
  });
}

type PlanningRunReadListenerCode =
  | "LISTENER_PLANNING_RUN_REQUEST_INVALID"
  | "LISTENER_PLANNING_RUN_UNAVAILABLE";

export interface PlanningRunReadDependencies {
  readonly authenticator: Authenticator;
  readonly planningRuns?: PlanningRunReadPort | undefined;
}

export interface PlanningRunReadRequest {
  readonly body: unknown;
  readonly credential: string | null;
  readonly protocolVersion: unknown;
}

export type PlanningRunReadDispatch =
  | {
      readonly body: HttpPortRefused | HttpRefused | PlanningRunReadResult;
      readonly httpStatus: number;
      readonly kind: "REPLY";
    }
  | {
      readonly code: PlanningRunReadListenerCode;
      readonly kind: "LISTENER_REFUSAL";
    };

function reply(
  httpStatus: number, body: HttpPortRefused | HttpRefused | PlanningRunReadResult,
): PlanningRunReadDispatch {
  return Object.freeze({ body, httpStatus, kind: "REPLY" as const });
}

function listenerRefusal(code: PlanningRunReadListenerCode): PlanningRunReadDispatch {
  return Object.freeze({ code, kind: "LISTENER_REFUSAL" as const });
}

const ALLOWED_BODY_KEYS: readonly string[] = Object.freeze(["runId"]);

/**
 * Exact-key `{ runId }`: an unlisted key is refused rather than trimmed, and the value is read off
 * its own data property so an inherited or accessor `runId` cannot answer for the caller. A non-NFC
 * id is refused because a decomposed string and its composed twin name one run to a human and two
 * to a comparison.
 */
function readRunId(body: unknown): string | null {
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok) return null;
  const value = objectOf(decoded.value);
  if (value === null) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== ALLOWED_BODY_KEYS[0]) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, "runId");
  if (descriptor === undefined || !("value" in descriptor)) return null;
  const runId: unknown = descriptor.value;
  if (typeof runId !== "string" || runId.length === 0
    || runId.length > PROJECT_CONFIGURATION_MAX_REF_CHARS) return null;
  return runId.normalize("NFC") === runId ? runId : null;
}

/**
 * Authenticate and check compatibility, then the planning capability, THEN the body - the gate
 * order `/graph/get` shares, so an unidentified or unauthorized caller never has their bytes
 * decoded. Availability and the project cross-check sit after the capability, so a caller without
 * it learns neither how this daemon is composed nor which run exists. The project is the
 * PRINCIPAL's, never a body field: this route names its subject by `runId` alone.
 */
export function handlePlanningRunReadRequest(
  dependencies: PlanningRunReadDependencies,
  request: PlanningRunReadRequest,
): PlanningRunReadDispatch {
  const access = authenticateHttpRequest(
    dependencies.authenticator, request.credential, request.protocolVersion,
  );
  if (!access.ok) return reply(access.httpStatus, access);
  if (!access.principal.capabilities.includes(CAPABILITIES.PLANNING)) {
    return reply(200, refused("PLANNING_RUN_READ_CAPABILITY_DENIED"));
  }
  if (dependencies.planningRuns === undefined) {
    return listenerRefusal("LISTENER_PLANNING_RUN_UNAVAILABLE");
  }
  if (access.principal.projectId !== dependencies.planningRuns.boundProjectId) {
    return reply(200, refused("PLANNING_RUN_READ_PROJECT_MISMATCH"));
  }
  const runId = readRunId(request.body);
  if (runId === null) return listenerRefusal("LISTENER_PLANNING_RUN_REQUEST_INVALID");
  return reply(200, dependencies.planningRuns.readPlanningRun(runId));
}
