/**
 * Per-edge dependency-necessity outcomes (design 407).
 *
 * An AGENT_REPORTED "why this edge is necessary" NEVER admits a hard edge. The
 * outcomes are ADMISSIBLE (daemon-verifiable floor only), HELD for a human
 * decision, REFUSED, or DOWNGRADED to advisory. HELD is a pure RECORD: it
 * carries the pending decision reference and the would-be POLICY_SEQUENCE
 * conversion cost, and it performs NO lifecycle transition — no Blocker, no
 * PlanningHold, no recheck scheduling. A human decision is recorded; it never
 * upgrades the underlying fact's truth class (design 398).
 *
 * Positive controls are a TEST-TIME obligation (design 409): a pure pass cannot
 * run consumer oracles (design 392), so admission NEVER refuses for a missing
 * counterexample bundle. `AdmissionCounterexample` is an OPTIONAL evidence shape
 * validated here; supplying one never changes an outcome or a truth class.
 *
 * The structural counterfactual is the LANDED `analyzeHardEdgeCounterfactuals`
 * record (dependencyNecessity UNKNOWN, requiresSemanticProof, reviewOnly). It is
 * passed through, never redefined.
 */
import type { DependencyContract, DependencyTruthClass } from "../dependencies/dependency-contract.js";
import type { GraphKey } from "../graph-model.js";
import type { HardEdgeCounterfactual } from "../hard-edge-counterfactual-model.js";
import {
  deepFreeze, isDigest, isRef, makeIssue, oneOf, record, type AdmissionIssue,
} from "./admission-model.js";

export type AdmissionNecessityOutcomeCode =
  | "ADMISSION_NECESSITY_ADMISSIBLE"
  | "ADMISSION_HELD_FOR_HUMAN_DECISION"
  | "ADMISSION_NECESSITY_REFUSED"
  | "ADMISSION_NECESSITY_DOWNGRADED_ADVISORY";

/** Digest-bound fixture references, matched to one edge. Evidence shape only. */
export interface AdmissionCounterexample {
  readonly edgeKey: GraphKey;
  readonly requiredEdgeFixtureRef: string;
  readonly requiredEdgeFixtureDigest: string;
  readonly falseEdgeFixtureRef: string;
  readonly falseEdgeFixtureDigest: string;
  readonly truthClass: DependencyTruthClass;
}

/** What converting the held edge to an explicit policy ordering would cost. */
export interface AdmissionPolicySequenceConversion {
  readonly edgeKind: "POLICY_SEQUENCE";
  readonly addedStructuralStages: number;
  readonly alternateHardPathPresent: boolean;
  readonly completionClosureIntactWithoutEdge: boolean;
  readonly reviewOnly: true;
}

interface NecessityOutcomeBase {
  readonly edgeKey: GraphKey;
  /** The EFFECTIVE necessity truth class; never upgraded by any decision path. */
  readonly truthClass: DependencyTruthClass;
  readonly counterexample: AdmissionCounterexample | null;
  readonly structuralCounterfactual: HardEdgeCounterfactual;
}

export type AdmissionNecessityOutcome =
  | (NecessityOutcomeBase & { readonly kind: "ADMISSIBLE"; readonly code: "ADMISSION_NECESSITY_ADMISSIBLE" })
  | (NecessityOutcomeBase & {
    readonly kind: "HELD";
    readonly code: "ADMISSION_HELD_FOR_HUMAN_DECISION";
    readonly humanDecisionRef: string;
    readonly policySequenceConversion: AdmissionPolicySequenceConversion;
  })
  | (NecessityOutcomeBase & { readonly kind: "REFUSED"; readonly code: "ADMISSION_NECESSITY_REFUSED" })
  | (NecessityOutcomeBase & {
    readonly kind: "DOWNGRADED_ADVISORY";
    readonly code: "ADMISSION_NECESSITY_DOWNGRADED_ADVISORY";
  });

export type AdmissionNecessityResult =
  | { readonly ok: true; readonly outcome: AdmissionNecessityOutcome }
  | { readonly ok: false; readonly issues: readonly AdmissionIssue[] };

const TRUTH_CLASSES: readonly DependencyTruthClass[] =
  ["OBSERVED", "AGENT_REPORTED", "DAEMON_VERIFIED", "HUMAN_APPROVED", "UNKNOWN"];
