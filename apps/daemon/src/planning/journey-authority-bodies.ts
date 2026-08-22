import { createAcceptanceContract, createPlanRevision } from "@moe/core";

/**
 * The planning-authority BODIES the shipped journeys seal (task-074e6d2e).
 *
 * ONE producer, two journeys: `bootstrap-test-fixtures.ts`'s `planningChain()` and the demo
 * seed's `demo-seed-payloads.ts` both mint through here, so the harness and the product cannot
 * drift into sealing differently-shaped authority while both stay green.
 *
 * Everything is minted by `@moe/core`'s OWN producers rather than hand-shaped, because
 * `buildPlanningAuthorityLeg` re-encodes both bodies through the published codecs and derives
 * both digests again: a hand-written body would be this module grading itself, and the daemon
 * would refuse it with the codec's code rather than seal it.
 *
 * No clock is read and no id is random. `demo-seed-payloads.ts` promises two builds over one
 * input are byte-identical, and that promise reaches through this module.
 *
 * This file does NOT touch the authority WRITERS (`planning-authority-persistence.ts`,
 * `planning-authority-finalize.ts`); it only builds the chain payload they already admit.
 */

/** The caller ids one journey seals under. Everything else below is derived from these. */
export interface JourneyAuthorityInput {
  readonly authorRef: string;
  readonly criterionIds: readonly string[];
  readonly graphContentHash: string;
  readonly graphRevisionRef: string;
  /** Namespaces the contract and revision ids so two journeys never collide on one store. */
  readonly idPrefix: string;
  readonly nodeIds: readonly string[];
  readonly stepDescription: string;
}

export interface JourneyAuthority {
  /**
   * The `authority` member exactly as `authorityOf` admits it: TWO own keys, no more and no
   * fewer. `Reflect.ownKeys(member).length !== AUTHORITY_KEYS.length` is a hard refusal
   * (`PLANNING_AUTHORITY_MALFORMED`), so a third field added here is a journey that stops
   * sealing rather than one that seals extra.
   */
  readonly authority: Record<string, unknown>;
  /**
   * READ off the minted revision, never spelled. `buildPlanningAuthorityLeg` refuses
   * `PLANNING_AUTHORITY_SUBMISSION_HASH_MISMATCH` unless the folded run's `submissionHash` IS
   * the plan body's own `planHash`, and `task-2cc6c59d` joins the same value to the approval
   * record's `exactRevisionHash`. A constant and a minted body cannot be kept in agreement by
   * hand, so the callers spell neither.
   */
  readonly submissionHash: string;
}

const graphBindingOf = (input: JourneyAuthorityInput): Record<string, string> => ({
  graphContentHash: input.graphContentHash,
  graphRevisionRef: input.graphRevisionRef,
});

function planRevisionBody(input: JourneyAuthorityInput): Record<string, unknown> {
  const built = createPlanRevision({
    affectedCriterionIds: [...input.criterionIds],
    affectedNodeIds: [...input.nodeIds],
    approvalState: "PENDING_APPROVAL",
    authorRef: input.authorRef,
    graphBinding: graphBindingOf(input),
    parentRevisionId: null,
    rejectionRef: null,
    revisionId: `${input.idPrefix}-revision`,
    steps: [{ description: input.stepDescription, kind: "ANALYSIS", stepId: "step-00001" }],
    verificationRecipeRefs: [`${input.idPrefix}-recipe`],
  });
  if (!built.ok) throw new Error(`journey plan revision refused: ${built.code}@${built.layer}`);
  return built.revision as unknown as Record<string, unknown>;
}

function acceptanceContractBody(input: JourneyAuthorityInput): Record<string, unknown> {
  const built = createAcceptanceContract({
    applicability: { ...graphBindingOf(input), nodeIds: [...input.nodeIds], nodeKind: "LEAF" },
    authorRef: input.authorRef,
    contractId: `${input.idPrefix}-contract`,
    obligations: input.criterionIds.map((criterionId) => ({
      criterionId,
      evidenceRequirements: [{
        evidenceRef: `${criterionId}-evidence`,
        kind: "VERIFICATION_RECEIPT",
        requirementId: `${criterionId}-requirement`,
      }],
      statement: `the run satisfies ${criterionId}`,
      verificationRecipeRefs: [`${criterionId}-recipe`],
    })),
  });
  if (!built.ok) throw new Error(`journey acceptance contract refused: ${built.code}@${built.layer}`);
  return built.contract as unknown as Record<string, unknown>;
}

/**
 * The member rides the PROPOSE terminal and only the propose terminal. `planning-services.ts`
 * returns `commitFinalizedSubmission` at :132 BEFORE `buildPlanningAuthorityLeg` at :136, so a
 * finalize request never reads it — and `callerSuppliedAuthorityBodies` lists `"authority"`
 * among its forbidden keys, so a finalize carrying it is refused outright
 * (`PLANNING_FINALIZE_BODIES_SUPPLIED`, `DAEMON_INGRESS`, :120-122) rather than merely ignored.
 */
export function journeyAuthority(input: JourneyAuthorityInput): JourneyAuthority {
  const planRevision = planRevisionBody(input);
  return Object.freeze({
    authority: { acceptanceContract: acceptanceContractBody(input), planRevision },
    submissionHash: planRevision["planHash"] as string,
  });
}
