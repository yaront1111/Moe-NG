/**
 * Composition of the two foreign authorities the node authority body depends on:
 * @moe/core's graph-independent planning identities, and this package's own
 * dependency-contract validator.
 *
 * COMPOSES, NEVER REIMPLEMENTS. Both authorities keep their own stable codes,
 * which travel out under a layer naming the authority that answered, so a caller
 * can tell a validator's verdict from this slice's own.
 *
 * THE ONE THING THIS SLICE DECIDES ABOUT DEPENDENCIES. The validator SILENTLY
 * DEMOTES a `MONOTONIC` contract with no matching registry proof to `REVOCABLE`
 * and emits no code at all. A durable execution contract must not acquire a
 * weakened stability class that way, so a caller-stated `MONOTONIC` arriving back
 * as `REVOCABLE` is refused here. The proof the validator matched is persisted, so
 * a later re-read needs no external registry and cannot lose it silently.
 *
 * Split from the codec only to keep each production source inside the per-file
 * line cap.
 */
import {
  decodeAcceptanceContractBytes, decodePlanRevisionBytes, deriveAcceptanceCriterionContent,
  derivePlanExecutionContent, encodeAcceptanceContract, encodePlanRevision,
} from "@moe/core";

import { validateDependencyContract } from "../dependencies/dependency-contract.js";
import {
  hasOnlyOwnStringKeys, isPlainArray, isPlainRecord, readOwnDataProperty,
} from "../runtime-shape.js";
import {
  NODE_AUTHORITY_LIMITS, NODE_AUTHORITY_SCHEMA_VERSION, canonicalText, compareStrings,
  deepFreeze, ok, passthrough, refuse,
} from "./node-authority-contract.js";
import { readText } from "./node-authority-fields.js";
import type { MonotonicPredicateRegistryEntry } from "../dependencies/dependency-contract.js";
import type {
  NodeAuthorityDraft, NodeAuthorityRefusal, NodeCriterionBinding, NodeDefinition,
  NodeDependencyEntry, Read,
} from "./node-authority-contract.js";

const PROOF_KEYS: readonly string[] = ["parameterSchema", "predicateRef", "proofRationale",
  "schemaId", "schemaVersion", "sourceOperationClass"];
const HEX_64 = /^[0-9a-f]{64}$/u;

export interface DerivedIdentity {
  readonly criteria: readonly NodeCriterionBinding[];
  readonly planExecutionContentDigest: string;
}
export interface AdmittedPlanning extends DerivedIdentity {
  readonly criterionIds: readonly string[];
  readonly nodeIds: readonly string[];
  readonly recipeRefs: readonly string[];
}
export interface ComposedEdges {
  readonly entries: readonly NodeDependencyEntry[];
  readonly proofs: readonly MonotonicPredicateRegistryEntry[];
}

export const pick = (record: Record<string, unknown>, key: string): unknown => {
  const property = readOwnDataProperty(record, key);
  return property.ok && property.present ? property.value : undefined;
};

const proofMissing = (): NodeAuthorityRefusal => refuse(
  "NODE_AUTHORITY_MONOTONIC_PROOF_MISSING", "NODE_AUTHORITY_PROOFS",
  "a monotonic direct-hard entry has no exact matching predicate-registry proof");

/** Round-trips both records through their OWN production codecs, so a malformed
 * or digest-inconsistent planning record is refused by core, with core's code. */
export function admitPlanning(plan: unknown, contract: unknown): Read<AdmittedPlanning> {
  const planBytes = encodePlanRevision(plan);
  if (!planBytes.ok) return passthrough("PLANNING_SOURCE", [planBytes]);
  const revision = decodePlanRevisionBytes(planBytes.bytes);
  if (!revision.ok) return passthrough("PLANNING_SOURCE", [revision]);
  const contractBytes = encodeAcceptanceContract(contract);
  if (!contractBytes.ok) return passthrough("PLANNING_SOURCE", [contractBytes]);
  const accepted = decodeAcceptanceContractBytes(contractBytes.bytes);
  if (!accepted.ok) return passthrough("PLANNING_SOURCE", [accepted]);
  const execution = derivePlanExecutionContent(revision.revision);
  if (!execution.ok) return passthrough("PLANNING_SOURCE", [execution]);
  const criteria = deriveAcceptanceCriterionContent(accepted.contract);
  if (!criteria.ok) return passthrough("PLANNING_SOURCE", [criteria]);
  if (criteria.criteria.length > NODE_AUTHORITY_LIMITS.maxCriterionBindings) {
    return refuse("NODE_AUTHORITY_LIMIT_EXCEEDED", "NODE_AUTHORITY_LIMITS",
      "criterion bindings exceed their bound");
  }
  return ok({
    criteria: criteria.criteria,
    criterionIds: revision.revision.affectedCriterionIds,
    nodeIds: accepted.contract.applicability.nodeIds,
    planExecutionContentDigest: execution.digest,
    recipeRefs: revision.revision.verificationRecipeRefs,
  });
}

