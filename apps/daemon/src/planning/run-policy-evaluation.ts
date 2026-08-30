/**
 * RUN-SCOPED POLICY EVALUATION: the tier a finalized run carries, computed by the daemon from
 * the SEALED graph, never stated by anyone (design ruling comment-c86c35cb, task-a888038d).
 *
 * WHY IT IS NOT `policy.validate`. That handler (bootstrap-policy-services.ts:163-183) takes
 * `graphNodeRevisionRefs`, `scope`, `action`, `callerRiskHint` and `requiredFactIds` from the
 * CALLER's payload and resolves its one fact from an activation-written record. A run's
 * pre-approval tier cannot come from there without becoming circular, so every input below is
 * read out of durable state the daemon already holds at the seal point:
 *
 *   node content        the sealed `graphContentHash` -> `readGraphBody` -> node definitions
 *   fact ids            @moe/scheduler's `deriveNodePropertyFactIds`, which RE-ADMITS each
 *                       definition through the production codec before reading a field
 *   truth class         DAEMON_VERIFIED, stamped HERE and only here: task-cb0d65ff deliberately
 *                       withheld it from the derivation, which observes nothing
 *   tier                NOT stamped at all. Every fact enters with `tier: null`; the tier comes
 *                       from the installed slice's `riskClassifications`, which is policy DATA
 *                       covered by the slice digest, and core's `assessRisk` folds it
 *   scope / refs        the sealed snapshot's node keys and the sealed content hash
 *   callerRiskHint      null, structurally: `RunPolicyEvaluationInput` has no such field
 *
 * NO DEFAULT TIER, ANYWHERE. When core answers `computedTier: null` this module refuses
 * `RUN_POLICY_UNCLASSIFIABLE` and returns no record. It never substitutes `R0`, never falls back
 * to a caller hint, and never lets an absent classification table read as "classifies nothing, so
 * lowest risk". That is the ruling's condition 3, and it is why the finalize seam composes this
 * as a LEG of the sealing decision rather than as a second command: refusing here refuses the
 * seal, so no run can be finalized without a tier.
 *
 * THE CHAIN IS THE NEWEST INSTALLED EVALUATION SLICE. `policy.install` stores arbitrary policy
 * artifacts (reviewer calibration, verifier inputs) alongside core evaluation slices, and only a
 * core slice can be digested, so "evaluation slice" means exactly `derivePolicySliceDigest(...).ok`.
 * The digest is RE-DERIVED and must equal the address the row was installed under: the install
 * ingress already enforces that for the commands it sees, which is precisely why re-deriving here
 * is not a restatement — it is what makes an imported or hand-written row unusable.
 */
