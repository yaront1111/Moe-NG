import { isProxy } from "node:util/types";

import {
  decodeAcceptanceContractBytes,
  deriveAcceptanceContractDigest,
  encodeAcceptanceContract,
} from "./acceptance-contract-codec.js";
import type { AcceptanceContract, AcceptanceContractRefusal } from "./acceptance-contract.js";
import {
  decodePlanRevisionBytes,
  derivePlanRevisionDigest,
  encodePlanRevision,
} from "./plan-revision-codec.js";
import type { PlanRevision, PlanRevisionRefusal } from "./plan-revision-contract.js";
import { exact } from "./planning-snapshot.js";

/**
 * The `plan.propose` authority parser: admission of the ONE bounded field that carries a canonical
 * PlanRevision and AcceptanceContract together, and the cross-bindings between those two bodies
 * and the proposal's legacy `submissionHash`.
 *
 * This module owns exactly three decisions: the two-key shell, whether the proposal is trying to
 * arrive with a decision it never earned, and whether the bodies and the legacy hash name the same
 * plan. Body admission, canonicalization and digest belong to the published codecs, and their
 * refusals pass through VERBATIM — restamping a `PLAN_REVISION_*` or `ACCEPTANCE_CONTRACT_*` code
 * into this vocabulary would hide which authority answered. There is no local hashing: a second
 * digest opinion is a fork.
 *
 * It lives beside `planning-command-contract.ts` rather than inside it because both that file and
 * `planning-run-submission.ts` sit at the planning sources' hard 250-physical-line ceiling.
 *
 * The layer constant stays module-private on purpose: an exported `*_LAYER` owes the security
 * boundary roster a BEFORE/AFTER/RACE trio. The closed TYPE is exported instead.
 */
const LAYER = "PLAN_AUTHORITY_SUBMISSION" as const;

export type PlanAuthoritySubmissionLayer = typeof LAYER;

export const PLAN_AUTHORITY_SUBMISSION_CODES = Object.freeze([
  "PLAN_AUTHORITY_SUBMISSION_MALFORMED", "PLAN_AUTHORITY_SUBMISSION_HASH_MISMATCH",
  "PLAN_AUTHORITY_GRAPH_REVISION_MISMATCH", "PLAN_AUTHORITY_GRAPH_CONTENT_MISMATCH",
  "PLAN_AUTHORITY_CRITERIA_BINDING_MISMATCH", "PLAN_AUTHORITY_APPROVAL_FORGED",
  "PLAN_AUTHORITY_REJECTION_FORGED",
] as const);

export type PlanAuthoritySubmissionCode = (typeof PLAN_AUTHORITY_SUBMISSION_CODES)[number];

export interface PlanAuthoritySubmissionRefusal {
  readonly code: PlanAuthoritySubmissionCode;
  readonly layer: PlanAuthoritySubmissionLayer;
  readonly ok: false;
}

/** Three vocabularies can answer; the `layer` field is what tells a caller which one did. */
export type PlanAuthorityRefusal =
  | AcceptanceContractRefusal | PlanAuthoritySubmissionRefusal | PlanRevisionRefusal;

/** The exact bounded field the proposal carries: two canonical bodies and nothing else. */
export interface PlanAuthoritySubmission {
  readonly acceptanceContract: AcceptanceContract;
  readonly planRevision: PlanRevision;
}

/**
 * What the sealed event preserves for durable envelope construction. IDENTITY only: steps,
 * obligations, node ids, recipe refs and approval state are execution authority and never ride
 * along. These six are exactly the members the daemon's envelope cross-binding table reads out of
 * a proposal — revision identity, criteria digest and ref, and the graph binding.
 */
export interface PlanAuthorityIdentity {
  readonly criteriaDigest: string;
  readonly criteriaRef: string;
  readonly graphContentHash: string;
  readonly graphRevisionRef: string;
  readonly planHash: string;
  readonly revisionId: string;
}

