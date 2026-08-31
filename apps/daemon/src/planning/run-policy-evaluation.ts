/**
 * RUN-SCOPED POLICY EVALUATION: the tier a finalized run carries, computed by the daemon from
 * the SEALED graph, never stated by anyone (design ruling comment-c86c35cb, task-a888038d).
 *
 * WHY IT IS NOT `policy.validate`. That handler takes its subject from a caller payload. A run's
 * pre-approval tier cannot come from there without becoming circular, so every input here is a
 * daemon fact read from durable state at the seal point:
 *
 *   node content        the sealed `graphContentHash` -> `readGraphBody` -> node definitions
 *   fact ids            @moe/scheduler's `deriveNodePropertyFactIds`, which RE-ADMITS each
 *                       definition through the production codec before reading a field
 *   truth class         DAEMON_VERIFIED; the derivation itself observes nothing
 *   tier                null on every fact; policy's digest-bound classifications derive it
 *   scope / refs        the sealed snapshot's node keys and the sealed content hash
 *   callerRiskHint      null, structurally: `RunPolicyEvaluationInput` has no such field
 *
 * NO DEFAULT TIER. A null core tier refuses `RUN_POLICY_UNCLASSIFIABLE`; it never becomes `R0` or
 * a caller hint. This evaluation is a leg of the sealing decision, so refusal also refuses seal.
 *
 * THE CHAIN IS THE NEWEST DIGEST-ADDRESSED evaluation slice; arbitrary policy artifacts are
 * ignored, and re-deriving its digest makes an imported or hand-written row unusable.
 */
import { isProxy } from "node:util/types";
import { evaluatePolicy } from "@moe/core";
import type { PolicyRiskTier } from "@moe/core";
import {
  ABSOLUTE_MAX_GRAPH_HARD_EDGES, ABSOLUTE_MAX_GRAPH_NODES,
  ABSOLUTE_MAX_GRAPH_TOTAL_EDGES, MIN_GATED_DESCENDANTS_FOR_REVIEW,
  admitNodeDefinition, deriveNodePropertyFactIds, encodeGraphContent,
} from "@moe/scheduler";
import type { GraphRevisionContent } from "@moe/scheduler";
import type { JsonObject } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { POLICY_EVALUATOR_VERSION } from "../bootstrap/bootstrap-policy-authority.js";
import { readGraphBody } from "./graph-body-record.js";
import {
  RUN_POLICY_ACTION,
  buildRunPolicyRow,
  runPolicyAggregateId,
  runPolicyRefusal,
} from "./run-policy-record.js";
import type { RunPolicyEvaluationRefused } from "./run-policy-record.js";
import {
  admitStableRunPolicySelection,
  captureStableRunPolicySelection,
  type StableRunPolicySelection,
  type StableRunPolicySelectionResult,
} from "./run-policy-selection-snapshot.js";

const IDENTITY_POLICY = Object.freeze({
  maxHardEdges: ABSOLUTE_MAX_GRAPH_HARD_EDGES,
  maxNodes: ABSOLUTE_MAX_GRAPH_NODES,
  maxTotalEdges: ABSOLUTE_MAX_GRAPH_TOTAL_EDGES,
  minGatedDescendantsForReview: MIN_GATED_DESCENDANTS_FOR_REVIEW,
});

export {
  captureStableRunPolicySelection,
} from "./run-policy-selection-snapshot.js";
export type {
  StableRunPolicySelection,
  StableRunPolicySelectionResult,
} from "./run-policy-selection-snapshot.js";

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

/** Derives facts only after production node-authority admission; malformed bodies never silently
 * contribute an empty fact set and fall into the wrong unclassifiable branch. */
