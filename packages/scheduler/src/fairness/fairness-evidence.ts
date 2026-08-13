/**
 * Production scheduler fairness contracts — the OPPORTUNITY-EVIDENCE family.
 * The cap-revision family lives in ./fairness-cap-revision.ts; the two were
 * split so each source stays inside the per-file line target.
 *
 * This family closes the reference's central defect BY CONSTRUCTION.
 * packages/testkit/src/scheduler-fairness/fairness-codec.ts decodes a caller's
 * `bypassesInLevel` (line 71) and validates only its RANGE (lines 83-84):
 * nothing proves the caller earned those bypasses, and a range check is not a
 * proof. Here a bypass is a CLAIM THAT CARRIES ITS EVIDENCE, and the proven
 * count is COUNTED FROM the attestations — never read off the claim. A claim the
 * caller cannot prove is refused, not admitted.
 *
 * Counting evidence is not a decision: nothing here compares the count against a
 * promotion threshold, and BYPASSES_PER_LEVEL is neither imported nor referenced.
 * Promotion and aging belong to the consumer, task-10cab3e5.
 */
import { exactRecord, isCount } from "../authority/authority-kernel.js";
import {
  acceptFairness,
  isFairnessIdentity,
  isFairnessRefusal,
  makeFairnessIssue,
  readFairnessItems,
  refuseFairness,
  unknownFairness,
} from "./fairness-contract.js";
import type {
  FairnessContractIssueCode,
  FairnessContractRefusal,
  FairnessContractResult,
} from "./fairness-contract.js";

/**
 * One attested compatible dispatch in which the claimant was passed over.
 * `observationRef` is the evidence; null is representable and yields UNKNOWN
 * naming the missing input rather than an optimistic admission.
 */
export interface FairnessOpportunityAttestation {
  readonly opportunityRef: string;
  readonly winnerWorkItemId: string;
  readonly observationRef: string | null;
}

/** A bypass claim and the attestations that must prove it. */
export interface FairnessBypassClaim {
  readonly workItemId: string;
  readonly claimedBypasses: number;
  readonly attestations: readonly FairnessOpportunityAttestation[];
}

/** What the evidence proves. `provenBypasses` is counted, never copied. */
export interface FairnessProvenBypasses {
  readonly workItemId: string;
  readonly provenBypasses: number;
  readonly opportunityRefs: readonly string[];
}

const ATTESTATION_KEYS =
  Object.freeze(["opportunityRef", "winnerWorkItemId", "observationRef"] as const);
const CLAIM_KEYS = Object.freeze(["workItemId", "claimedBypasses", "attestations"] as const);

function evidenceRefusal(
  code: FairnessContractIssueCode,
  message: string,
  subjects: readonly string[] = [],
): FairnessContractRefusal {
  return refuseFairness(
    makeFairnessIssue(code, "OPPORTUNITY_EVIDENCE", message, null, subjects),
  );
}

/**
 * The shape rules ONE attestation obeys wherever it appears, and nothing else.
 *
 * `field` names the position for the UNKNOWN's missingInput, because the same
 * three keys are read from inside a bypass claim's array and from a standalone
 * selection attestation, and an UNKNOWN that cannot say WHICH input is missing
 * is a silent pass. The self-attestation rule is deliberately NOT here: it is a
 * BYPASS rule ("a work item cannot be bypassed by itself") and applying it to a
 * SELECTION attestation would refuse exactly the winner a selection names.
 */
function parseAttestation(
  value: unknown,
  field: string,
): FairnessOpportunityAttestation | FairnessContractRefusal {
  const parsed = exactRecord(value, ATTESTATION_KEYS);
  if (parsed === null) {
    return evidenceRefusal(
      "FAIRNESS_CONTRACT_MALFORMED_INPUT", "an attestation is not an attestation record",
    );
  }
  const opportunityRef = parsed["opportunityRef"];
  const winnerWorkItemId = parsed["winnerWorkItemId"];
  if (!isFairnessIdentity(opportunityRef)) {
    return evidenceRefusal(
      "FAIRNESS_CONTRACT_INVALID_IDENTITY", "opportunityRef is not a safe fairness identity",
    );
  }
  if (!isFairnessIdentity(winnerWorkItemId)) {
    return evidenceRefusal(
      "FAIRNESS_CONTRACT_INVALID_IDENTITY", "winnerWorkItemId is not a safe fairness identity",
      [opportunityRef],
    );
  }
  const observationRef = parsed["observationRef"];
  if (observationRef === null) {
    return unknownFairness(
      "FAIRNESS_CONTRACT_OPPORTUNITY_UNOBSERVED", "OPPORTUNITY_EVIDENCE",
      `${field}.observationRef`, [opportunityRef],
    );
  }
  if (!isFairnessIdentity(observationRef)) {
    return evidenceRefusal(
      "FAIRNESS_CONTRACT_INVALID_IDENTITY", "observationRef is not a safe fairness identity",
      [opportunityRef],
    );
  }
  return { opportunityRef, winnerWorkItemId, observationRef };
}