const CLAIM_KEYS = ["edgeKey", "truthClass", "humanDecisionRef", "counterexample"] as const;
const CLAIM_REQUIRED = ["edgeKey", "truthClass"] as const;
const COUNTEREXAMPLE_KEYS = ["edgeKey", "requiredEdgeFixtureRef", "requiredEdgeFixtureDigest",
  "falseEdgeFixtureRef", "falseEdgeFixtureDigest", "truthClass"] as const;

function malformed(): AdmissionNecessityResult {
  return deepFreeze({
    ok: false,
    issues: [makeIssue("ADMISSION_NECESSITY_CLAIM_MALFORMED", "dependency necessity claim is malformed")],
  });
}

function admit(outcome: AdmissionNecessityOutcome): AdmissionNecessityResult {
  return deepFreeze({ ok: true, outcome });
}

function parseCounterexample(value: unknown, edgeKey: string): AdmissionCounterexample | null {
  const item = record(value, COUNTEREXAMPLE_KEYS);
  if (item === null || item.edgeKey !== edgeKey ||
    !isRef(item.requiredEdgeFixtureRef) || !isDigest(item.requiredEdgeFixtureDigest) ||
    !isRef(item.falseEdgeFixtureRef) || !isDigest(item.falseEdgeFixtureDigest) ||
    !oneOf(item.truthClass, TRUTH_CLASSES)) {
    return null;
  }
  return item as unknown as AdmissionCounterexample;
}

function policySequenceConversion(counterfactual: HardEdgeCounterfactual): AdmissionPolicySequenceConversion {
  return {
    edgeKind: "POLICY_SEQUENCE",
    addedStructuralStages: counterfactual.structuralStageReduction,
    alternateHardPathPresent: counterfactual.alternateHardPathPresent,
    completionClosureIntactWithoutEdge: counterfactual.completionClosureIntactWithoutEdge,
    reviewOnly: true,
  };
}

/**
 * Evaluate one agent-claimed dependency necessity against its VALIDATED contract
 * and the landed structural counterfactual for the same edge. Deterministic,
 * side-effect-free, deeply frozen; grants no readiness or mutation authority.
 */
export function evaluateNecessityClaim(
  claim: unknown,
  contract: DependencyContract,
  counterfactual: HardEdgeCounterfactual,
): AdmissionNecessityResult {
  const item = record(claim, CLAIM_KEYS, CLAIM_REQUIRED);
  if (item === null || !isRef(item.edgeKey) || !oneOf(item.truthClass, TRUTH_CLASSES)) return malformed();
  const edgeKey: string = item.edgeKey;
  const claimed: DependencyTruthClass = item.truthClass;
  const decisionRef = isRef(item.humanDecisionRef) ? item.humanDecisionRef : null;
  if (item.humanDecisionRef !== undefined && decisionRef === null) return malformed();
  const counterexample = item.counterexample === undefined ? null : parseCounterexample(item.counterexample, edgeKey);
  if (item.counterexample !== undefined && counterexample === null) return malformed();
  // Fail closed: the claim must be about the same edge the contract and the
  // structural counterfactual describe, or none of the evidence lines up.
  if (counterfactual.edgeKey !== edgeKey ||
    contract.producerNodeKey !== counterfactual.producerNodeKey ||
    contract.consumerNodeKey !== counterfactual.consumerNodeKey) {
    return malformed();
  }

  // A claim that outruns its own contract's recorded necessity truth class is
  // fail-closed to UNKNOWN rather than silently taking the higher of the two.
  const effective: DependencyTruthClass = claimed === contract.necessity.truthClass ? claimed : "UNKNOWN";
  const base: NecessityOutcomeBase = {
    edgeKey, truthClass: effective, counterexample, structuralCounterfactual: counterfactual,
  };
  if (effective === "DAEMON_VERIFIED") {
    return admit({ ...base, kind: "ADMISSIBLE", code: "ADMISSION_NECESSITY_ADMISSIBLE" });
  }
  if (effective === "AGENT_REPORTED") {
    return decisionRef === null
      ? admit({ ...base, kind: "REFUSED", code: "ADMISSION_NECESSITY_REFUSED" })
      : admit({
        ...base, kind: "HELD", code: "ADMISSION_HELD_FOR_HUMAN_DECISION",
        humanDecisionRef: decisionRef, policySequenceConversion: policySequenceConversion(counterfactual),
      });
  }
  if (effective === "OBSERVED" || effective === "HUMAN_APPROVED") {
    return admit({ ...base, kind: "DOWNGRADED_ADVISORY", code: "ADMISSION_NECESSITY_DOWNGRADED_ADVISORY" });
  }
  return admit({ ...base, kind: "REFUSED", code: "ADMISSION_NECESSITY_REFUSED" });
}
