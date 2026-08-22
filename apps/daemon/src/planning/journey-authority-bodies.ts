import { createAcceptanceContract, createPlanRevision } from "@moe/core";
import {
  ADMISSION_PURPOSES,
  createNodeDefinition,
  deriveNodeAuthoritySet,
  encodeGraphContent,
} from "@moe/scheduler";
import type {
  GraphContent, GraphRevisionContent, GraphSnapshot, NodeDefinition,
} from "@moe/scheduler";

/**
 * The planning-authority BODIES the shipped journeys seal (task-074e6d2e), and since
 * task-c96ef2d1 the GRAPH those bodies bind to.
 *
 * ONE producer, three journeys: `bootstrap-test-fixtures.ts`'s `planningChain()`, the demo seed's
 * `demo-seed-payloads.ts`, and (through the cross-app parity pin) the control room's dev payload.
 * Nothing is hand-shaped: the leg re-derives both digests and `encodeGraphContent` RE-DERIVES
 * the node-authority set rather than adopting it.
 *
 * THE HASH IS RETURNED, NEVER ACCEPTED. `graphContentHash` used to be an INPUT and every caller
 * spelled the same fixed placeholder - a hash naming a graph that did not exist, which left the
 * propose seam's accepted-body path with no production producer at all. It is now
 * `encodeGraphContent`'s verdict over a real single-node graph and no parameter accepts one.
 * `snapshotIdentity` is the STRUCTURE-ONLY identity of that graph and is never read here: binding
 * it as content authority is dec-64b2391c's trap, which survives a name-grep because both are
 * 64-hex strings on one object.
 *
 * No clock and no random id: two builds over one input are byte-identical, as the demo seed
 * promises. This file does NOT touch the authority WRITERS. */

/** The caller ids one journey seals under. Everything else below is derived from these. */
export interface JourneyAuthorityInput {
  readonly authorRef: string;
  readonly criterionIds: readonly string[];
  readonly graphRevisionRef: string;
  /** Namespaces the contract and revision ids so two journeys never collide on one store. */
  readonly idPrefix: string;
  readonly nodeIds: readonly string[];
  readonly stepDescription: string;
}

/**
 * Every member is DERIVED, and each is re-derived by the seam that consumes it. `authority` is
 * exactly what `authorityOf` admits - TWO own keys, a third being `PLANNING_AUTHORITY_MALFORMED` -
 * which is why the graph bytes ride the propose terminal as a SIBLING of it, never inside it.
 * `graphContentBytesBase64` is canonical: the ingress re-encodes and compares before decoding,
 * refusing `PLANNING_GRAPH_CONTENT_MALFORMED` rather than normalising, because request bytes fold
 * into the decision's identity and two spellings would turn a retry into an idempotency conflict.
 * `graphContentHash` is the FULL hash over all eight `GraphRevisionContent` fields, recomputed by
 * the ingress and refused `PLANNING_GRAPH_CONTENT_HASH_MISMATCH` on disagreement. `submissionHash`
 * is READ off the minted revision: the leg refuses `PLANNING_AUTHORITY_SUBMISSION_HASH_MISMATCH`
 * unless the folded run's hash IS the plan's own `planHash`, which task-2cc6c59d also joins to
 * `exactRevisionHash`.
 */
export interface JourneyAuthority {
  readonly authority: Record<string, unknown>;
  readonly graphContentBytesBase64: string;
  readonly graphContentHash: string;
  readonly submissionHash: string;
}

const hex = (digit: string, width = 64): string => digit.repeat(width);
const issuesOf = (issues: readonly { code: string; layer: string }[]): string =>
  issues.map((issue) => `${issue.code}@${issue.layer}`).join(",");

/** The node definition's OWN planning pair binds to a DIFFERENT graph than the journey's, and
 *  cannot bind to it: the definition's bodies are hashed into the node-authority set, which is
 *  hashed into `graphContentHash`, so a definition naming that hash is an impossible digest fixed
 *  point. activation-world and graph-query separate them likewise. */
const NODE_GRAPH_HASH = hex("a");
const NODE_GRAPH_REF = "graph-revision-a";
const NODE_METER = "runner.authorized_ms";

