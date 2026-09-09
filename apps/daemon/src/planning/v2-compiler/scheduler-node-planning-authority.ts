import {
  decodeAcceptanceCriteriaContentBytes, decodePlanExecutionContentBytes,
  encodeAcceptanceCriteriaContent, encodePlanExecutionContent,
  type AcceptanceCriteriaContent, type PlanExecutionContent,
} from "@moe/core";
import {
  createNodeDefinitionFromPlanningContent, type NodeDefinition,
} from "@moe/scheduler";

import type {
  V2CompilerNodeAuthorityRequest, V2CompilerNodePlanningAuthorityReader,
} from "./authority-contracts.js";
import { exact, snapshotCompilerInput } from "./snapshot.js";

const SOURCE_KEYS = Object.freeze([
  "acceptanceCriterionContent", "directHardDependencies", "planExecutionContent",
  "predicateRegistry",
]);
const DECLARED_MIGRATIONS_KEY = "declaredMigrations";
/**
 * A SECOND admissible roster, never a fifth name on the first one. `exact` is
 * own-key COUNT equality plus every-key-present (snapshot.ts:70-74), so appending
 * the name would make the declaration MANDATORY and refuse every authored source
 * already in the store. Widening `exact` itself is worse: it guards boundaries all
 * over this package and loosening it would relax checks that have nothing to do
 * with migrations.
 */
const DECLARING_SOURCE_KEYS = Object.freeze([...SOURCE_KEYS, DECLARED_MIGRATIONS_KEY]);
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const same = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const sameRoster = (left: readonly string[], right: readonly string[]): boolean =>
  same([...left].sort(compare), [...right].sort(compare));
const sameAmounts = (left: NodeDefinition["admissionAmounts"],
  right: NodeDefinition["admissionAmounts"]): boolean => left.length === right.length
  && left.every((value, index) => value.meter === right[index]?.meter
    && value.purpose === right[index]?.purpose && value.quantity === right[index]?.quantity);

function acceptanceMatchesProduct(content: AcceptanceCriteriaContent,
  request: V2CompilerNodeAuthorityRequest): boolean {
  const expected = new Map(request.criterionBindings.map((binding) => [binding.criterionId, binding]));
  if (expected.size !== request.criterionBindings.length
    || content.obligations.length !== expected.size) return false;
  const requirementIds = new Set(request.contractRequirementIds);
  const recipeRefs = new Set(request.verificationRecipeRevisions);
  const seen = new Set<string>();
  for (const obligation of content.obligations) {
    const binding = expected.get(obligation.criterionId);
    if (binding === undefined || binding.statement !== obligation.statement
      || obligation.evidenceRequirements.some(
        ({ requirementId }) => !requirementIds.has(requirementId))
      || !obligation.evidenceRequirements.some(
        ({ requirementId }) => requirementId === binding.requirementId)
      || obligation.verificationRecipeRefs.some((ref) => !recipeRefs.has(ref))) return false;
    seen.add(obligation.criterionId);
  }
  return seen.size === expected.size;
}

function planMatchesNode(content: PlanExecutionContent,
  request: V2CompilerNodeAuthorityRequest): boolean {
  return sameRoster(content.affectedCriterionIds,
    request.criterionBindings.map(({ criterionId }) => criterionId))
    && same(content.affectedNodeIds, [request.nodeKey])
    && sameRoster(content.verificationRecipeRefs, request.verificationRecipeRevisions);
}

function matchesRequest(definition: NodeDefinition,
  request: V2CompilerNodeAuthorityRequest): boolean {
  const expectedCriteria = request.criterionBindings.map((item) => item.criterionId).sort(compare);
  const expectedEdges = request.directHardDependencies.map((item) => item.edgeKey).sort(compare);
  return sameAmounts(definition.admissionAmounts, request.admissionAmounts)
    && definition.admissionGatePolicy === request.admissionGatePolicy
    && definition.nodeKey === request.nodeKey && definition.capability === request.capability
    && definition.repositoryBaseTree === request.repositoryBaseTree
    && definition.objective === request.objective
    && definition.policySliceHash === request.policySliceHash
    && definition.joinRole === request.joinRole
    && definition.completionLinkage === request.completionLinkage
    && same(definition.constraints, request.constraints)
    && same(definition.readScopes, request.readScopes)
    && same(definition.writeScopes, request.writeScopes)
    && same(definition.resources, request.resources)
    && same(definition.verificationRecipeRevisions, request.verificationRecipeRevisions)
    && same(definition.criterionBindings.map((item) => item.criterionId), expectedCriteria)
    && same(definition.directHardDependencies.map((item) => item.edgeKey), expectedEdges);
}