import { derivePolicySliceDigest, evaluatePolicy } from "@moe/core";
import type { PolicyRiskTier } from "@moe/core";
import { deriveNodePropertyFactIds } from "@moe/scheduler";
import type { JsonObject, JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { stateOf } from "../bootstrap/bootstrap-ledger.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { POLICY_EVALUATOR_VERSION } from "../bootstrap/bootstrap-policy-authority.js";
import { installedSlices } from "../bootstrap/bootstrap-policy-services.js";
import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";
import { readGraphBody } from "./graph-body-record.js";
import {
  RUN_POLICY_ACTION,
  buildRunPolicyRow,
  runPolicyAggregateId,
  runPolicyRefusal,
} from "./run-policy-record.js";
import type { RunPolicyEvaluationRefused } from "./run-policy-record.js";

export {
  RUN_POLICY_ACTION,
  RUN_POLICY_EVALUATION_CODES,
  RUN_POLICY_EVENT_TYPE,
  RUN_POLICY_ROW_EXTRA_KEYS,
  runPolicyAggregateId,
} from "./run-policy-record.js";
export type {
  RunPolicyEvaluationCode,
  RunPolicyEvaluationRefused,
  RunPolicyLayer,
} from "./run-policy-record.js";

/**
 * Every input is a SERVER FACT. There is deliberately no `facts`, `tier`, `callerRiskHint`,
 * `scope` or `graphNodeRevisionRefs` member: a caller cannot influence the evaluation because
 * there is no shape in which one could arrive. `graphContentHash` comes from the folded run's
 * `sealedHashes`, which only core's finalize reducer writes.
 */
export interface RunPolicyEvaluationInput {
  readonly decidedAt: string;
  readonly graphContentHash: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly runId: string;
}

export interface RunPolicyEvaluationAccepted {
  readonly aggregateId: string;
  readonly computedTier: PolicyRiskTier;
  readonly ok: true;
  readonly payload: JsonObject;
}

export type RunPolicyEvaluationResult =
  | RunPolicyEvaluationAccepted
  | RunPolicyEvaluationRefused;

interface SealedFacts {
  readonly factIds: readonly string[];
  readonly nodeKeys: readonly string[];
}

const sorted = (values: Iterable<string>): readonly string[] =>
  Object.freeze([...values].sort((left, right) => left < right ? -1 : 1));

/**
 * The run's node-property fact ids and node keys, both DERIVED from the sealed body.
 *
 * `deriveNodePropertyFactIds` re-admits each definition through the production node-authority
 * codec, so a body that decoded but states a malformed definition is refused here rather than
 * silently contributing no facts — which would read downstream as "this run classifies nothing"
 * and take the unclassifiable branch for the wrong reason.
 */
function sealedFactsOf(
  store: SqliteEventStore, projectId: string, graphContentHash: string,
): SealedFacts | RunPolicyEvaluationRefused {
  const body = readGraphBody(store, projectId, graphContentHash);
  if (!body.ok) return runPolicyRefusal("RUN_POLICY_GRAPH_UNAVAILABLE");
  const factIds = new Set<string>();
  const nodeKeys = new Set<string>();
  for (const definition of body.content.nodeAuthority.definitions) {
    const derived = deriveNodePropertyFactIds(definition);
    if (!derived.ok) return runPolicyRefusal("RUN_POLICY_NODE_UNADMITTED");
    for (const factId of derived.factIds) factIds.add(factId);
    nodeKeys.add(definition.nodeKey);
  }
  return { factIds: sorted(factIds), nodeKeys: sorted(nodeKeys) };
}

interface SelectedSlice {
  readonly slice: JsonValue;
  readonly sliceRef: string;
}

/**
 * The newest installed slice core can evaluate, re-digested and re-addressed.
 *
 * "Newest" is INSERTION ORDER over the installed map, which is sound here for a reason worth
 * stating: `installPolicy` refuses to reinstall a core evaluation slice at an address it already
 * holds, so a core slice is inserted exactly once and never moves. Non-core artifacts (reviewer
 * calibration, verifier inputs) may be overwritten and would keep their original position, but
 * they never pass the digest check below, so their position cannot matter.
 */
function selectInstalledSlice(ledger: DurableLedger, projectId: string): SelectedSlice | null {
  const installed = installedSlices(stateOf(ledger, policyAggregateId(projectId)));
  let selected: SelectedSlice | null = null;
  for (const [sliceRef, slice] of Object.entries(installed)) {
    const digest = derivePolicySliceDigest(slice);
    if (!digest.ok || digest.digest !== sliceRef) continue;
    selected = { slice, sliceRef };
  }
  return selected;
}

/**
 * The evaluation input core sees, assembled from server facts only. `decisionDigest` is a
 * placeholder core hands straight back; the record writer removes it before digesting.
 */
function evaluationInputFor(
  input: RunPolicyEvaluationInput, facts: SealedFacts, selected: SelectedSlice,
): Record<string, unknown> {
  return {
    action: RUN_POLICY_ACTION,
    actor: input.principalId,
    callerRiskHint: null,
    decisionDigest: "0".repeat(64),
    evaluatedAtEpochMs: Date.parse(input.decidedAt),
    evaluatorVersion: POLICY_EVALUATOR_VERSION,
    facts: facts.factIds.map((factId) => ({
      factId, tier: null, truthClass: "DAEMON_VERIFIED" as const,
    })),
    graphNodeRevisionRefs: [input.graphContentHash],
    policyRevisionRef: selected.sliceRef,
    requiredFactIds: [],
    scope: [...facts.nodeKeys],
    sliceChain: [selected.slice],
    waivers: [],
  };
}

/**
 * Evaluates one finalized run's policy risk, or refuses.
 *
 * Nothing is written here. The caller composes the returned payload as a leg of the SAME decision
 * that seals the submission, so the seal and the evaluation land together or neither does.
 */
export function evaluateRunPolicy(
  store: SqliteEventStore,
  ledger: DurableLedger,
  input: RunPolicyEvaluationInput,
): RunPolicyEvaluationResult {
  const facts = sealedFactsOf(store, input.projectId, input.graphContentHash);
  if ("ok" in facts) return facts;
  const selected = selectInstalledSlice(ledger, input.projectId);
  if (selected === null) return runPolicyRefusal("RUN_POLICY_POLICY_ABSENT", facts.factIds);
  const evaluationInput = evaluationInputFor(input, facts, selected);
  const evaluated = evaluatePolicy(evaluationInput);
  if (!evaluated.ok) return runPolicyRefusal("RUN_POLICY_INPUT_INVALID", facts.factIds);
  const computedTier = evaluated.record.riskAssessment.computedTier;
  // THE FAIL-CLOSED BRANCH. `null` is not a tier and never becomes one: no default, no hint, no
  // "lowest by convention". A run whose properties the installed policy does not classify is
  // refused, and the seal it would have ridden is refused with it.
  if (computedTier === null) {
    return runPolicyRefusal("RUN_POLICY_UNCLASSIFIABLE", facts.factIds);
  }
  return Object.freeze({
    aggregateId: runPolicyAggregateId(input.runId),
    computedTier,
    ok: true as const,
    payload: buildRunPolicyRow({
      evaluationInput,
      graphContentHash: input.graphContentHash,
      principalId: input.principalId,
      projectId: input.projectId,
      record: evaluated.record as unknown as Readonly<Record<string, unknown>>,
      runId: input.runId,
      sliceRef: selected.sliceRef,
    }),
  });
}