/** A MONOTONIC contract owes a matching registry proof, else the codec refuses
 *  NODE_AUTHORITY_MONOTONIC_PROOF_MISSING @ NODE_AUTHORITY_PROOFS. */
const NODE_PREDICATE_ENTRY: Record<string, unknown> = {
  parameterSchema: { digest: hex("b"), kind: "JSON_SCHEMA" },
  predicateRef: "predicate-a",
  proofRationale: "An artifact seal cannot become unsealed.",
  schemaId: "schema-a",
  schemaVersion: 1,
  sourceOperationClass: "ARTIFACT_SEAL",
};

/** The definition's own planning pair, both minted by core and both refused loudly. */
function nodePlanning(input: JourneyAuthorityInput, nodeKey: string): Record<string, unknown> {
  const plan = createPlanRevision({
    affectedCriterionIds: ["criterion-a"],
    affectedNodeIds: [nodeKey],
    approvalState: "APPROVED",
    authorRef: input.authorRef,
    graphBinding: { graphContentHash: NODE_GRAPH_HASH, graphRevisionRef: NODE_GRAPH_REF },
    parentRevisionId: null,
    rejectionRef: null,
    revisionId: `${input.idPrefix}-node-plan`,
    steps: [{ description: "Land the node.", kind: "IMPLEMENTATION", stepId: "step-a" }],
    verificationRecipeRefs: ["recipe-a"],
  });
  if (!plan.ok) throw new Error(`journey node plan refused: ${plan.code}@${plan.layer}`);
  const accepted = createAcceptanceContract({
    applicability: {
      graphContentHash: NODE_GRAPH_HASH, graphRevisionRef: NODE_GRAPH_REF,
      nodeIds: [nodeKey], nodeKind: "LEAF",
    },
    authorRef: input.authorRef,
    contractId: `${input.idPrefix}-node-contract`,
    obligations: [{
      criterionId: "criterion-a",
      evidenceRequirements: [
        { evidenceRef: "artifact-a", kind: "ARTIFACT", requirementId: "requirement-a" }],
      statement: "The node ships its focused verification.",
      verificationRecipeRefs: ["recipe-a"],
    }],
  });
  if (!accepted.ok) {
    throw new Error(`journey node acceptance refused: ${accepted.code}@${accepted.layer}`);
  }
  return { acceptanceContract: accepted.contract, planRevision: plan.revision };
}

/** Admitted by PRODUCTION or not built at all. Edge-free by design, so the node owes no dependency
 *  contract - and `deriveNodeAuthoritySet` re-derives against the real structure, so that is a
 *  property of this snapshot, not a shortcut a widened one could inherit. */
function nodeDefinitionOf(input: JourneyAuthorityInput, nodeKey: string): NodeDefinition {
  const built = createNodeDefinition({
    ...nodePlanning(input, nodeKey),
    draft: {
      admissionAmounts: [...ADMISSION_PURPOSES].sort().map((purpose, index) => ({
        meter: NODE_METER, purpose, quantity: index + 1,
      })),
      admissionGatePolicy: "POLICY_ALLOWANCE",
      capability: "capability-implement",
      completionLinkage: nodeKey,
      constraints: ["constraint-a"],
      directHardDependencies: [],
      joinRole: "COMPLETION",
      nodeKey,
      objective: `Land ${nodeKey}.`,
      policySliceHash: hex("3"),
      readScopes: ["services/api/src"],
      repositoryBaseTree: hex("4"),
      resources: ["resource-a"],
      verificationRecipeRevisions: ["recipe-a"],
      writeScopes: ["services/api/src/node"],
    },
    predicateRegistry: [NODE_PREDICATE_ENTRY],
  });
  if (!built.ok) throw new Error(`journey node definition refused: ${issuesOf(built.issues)}`);
  return built.value.definition;
}

/** The journey's graph: ONE execution-bearing node, zero edges, keyed by the journey's own node,
 *  so two journeys naming different nodes seal different graphs rather than colliding on one
 *  content-addressed body row. */