/**
 * Total validator for ONE attested opportunity, for a consumer that must name
 * the opportunity a work item was SELECTED in rather than passed over in.
 *
 * It returns the validated attestation and nothing else: no truth marker, no
 * verdict, no derived identity. An opportunity is never inferred from a work
 * item id — that is precisely the synthesis this validator exists to replace.
 */
export function validateOpportunityAttestation(
  value: unknown,
): FairnessContractResult<FairnessOpportunityAttestation> {
  const parsed = parseAttestation(value, "attestation");
  return isFairnessRefusal(parsed) ? parsed : acceptFairness({ ...parsed });
}

function readAttestation(
  value: unknown,
  index: number,
  claimant: string,
): FairnessOpportunityAttestation | FairnessContractRefusal {
  const parsed = parseAttestation(value, `attestations[${index}]`);
  if (isFairnessRefusal(parsed)) return parsed;
  if (parsed.winnerWorkItemId === claimant) {
    return evidenceRefusal(
      "FAIRNESS_CONTRACT_BYPASS_SELF_ATTESTED", "a work item cannot be bypassed by itself",
      [claimant, parsed.opportunityRef],
    );
  }
  return parsed;
}

/**
 * Total validator. Returns what the EVIDENCE proves; the claimed number is only
 * ever compared against that count, never trusted as its source. A claim with no
 * attestations at all is refused before the comparison so "you brought nothing"
 * and "you brought the wrong amount" stay distinguishable.
 */
export function validateBypassClaim(
  value: unknown,
): FairnessContractResult<FairnessProvenBypasses> {
  const parsed = exactRecord(value, CLAIM_KEYS);
  if (parsed === null) {
    return evidenceRefusal(
      "FAIRNESS_CONTRACT_MALFORMED_INPUT", "input is not a bypass claim record",
    );
  }
  const workItemId = parsed["workItemId"];
  if (!isFairnessIdentity(workItemId)) {
    return evidenceRefusal(
      "FAIRNESS_CONTRACT_INVALID_IDENTITY", "workItemId is not a safe fairness identity",
    );
  }
  const claimedBypasses = parsed["claimedBypasses"];
  if (!isCount(claimedBypasses)) {
    return evidenceRefusal(
      "FAIRNESS_CONTRACT_INVALID_COUNTER", "claimedBypasses is not a non-negative safe integer",
      [workItemId],
    );
  }
  const items = readFairnessItems(parsed["attestations"], "OPPORTUNITY_EVIDENCE", "attestations");
  if (isFairnessRefusal(items)) return items;
  const opportunityRefs: string[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of items.entries()) {
    const attestation = readAttestation(raw, index, workItemId);
    if (isFairnessRefusal(attestation)) return attestation;
    if (seen.has(attestation.opportunityRef)) {
      return evidenceRefusal(
        "FAIRNESS_CONTRACT_DUPLICATE_IDENTITY", "an opportunity is attested twice",
        [workItemId, attestation.opportunityRef],
      );
    }
    seen.add(attestation.opportunityRef);
    opportunityRefs.push(attestation.opportunityRef);
  }
  if (opportunityRefs.length === 0 && claimedBypasses > 0) {
    return evidenceRefusal(
      "FAIRNESS_CONTRACT_BYPASS_EVIDENCE_MISSING", "a bypass claim arrived with no attestation",
      [workItemId],
    );
  }
  if (opportunityRefs.length !== claimedBypasses) {
    return evidenceRefusal(
      "FAIRNESS_CONTRACT_BYPASS_COUNT_UNPROVEN", "claimedBypasses is not the attested count",
      [workItemId],
    );
  }
  return acceptFairness({ workItemId, provenBypasses: opportunityRefs.length, opportunityRefs });
}