export type PlanAuthorityAdmitResult =
  | Readonly<{ authority: PlanAuthoritySubmission; identity: PlanAuthorityIdentity; ok: true }>
  | PlanAuthorityRefusal;

/** An admitted proposal either carries an identity or is the legacy authority-less arm. */
export type PlanAuthorityCarry =
  | Readonly<{ identity?: PlanAuthorityIdentity; ok: true }>
  | Readonly<{ ok: false }>;

const AUTHORITY_KEYS = Object.freeze(["acceptanceContract", "planRevision"]);
const AUTHORITY_MEMBER = "authority";
const CARRY_ABSENT: PlanAuthorityCarry = Object.freeze({ ok: true as const });
const CARRY_REFUSED: PlanAuthorityCarry = Object.freeze({ ok: false as const });
const NO_AUTHORITY: Readonly<{ authority?: PlanAuthorityIdentity }> = Object.freeze({});

function refuse(code: PlanAuthoritySubmissionCode): PlanAuthoritySubmissionRefusal {
  return Object.freeze({ code, layer: LAYER, ok: false as const });
}

const malformed = (): PlanAuthoritySubmissionRefusal =>
  refuse("PLAN_AUTHORITY_SUBMISSION_MALFORMED");

/**
 * Descriptor-safe and exact: an accessor, a symbol key, an extra key, a missing key, an array or a
 * hostile prototype all fail here, and no getter is ever invoked. The return value is a fresh
 * null-prototype SNAPSHOT of the descriptor values, so each member is read exactly once. Proxies
 * are refused outright, mirroring `plan-revision-contract.ts`: a `getOwnPropertyDescriptor` trap
 * can report a data descriptor that the matching `get` trap then contradicts.
 */
function shellOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object" || isProxy(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  if (!exact(value, AUTHORITY_KEYS)) return undefined;
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of AUTHORITY_KEYS) {
    snapshot[key] = Object.getOwnPropertyDescriptor(value, key)?.value;
  }
  return Object.freeze(snapshot);
}

/**
 * Encode-then-decode through the published codecs: the round trip is what verifies the carried
 * digest and the canonical form, and it hands back the codec's own deeply frozen record rather
 * than the caller's object.
 */
function readRevision(value: unknown): PlanRevision | PlanRevisionRefusal {
  const encoded = encodePlanRevision(value);
  if (!encoded.ok) return encoded;
  const decoded = decodePlanRevisionBytes(encoded.bytes);
  return decoded.ok ? decoded.revision : decoded;
}

function readContract(value: unknown): AcceptanceContract | AcceptanceContractRefusal {
  const encoded = encodeAcceptanceContract(value);
  if (!encoded.ok) return encoded;
  const decoded = decodeAcceptanceContractBytes(encoded.bytes);
  return decoded.ok ? decoded.contract : decoded;
}

/**
 * Approval never arrives with the proposal. Both clauses are single-clause and separately coded,
 * so neither code can hide half a fix: a pre-approved revision and a revision already carrying a
 * rejection decision are distinct forgeries.
 */
function forgedDecision(revision: PlanRevision): PlanAuthoritySubmissionRefusal | undefined {
  if (revision.approvalState !== "PENDING_APPROVAL") {
    return refuse("PLAN_AUTHORITY_APPROVAL_FORGED");
  }
  return revision.rejectionRef === null ? undefined : refuse("PLAN_AUTHORITY_REJECTION_FORGED");
}

/**
 * JSON, not a delimiter join: a criterion id may legally contain any separator character, so
 * `["a b"]` and `["a", "b"]` collapse to the same joined string and one roster silently satisfies
 * the other. JSON escaping keeps the encoding injective.
 */
const criterionRoster = (ids: readonly string[]): string => JSON.stringify([...ids].sort());

/**
 * Every cross-binding in one fixed-order table, one exact code each. `planHash` is RECOMPUTED by
 * the caller through the published derivation, so a carried digest never decides anything: a body
 * whose own digest field disagrees has already been refused above with the CODEC's code and layer.
 */
