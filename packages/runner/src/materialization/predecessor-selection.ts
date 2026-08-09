import { canonicalJson, isCommitIdentity } from "../canonical.js";
import { oneOf } from "../supervisor/effect-shape.js";
import {
  MAX_SELECTED_INPUTS,
  QUALIFYING_MILESTONES,
  materializationFailure,
  milestoneRank,
  type MaterializationFailure,
  type QualifyingMilestone,
} from "./materialization-kernel.js";
import {
  parseClosure,
  type ParsedArtifact,
  type ParsedCandidate,
} from "./predecessor-candidate-parse.js";

/**
 * Which accepted predecessor results this node consumes, and in what order.
 *
 * Design line 380 fixes the rule exactly: graph base first, then transitive
 * accepted predecessor results in topological then stable-`nodeKey` order, each
 * artifact identity exactly once. Order is part of the contract, not a
 * presentation detail — a consumer delta is relative to the resulting tree, so
 * two orderings of the same closure are two different trees.
 *
 * Pure over a caller-supplied closure: no filesystem, no Git, no clock. This
 * module decides WHAT is selected; materializing a scratch worktree is a
 * different task.
 */
export interface SelectedInput {
  readonly artifactIdentity: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly producerNodeKey: string;
  readonly producerResultRef: string;
  readonly producerAttemptRef: string;
  readonly producerEpoch: number;
  readonly producerAdoptionRef: string;
}

export interface PredecessorSelection {
  readonly baseIdentity: string;
  readonly requiredMilestone: QualifyingMilestone;
  readonly entries: readonly SelectedInput[];
}

export interface SelectPredecessorInputsInput {
  readonly baseIdentity: unknown;
  readonly requiredMilestone: unknown;
  readonly candidates: unknown;
}

export type PredecessorSelectionResult =
  | { readonly ok: true; readonly selection: PredecessorSelection }
  | MaterializationFailure;

/**
 * One producer record collapses to one canonical string. Two records that agree
 * on every field are the same predecessor reached twice and dedupe; anything
 * else at the same key is a genuine conflict and refuses. The two outcomes are
 * kept apart deliberately — collapsing them would let a real producer conflict
 * pass as a harmless duplicate.
 */
function producerBinding(candidate: ParsedCandidate): string {
  return canonicalJson({
    nodeKey: candidate.nodeKey,
    topologicalIndex: candidate.topologicalIndex,
    resultRef: candidate.resultRef,
    attemptRef: candidate.attemptRef,
    epoch: candidate.epoch,
    adoptionRef: candidate.adoptionRef,
    milestone: candidate.milestone,
    artifacts: candidate.artifacts,
  });
}

function ambiguous(detail: string): MaterializationFailure {
  return materializationFailure(
    "RUNNER_MATERIALIZATION_PRODUCER_AMBIGUOUS",
    "SELECTION",
    "two disagreeing producers claim the same identity",
    detail,
  );
}

function toEntry(candidate: ParsedCandidate, artifact: ParsedArtifact): SelectedInput {
  return Object.freeze({
    artifactIdentity: artifact.artifactIdentity,
    sha256: artifact.sha256,
    byteLength: artifact.byteLength,
    producerNodeKey: candidate.nodeKey,
    producerResultRef: candidate.resultRef,
    producerAttemptRef: candidate.attemptRef,
    producerEpoch: candidate.epoch,
    producerAdoptionRef: candidate.adoptionRef,
  });
}

export function selectPredecessorInputs(
  input: SelectPredecessorInputsInput,
): PredecessorSelectionResult {
  if (!isCommitIdentity(input.baseIdentity)) {
    return materializationFailure(
      "RUNNER_MATERIALIZATION_BASE_INVALID",
      "SELECTION",
      "graph base must be a 40- or 64-hex commit",
    );
  }
  if (!oneOf(input.requiredMilestone, QUALIFYING_MILESTONES)) {
    return materializationFailure(
      "RUNNER_MATERIALIZATION_CLOSURE_MALFORMED",
      "SELECTION",
      "required qualifying milestone is not a known milestone",
    );
  }
  const candidates = parseClosure(input.candidates);
  if ("ok" in candidates) return candidates;
  const required = milestoneRank(input.requiredMilestone);
  const producers = new Map<string, string>();
  const entries: SelectedInput[] = [];
  const claimed = new Set<string>();
  for (const candidate of candidates) {
    if (milestoneRank(candidate.milestone) < required) {
      return materializationFailure(
        "RUNNER_MATERIALIZATION_MILESTONE_UNQUALIFIED",
        "SELECTION",
        "predecessor result is not qualified at the required milestone",
        candidate.nodeKey,
      );
    }
    const binding = producerBinding(candidate);
    const known = producers.get(candidate.nodeKey);
    if (known !== undefined) {
      if (known !== binding) return ambiguous(candidate.nodeKey);
      continue;
    }
    producers.set(candidate.nodeKey, binding);
    for (const artifact of candidate.artifacts) {
      // An identical producer already `continue`d above, so a collision here is
      // always a genuine disagreement rather than the same result reached twice.
      if (claimed.has(artifact.artifactIdentity)) return ambiguous(artifact.artifactIdentity);
      claimed.add(artifact.artifactIdentity);
      entries.push(toEntry(candidate, artifact));
    }
  }
  if (entries.length > MAX_SELECTED_INPUTS) {
    return materializationFailure(
      "RUNNER_MATERIALIZATION_SELECTION_LIMIT",
      "SELECTION",
      "selected input closure exceeds its ceiling",
    );
  }
  return Object.freeze({
    ok: true as const,
    selection: Object.freeze({
      baseIdentity: input.baseIdentity,
      requiredMilestone: input.requiredMilestone,
      entries: Object.freeze(entries),
    }),
  });
}