function graphContentOf(input: JourneyAuthorityInput): GraphContent {
  const [nodeKey, ...extra] = input.nodeIds;
  // Fail CLOSED rather than silently dropping: the snapshot is single-node by design, so a caller
  // passing two would seal a plan naming both against a graph that contains one of them.
  if (nodeKey === undefined || extra.length > 0) {
    throw new Error(`a journey graph needs exactly one node id, got ${input.nodeIds.length}`);
  }
  const snapshot: GraphSnapshot = {
    completionNodeKey: nodeKey,
    edges: [],
    nodes: [{ executionBearing: true, nodeKey }],
  };
  // `authorities` is the PRODUCER'S value: `encodeGraphContent` re-derives it and refuses any
  // other, so a hand-built section could never survive the encode below.
  const definitions = [nodeDefinitionOf(input, nodeKey)];
  const derived = deriveNodeAuthoritySet(snapshot, definitions);
  if (!derived.ok) throw new Error(`journey node authority refused: ${issuesOf(derived.issues)}`);
  const content: GraphRevisionContent = {
    author: input.authorRef,
    completionNode: nodeKey,
    decompositionBudget: 24,
    nodeAuthority: { authorities: derived.value, definitions },
    parentRevision: null,
    policyRevision: "pol-000000000001",
    repositoryBaseTree: hex("4", 40),
    snapshot,
  };
  const encoded = encodeGraphContent(content);
  // Loudly, carrying the codec's own code and layer: a journey that silently produced no graph
  // presents downstream as "the seam refuses the shipped propose", one layer too late.
  if (!encoded.ok) throw new Error(`journey graph content refused: ${issuesOf(encoded.issues)}`);
  return encoded.value;
}

const graphBindingOf = (
  input: JourneyAuthorityInput, graphContentHash: string,
): Record<string, string> => ({ graphContentHash, graphRevisionRef: input.graphRevisionRef });

function planRevisionBody(input: JourneyAuthorityInput, hash: string): Record<string, unknown> {
  const built = createPlanRevision({
    affectedCriterionIds: [...input.criterionIds],
    affectedNodeIds: [...input.nodeIds],
    approvalState: "PENDING_APPROVAL",
    authorRef: input.authorRef,
    graphBinding: graphBindingOf(input, hash),
    parentRevisionId: null,
    rejectionRef: null,
    revisionId: `${input.idPrefix}-revision`,
    steps: [{ description: input.stepDescription, kind: "ANALYSIS", stepId: "step-00001" }],
    verificationRecipeRefs: [`${input.idPrefix}-recipe`],
  });
  if (!built.ok) throw new Error(`journey plan revision refused: ${built.code}@${built.layer}`);
  return built.revision as unknown as Record<string, unknown>;
}

function acceptanceContractBody(
  input: JourneyAuthorityInput, hash: string,
): Record<string, unknown> {
  const built = createAcceptanceContract({
    applicability: {
      ...graphBindingOf(input, hash), nodeIds: [...input.nodeIds], nodeKind: "LEAF",
    },
    authorRef: input.authorRef,
    contractId: `${input.idPrefix}-contract`,
    obligations: input.criterionIds.map((criterionId) => ({
      criterionId,
      evidenceRequirements: [{
        evidenceRef: `${criterionId}-evidence`, kind: "VERIFICATION_RECEIPT",
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
 * The authority member rides the PROPOSE terminal and only the propose terminal, and so do the
 * graph bytes. `planning-services.ts` returns `commitFinalizedSubmission` at :132 BEFORE
 * `buildPlanningAuthorityLeg` at :136, so a finalize never reads either - and
 * `callerSuppliedAuthorityBodies` forbids BOTH keys, so a finalize carrying one is refused
 * (`PLANNING_FINALIZE_BODIES_SUPPLIED`, `DAEMON_INGRESS`) rather than merely ignored.
 */
export function journeyAuthority(input: JourneyAuthorityInput): JourneyAuthority {
  const graph = graphContentOf(input);
  const hash = graph.graphContentHash;
  const planRevision = planRevisionBody(input, hash);
  return Object.freeze({
    authority: { acceptanceContract: acceptanceContractBody(input, hash), planRevision },
    graphContentBytesBase64: Buffer.from(graph.bytes).toString("base64"),
    graphContentHash: graph.graphContentHash,
    submissionHash: planRevision["planHash"] as string,
  });
}
