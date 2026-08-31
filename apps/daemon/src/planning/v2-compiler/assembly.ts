import type { ProductContractV2Budget } from "@moe/core";

import type {
  V2CompiledCriterionBinding, V2CompiledDag, V2CompiledMaterialDigest, V2CompiledNode,
} from "./contracts.js";
import type { AdmittedResolution } from "./resolution.js";
import type { NodeFact } from "./topology.js";
import { materialIdentity } from "./material-identity.js";

export interface PreparedDag {
  readonly criteria: readonly V2CompiledCriterionBinding[];
  readonly materialDigests: readonly V2CompiledMaterialDigest[];
  readonly nodes: readonly V2CompiledNode[];
  readonly qualificationFences: V2CompiledDag["qualificationFences"];
}

function qualificationFences(facts: readonly AdmittedResolution[]):
V2CompiledDag["qualificationFences"] {
  const rows = new Map<string, V2CompiledDag["qualificationFences"][number]>();
  for (const fact of facts) {
    const key = `${fact.deliveryProfileQualificationId}\0${fact.deliveryProfileQualificationDigest}`
      + `\0${fact.deliveryProfileQualificationStatusRef}`
      + `\0${fact.deliveryProfileQualificationStatusDigest}`;
    rows.set(key, Object.freeze({
      qualificationDigest: fact.deliveryProfileQualificationDigest,
      qualificationId: fact.deliveryProfileQualificationId,
      statusDigest: fact.deliveryProfileQualificationStatusDigest,
      statusRef: fact.deliveryProfileQualificationStatusRef,
    }));
  }
  return Object.freeze([...rows.values()].sort((left, right) => compareCodeUnits(
    `${left.qualificationId}\0${left.qualificationDigest}\0${left.statusRef}\0${left.statusDigest}`,
    `${right.qualificationId}\0${right.qualificationDigest}\0${right.statusRef}\0${right.statusDigest}`,
  )));
}

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function collectedMaterialRows(facts: readonly AdmittedResolution[]): readonly V2CompiledMaterialDigest[] {
  const rows: V2CompiledMaterialDigest[] = [];
  const add = (kind: V2CompiledMaterialDigest["kind"], ref: string, digest: string): void => {
    rows.push(Object.freeze({ digest, kind, ref }));
  };
  for (const fact of facts) {
    add("CAPABILITY_CATALOG", materialIdentity("CAPABILITY_CATALOG", [
      fact.catalogId, fact.catalogRevisionId, fact.catalogRevisionDigest,
    ]), fact.catalogRevisionDigest);
    add("DELIVERY_PROFILE", materialIdentity("DELIVERY_PROFILE", [
      fact.deliveryProfileId, fact.deliveryProfileRevisionId, fact.deliveryProfileRevisionDigest,
    ]),
      fact.deliveryProfileRevisionDigest);
    add("DELIVERY_PROFILE_QUALIFICATION", materialIdentity("DELIVERY_PROFILE_QUALIFICATION", [
      fact.deliveryProfileQualificationId, fact.deliveryProfileQualificationDigest,
    ]),
      fact.deliveryProfileQualificationDigest);
    add("DELIVERY_PROFILE_QUALIFICATION_STATUS",
      materialIdentity("DELIVERY_PROFILE_QUALIFICATION_STATUS", [
        fact.deliveryProfileQualificationStatusRef,
        fact.deliveryProfileQualificationStatusDigest,
      ]),
      fact.deliveryProfileQualificationStatusDigest);
    add("BUILD_RECIPE", materialIdentity("BUILD_RECIPE", [
      fact.buildRecipe.recipeRef, fact.buildRecipe.recipeDigest, fact.buildRecipe.toolRef,
    ]), fact.buildRecipe.recipeDigest);
    for (const binding of [fact.builder, ...fact.verifiers]) {
      add("EXECUTION_ISOLATION_PROFILE", materialIdentity("EXECUTION_ISOLATION_PROFILE", [
        binding.capabilityId, binding.executionIsolationProfileRevisionId,
        binding.executionIsolationProfileRevisionDigest,
      ]),
        binding.executionIsolationProfileRevisionDigest);
      add("SOURCE_SNAPSHOT", materialIdentity("SOURCE_SNAPSHOT", [
        binding.capabilityId, binding.executionIsolationProfileRevisionId,
        binding.sourceSnapshotDigest,
      ]),
        binding.sourceSnapshotDigest);
      for (const recipe of binding.verificationRecipes) add(
        "VERIFICATION_RECIPE", materialIdentity("VERIFICATION_RECIPE", [
          recipe.recipeId, recipe.revisionId, recipe.revisionDigest,
        ]), recipe.revisionDigest,
      );
    }
  }
  return rows;
}