/** Node, criterion and recipe applicability, in that order, under one code. */
export function applicable(
  draft: NodeAuthorityDraft, planning: AdmittedPlanning,
): NodeAuthorityRefusal | null {
  const mismatch = (what: string): NodeAuthorityRefusal => refuse(
    "NODE_AUTHORITY_APPLICABILITY_MISMATCH", "NODE_AUTHORITY_ADMISSION",
    `${what} is not applicable under the supplied planning records`);
  if (!planning.nodeIds.includes(draft.nodeKey)) return mismatch("the node");
  if (!planning.criteria.every((entry) => planning.criterionIds.includes(entry.criterionId))) {
    return mismatch("a criterion");
  }
  return draft.verificationRecipeRevisions.every((ref) => planning.recipeRefs.includes(ref))
    ? null : mismatch("a verification recipe");
}

/** The stability the CALLER stated, read from the same data property the
 * validator read, so a demotion can be told apart from an honest `REVOCABLE`. */
function statedStability(requirement: unknown): string | null {
  if (!isPlainRecord(requirement)) return null;
  const contract = pick(requirement, "contract");
  if (!isPlainRecord(contract)) return null;
  const stability = pick(contract, "stability");
  return typeof stability === "string" ? stability : null;
}

/** Projects the registry entry the validator matched. Bounds here are strictly
 * tighter than the validator's, so an over-long rationale refuses at this layer. */
function matchProof(
  registry: unknown, entry: NodeDependencyEntry,
): Read<MonotonicPredicateRegistryEntry> {
  const predicate = entry.contract.satisfactionPredicate;
  for (const candidate of isPlainArray(registry) ? registry : []) {
    if (!isPlainRecord(candidate)) continue;
    const read = new Map<string, unknown>();
    for (const key of PROOF_KEYS) read.set(key, pick(candidate, key));
    if (read.get("predicateRef") !== predicate.predicateRef
      || read.get("schemaId") !== predicate.schemaId
      || read.get("schemaVersion") !== predicate.schemaVersion) continue;
    const schema = read.get("parameterSchema");
    const rationale = readText(
      read.get("proofRationale"), NODE_AUTHORITY_LIMITS.maxRationaleBytes, "proofRationale");
    if (!rationale.ok) return rationale;
    if (!isPlainRecord(schema)) return proofMissing();
    return ok(deepFreeze({
      parameterSchema: { digest: pick(schema, "digest"), kind: pick(schema, "kind") },
      predicateRef: predicate.predicateRef, proofRationale: rationale.value,
      schemaId: predicate.schemaId, schemaVersion: predicate.schemaVersion,
      sourceOperationClass: read.get("sourceOperationClass"),
    }) as MonotonicPredicateRegistryEntry);
  }
  return proofMissing();
}

/**
 * One code path for creation and for re-admission: at creation the registry is
 * the caller's, at re-admission it is the body's own persisted proofs, so a body
 * that lost a proof demotes inside the validator and is caught by the same guard.
 */