function severedBinding(
  revision: PlanRevision, contract: AcceptanceContract, submissionHash: unknown, planHash: string,
): PlanAuthoritySubmissionRefusal | undefined {
  const checks: readonly (readonly [PlanAuthoritySubmissionCode, unknown, unknown])[] = [
    ["PLAN_AUTHORITY_SUBMISSION_HASH_MISMATCH", planHash, submissionHash],
    ["PLAN_AUTHORITY_GRAPH_REVISION_MISMATCH", revision.graphBinding.graphRevisionRef,
      contract.applicability.graphRevisionRef],
    ["PLAN_AUTHORITY_GRAPH_CONTENT_MISMATCH", revision.graphBinding.graphContentHash,
      contract.applicability.graphContentHash],
    ["PLAN_AUTHORITY_CRITERIA_BINDING_MISMATCH",
      criterionRoster(contract.obligations.map((obligation) => obligation.criterionId)),
      criterionRoster(revision.affectedCriterionIds)],
  ];
  for (const [code, left, right] of checks) if (left !== right) return refuse(code);
  return undefined;
}

export function admitPlanAuthoritySubmission(
  value: unknown, submissionHash: unknown,
): PlanAuthorityAdmitResult {
  const shell = shellOf(value);
  if (shell === undefined) return malformed();
  const planRevision = readRevision(shell["planRevision"]);
  if ("ok" in planRevision) return planRevision;
  const acceptanceContract = readContract(shell["acceptanceContract"]);
  if ("ok" in acceptanceContract) return acceptanceContract;
  const forged = forgedDecision(planRevision);
  if (forged !== undefined) return forged;
  const planDigest = derivePlanRevisionDigest(planRevision);
  if (!planDigest.ok) return planDigest;
  const criteria = deriveAcceptanceContractDigest(acceptanceContract);
  if (!criteria.ok) return criteria;
  const severed = severedBinding(planRevision, acceptanceContract, submissionHash,
    planDigest.planHash);
  if (severed !== undefined) return severed;
  return Object.freeze({
    authority: Object.freeze({ acceptanceContract, planRevision }),
    identity: Object.freeze({
      criteriaDigest: criteria.criteriaDigest, criteriaRef: acceptanceContract.contractId,
      graphContentHash: planRevision.graphBinding.graphContentHash,
      graphRevisionRef: planRevision.graphBinding.graphRevisionRef,
      planHash: planDigest.planHash, revisionId: planRevision.revisionId,
    }),
    ok: true as const,
  });
}

/**
 * Reads the optional authority member off a proposal shell. An ABSENT member is the legacy arm and
 * is admitted; an explicitly `undefined` one matches it, exactly as `effectTerminalProof` is
 * treated. An ACCESSOR member is refused rather than read as absent, or a getter would be a free
 * bypass of the whole parser.
 */
export function planAuthorityCarry(command: unknown, submissionHash: unknown): PlanAuthorityCarry {
  if (command === null || typeof command !== "object") return CARRY_ABSENT;
  const descriptor = Object.getOwnPropertyDescriptor(command, AUTHORITY_MEMBER);
  if (descriptor === undefined) return CARRY_ABSENT;
  if (!("value" in descriptor)) return CARRY_REFUSED;
  if (descriptor.value === undefined) return CARRY_ABSENT;
  const admitted = admitPlanAuthoritySubmission(descriptor.value, submissionHash);
  return admitted.ok
    ? Object.freeze({ identity: admitted.identity, ok: true as const }) : CARRY_REFUSED;
}

/** The sealed event's optional member: absent on the legacy arm, so its bytes never change. */
export function carriedAuthority(
  carry: PlanAuthorityCarry,
): Readonly<{ authority?: PlanAuthorityIdentity }> {
  return carry.ok && carry.identity !== undefined
    ? Object.freeze({ authority: carry.identity }) : NO_AUTHORITY;
}