function contentDefinitions(content: unknown): readonly unknown[] | null {
  try {
    if (content === null || typeof content !== "object" || isProxy(content)) return null;
    const authority = Reflect.getOwnPropertyDescriptor(content, "nodeAuthority");
    if (authority === undefined || !("value" in authority)
      || authority.value === null || typeof authority.value !== "object"
      || isProxy(authority.value)) return null;
    const member = Reflect.getOwnPropertyDescriptor(authority.value, "definitions");
    if (member === undefined || !("value" in member) || !Array.isArray(member.value)
      || isProxy(member.value)) return null;
    const definitions = member.value as unknown[];
    const length = Reflect.getOwnPropertyDescriptor(definitions, "length")?.value;
    if (typeof length !== "number" || !Number.isSafeInteger(length)
      || length < 1 || length > ABSOLUTE_MAX_GRAPH_NODES
      || Reflect.ownKeys(definitions).length !== length + 1) return null;
    const copy: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const item = Reflect.getOwnPropertyDescriptor(definitions, String(index));
      if (item === undefined || !item.enumerable || !("value" in item)) return null;
      copy.push(item.value);
    }
    return Object.freeze(copy);
  } catch {
    return null;
  }
}

function sealedFactsOf(content: GraphRevisionContent): SealedFacts | RunPolicyEvaluationRefused {
  const definitions = contentDefinitions(content);
  if (definitions === null) return runPolicyRefusal("RUN_POLICY_NODE_UNADMITTED");
  const factIds = new Set<string>();
  const nodeKeys = new Set<string>();
  for (const value of definitions) {
    const admitted = admitNodeDefinition(value);
    if (!admitted.ok) return runPolicyRefusal("RUN_POLICY_NODE_UNADMITTED");
    const definition = admitted.value.definition;
    const derived = deriveNodePropertyFactIds(definition);
    if (!derived.ok) return runPolicyRefusal("RUN_POLICY_NODE_UNADMITTED");
    for (const factId of derived.factIds) factIds.add(factId);
    nodeKeys.add(definition.nodeKey);
  }
  return { factIds: sorted(factIds), nodeKeys: sorted(nodeKeys) };
}

/**
 * The evaluation input core sees, assembled from server facts only. `decisionDigest` is a
 * placeholder core hands straight back; the record writer removes it before digesting.
 */
function evaluationInputFor(
  input: RunPolicyEvaluationInput, facts: SealedFacts, selected: StableRunPolicySelection,
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
export function evaluateRunPolicyContent(
  content: GraphRevisionContent,
  selected: StableRunPolicySelectionResult,
  input: RunPolicyEvaluationInput,
): RunPolicyEvaluationResult {
  const facts = sealedFactsOf(content);
  if ("ok" in facts) return facts;
  const admittedContent = encodeGraphContent(content, IDENTITY_POLICY);
  if (!admittedContent.ok || admittedContent.value.graphContentHash !== input.graphContentHash) {
    return runPolicyRefusal("RUN_POLICY_INPUT_INVALID");
  }
  try {
    if (!selected.ok) return runPolicyRefusal(
      selected.reason === "ABSENT" ? "RUN_POLICY_POLICY_ABSENT" : "RUN_POLICY_INPUT_INVALID",
      facts.factIds,
    );
    const selection = admitStableRunPolicySelection(selected.selection, input.projectId);
    if (selection === null) return runPolicyRefusal("RUN_POLICY_INPUT_INVALID", facts.factIds);
    const evaluationInput = evaluationInputFor(input, facts, selection);
    const evaluated = evaluatePolicy(evaluationInput);
    if (!evaluated.ok) return runPolicyRefusal("RUN_POLICY_INPUT_INVALID", facts.factIds);
    const computedTier = evaluated.record.riskAssessment.computedTier;
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
        sliceRef: selection.sliceRef,
      }),
    });
  } catch {
    return runPolicyRefusal("RUN_POLICY_INPUT_INVALID", facts.factIds);
  }
}

export function evaluateRunPolicy(
  store: SqliteEventStore,
  ledger: DurableLedger,
  input: RunPolicyEvaluationInput,
): RunPolicyEvaluationResult {
  const body = readGraphBody(store, input.projectId, input.graphContentHash);
  if (!body.ok) return runPolicyRefusal("RUN_POLICY_GRAPH_UNAVAILABLE");
  const selected = captureStableRunPolicySelection(store, ledger, input.projectId);
  return evaluateRunPolicyContent(body.content, selected, input);
}