/** Strictly admits source-owned bodies, then composes every other field from compiler authority. */
export function readNodePlanningDefinition(reader: V2CompilerNodePlanningAuthorityReader,
  request: V2CompilerNodeAuthorityRequest): NodeDefinition | undefined {
  let value: unknown;
  try { value = reader(request); } catch { return undefined; }
  const snapshot = snapshotCompilerInput(value);
  if (!snapshot.ok) return undefined;
  // A SOURCE THAT NAMES THE MEMBER MUST STATE ONE, and the guard for that is already
  // upstream: `snapshotCompilerInput` visits every own value and FAILS on one that is
  // `undefined` (snapshot.ts:21 — `undefined` is neither a primitive it accepts nor
  // `typeof "object"`). So a five-key source carrying an assigned `undefined` never
  // reaches this roster check at all. A local re-check here would be dead code; the
  // arm that pins the behaviour names the snapshot as the refuser rather than a
  // second guard, so a later change to snapshot.ts reds the arm instead of hiding
  // behind a redundant one.
  if (!exact(snapshot.value, SOURCE_KEYS) && !exact(snapshot.value, DECLARING_SOURCE_KEYS)) {
    return undefined;
  }
  const planBytes = encodePlanExecutionContent(snapshot.value["planExecutionContent"]);
  const acceptanceBytes = encodeAcceptanceCriteriaContent(
    snapshot.value["acceptanceCriterionContent"],
  );
  if (!planBytes.ok || !acceptanceBytes.ok) return undefined;
  const plan = decodePlanExecutionContentBytes(planBytes.bytes);
  const acceptance = decodeAcceptanceCriteriaContentBytes(acceptanceBytes.bytes);
  if (!plan.ok || !acceptance.ok) return undefined;
  if (!planMatchesNode(plan.content, request)) return undefined;
  const completionContent = acceptance.content.nodeKind === "COMPOSITE_COMPLETION";
  if ((request.joinRole === "COMPLETION") !== completionContent) return undefined;
  if (!acceptanceMatchesProduct(acceptance.content, request)) return undefined;
  const created = createNodeDefinitionFromPlanningContent({
    acceptanceCriterionContent: acceptance.content,
    draft: {
      admissionAmounts: request.admissionAmounts,
      admissionGatePolicy: request.admissionGatePolicy,
      capability: request.capability,
      completionLinkage: request.completionLinkage,
      constraints: request.constraints,
      // THE MEMBER RIDES THE SOURCE, NOT THE REQUEST, and that is measured rather
      // than a preference: `authority-contracts.ts:73` already calls
      // `V2CompilerNodePlanningAuthority` "source-owned planning/dependency
      // material", `directHardDependencies` rides the source for exactly this
      // reason, and a declaration is stated by the node's AUTHOR — there is no
      // compiler-side fact that could supply one. Moving it onto
      // `V2CompilerNodeAuthorityRequest` would drag the product contract, `NodeFact`
      // and `V2CompiledNode` in behind it for a value none of them own.
      //
      // Spread, never an assigned `undefined`: the draft is written field by field,
      // so an unassigned member is dropped silently, and an assigned `undefined` is
      // still an own key that `readDraftFields` and the codec's byte comparison read
      // differently from an absent one.
      ...(snapshot.value[DECLARED_MIGRATIONS_KEY] === undefined
        ? {} : { declaredMigrations: snapshot.value[DECLARED_MIGRATIONS_KEY] }),
      directHardDependencies: snapshot.value["directHardDependencies"],
      joinRole: request.joinRole,
      nodeKey: request.nodeKey,
      objective: request.objective,
      policySliceHash: request.policySliceHash,
      readScopes: request.readScopes,
      repositoryBaseTree: request.repositoryBaseTree,
      resources: request.resources,
      verificationRecipeRevisions: request.verificationRecipeRevisions,
      writeScopes: request.writeScopes,
    },
    planExecutionContent: plan.content,
    predicateRegistry: snapshot.value["predicateRegistry"],
  });
  return created.ok && matchesRequest(created.value.definition, request)
    ? created.value.definition : undefined;
}