export function composeEdges(draft: NodeAuthorityDraft, registry: unknown): Read<ComposedEdges> {
  const entries: NodeDependencyEntry[] = [];
  const proofs: MonotonicPredicateRegistryEntry[] = [];
  for (const edge of draft.directHardDependencies) {
    const validated = validateDependencyContract(edge.requirement, registry);
    if (!validated.ok) return passthrough("DEPENDENCY_CONTRACT", validated.issues);
    if (validated.graphEdgeKind !== "HARD") {
      return refuse("NODE_AUTHORITY_FIELD_INVALID", "NODE_AUTHORITY_DEPENDENCIES",
        "a direct-hard entry resolved to an advisory relation");
    }
    if (statedStability(edge.requirement) === "MONOTONIC"
      && validated.contract.stability !== "MONOTONIC") return proofMissing();
    const entry: NodeDependencyEntry = { contract: validated.contract, edgeKey: edge.edgeKey };
    entries.push(entry);
    if (validated.contract.stability !== "MONOTONIC") continue;
    const proof = matchProof(registry, entry);
    if (!proof.ok) return proof;
    const canonical = canonicalText(proof.value);
    if (!proofs.some((held) => canonicalText(held) === canonical)) proofs.push(proof.value);
  }
  if (proofs.length > NODE_AUTHORITY_LIMITS.maxProofEntries) {
    return refuse("NODE_AUTHORITY_LIMIT_EXCEEDED", "NODE_AUTHORITY_LIMITS",
      "monotonic proofs exceed their bound");
  }
  proofs.sort((left, right) => compareStrings(canonicalText(left), canonicalText(right)));
  return ok({ entries: Object.freeze(entries), proofs: Object.freeze(proofs) });
}

/** Rebuilds the requirement the validator originally ruled on, descriptor-safely. */
export function requirementsOf(value: unknown): unknown {
  if (!isPlainArray(value)) return value;
  return value.map((entry) => {
    if (!isPlainRecord(entry)) return entry;
    const contract = pick(entry, "contract");
    return {
      edgeKey: pick(entry, "edgeKey"),
      requirement: isPlainRecord(contract)
        ? { contract, edgeKind: pick(contract, "edgeKind") } : { contract },
    };
  });
}

/** The derived fields of an already-built body are read back, never re-derived:
 * there is no planning record here to derive them from. */
export function readDerived(value: Record<string, unknown>): Read<DerivedIdentity> {
  const digest = pick(value, "planExecutionContentDigest");
  const bindings = pick(value, "criterionBindings");
  const invalid = (): NodeAuthorityRefusal => refuse(
    "NODE_AUTHORITY_FIELD_INVALID", "NODE_AUTHORITY_ADMISSION",
    "a derived field is absent or malformed");
  if (typeof digest !== "string" || !HEX_64.test(digest) || !isPlainArray(bindings)
    || bindings.length > NODE_AUTHORITY_LIMITS.maxCriterionBindings) return invalid();
  const criteria: NodeCriterionBinding[] = [];
  for (const entry of bindings) {
    if (!isPlainRecord(entry) || !hasOnlyOwnStringKeys(entry, ["contentDigest", "criterionId"])) {
      return invalid();
    }
    const contentDigest = pick(entry, "contentDigest");
    const criterionId = pick(entry, "criterionId");
    if (typeof contentDigest !== "string" || !HEX_64.test(contentDigest)
      || typeof criterionId !== "string" || criterionId.length === 0) return invalid();
    criteria.push(Object.freeze({ contentDigest, criterionId }));
  }
  return ok({ criteria: Object.freeze(criteria), planExecutionContentDigest: digest });
}

/** Assembled in declared key order so `Object.keys` is stable for any reader. */
export function project(
  draft: NodeAuthorityDraft, identity: DerivedIdentity, edges: ComposedEdges,
): NodeDefinition {
  return deepFreeze<NodeDefinition>({
    budgetRequest: draft.budgetRequest, capability: draft.capability,
    completionLinkage: draft.completionLinkage, constraints: draft.constraints,
    criterionBindings: identity.criteria, directHardDependencies: edges.entries,
    joinRole: draft.joinRole, monotonicPredicateProofs: edges.proofs, nodeKey: draft.nodeKey,
    objective: draft.objective,
    planExecutionContentDigest: identity.planExecutionContentDigest,
    policySliceHash: draft.policySliceHash, readScopes: draft.readScopes,
    repositoryBaseTree: draft.repositoryBaseTree, resources: draft.resources,
    schemaVersion: NODE_AUTHORITY_SCHEMA_VERSION,
    verificationRecipeRevisions: draft.verificationRecipeRevisions,
    writeScopes: draft.writeScopes,
  });
}