export function materialBindingsConflict(facts: readonly AdmittedResolution[]): boolean {
  const digests = new Map<string, string>();
  for (const row of collectedMaterialRows(facts)) {
    const key = `${row.kind}\0${row.ref}`; const previous = digests.get(key);
    if (previous !== undefined && previous !== row.digest) return true;
    digests.set(key, row.digest);
  }
  return false;
}

function materialRows(facts: readonly AdmittedResolution[]): readonly V2CompiledMaterialDigest[] {
  const unique = new Map<string, V2CompiledMaterialDigest>();
  for (const row of collectedMaterialRows(facts)) unique.set(`${row.kind}\0${row.ref}`, row);
  return Object.freeze([...unique.values()].sort((left, right) =>
    compareCodeUnits(`${left.kind}\0${left.ref}`, `${right.kind}\0${right.ref}`)));
}

export function assemblePreparedDag(
  admitted: readonly NodeFact[],
  budgets: ReadonlyMap<string, ProductContractV2Budget>,
  criteria: readonly V2CompiledCriterionBinding[],
  usedFacts: readonly AdmittedResolution[],
): PreparedDag {
  const nodes: V2CompiledNode[] = admitted.map((node) => Object.freeze({
    authorityKind: node.authorityKind,
    budgetBindings: Object.freeze(node.budgetIds.map((id) => Object.freeze({ ...budgets.get(id)! }))
      .sort((left, right) => compareCodeUnits(left.budgetId, right.budgetId))),
    buildRecipe: node.authorityKind === "BUILDER" ? node.resolution.buildRecipe : null,
    capabilityId: node.capabilityId,
    criterionRefs: Object.freeze([...node.criterionIds].sort()
      .map((criterionId) => Object.freeze({ criterionId }))),
    dependsOn: Object.freeze([...node.dependencyIds].sort()
      .map((nodeId) => Object.freeze({ nodeId }))),
    materialBinding: Object.freeze({
      catalogRevisionDigest: node.resolution.catalogRevisionDigest,
      deliveryProfileQualificationDigest: node.resolution.deliveryProfileQualificationDigest,
      deliveryProfileQualificationStatusDigest:
        node.resolution.deliveryProfileQualificationStatusDigest,
      deliveryProfileRevisionDigest: node.resolution.deliveryProfileRevisionDigest,
      executionIsolationProfileRevisionDigest:
        node.capabilityBinding.executionIsolationProfileRevisionDigest,
      sourceSnapshotDigest: node.capabilityBinding.sourceSnapshotDigest,
    }),
    nodeId: node.nodeId,
    verificationRecipes: node.capabilityBinding.verificationRecipes,
  })).sort((left, right) => compareCodeUnits(left.nodeId, right.nodeId));
  return Object.freeze({
    criteria: Object.freeze([...criteria].sort(
      (left, right) => compareCodeUnits(left.criterionId, right.criterionId))),
    materialDigests: materialRows(usedFacts),
    nodes: Object.freeze(nodes),
    qualificationFences: qualificationFences(usedFacts),
  });
}
