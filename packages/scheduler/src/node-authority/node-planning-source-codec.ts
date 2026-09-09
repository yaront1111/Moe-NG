import {
  decodeAcceptanceCriteriaContentBytes,
  decodePlanExecutionContentBytes,
  encodeAcceptanceCriteriaContent,
  encodePlanExecutionContent,
} from "@moe/core";

import { isGraphKey } from "../graph-key.js";
import {
  hasExactDenseArrayShape, hasOnlyOwnStringKeys, isPlainArray, isPlainRecord,
  readOwnDataProperty, readPlainArrayLength,
} from "../runtime-shape.js";
import {
  NODE_AUTHORITY_LIMITS, deepFreeze,
} from "./node-authority-contract.js";
import { composePlanningEdges } from "./node-authority-compose.js";
import { measureNodePlanningDependencyContent } from "./node-planning-source-bounds.js";
import {
  NODE_PLANNING_SOURCE_DECLARED_MIGRATIONS_KEY as DECLARED_MIGRATIONS_KEY,
  NODE_PLANNING_SOURCE_SCHEMA_VERSION,
  NODE_PLANNING_SOURCE_UNDECLARED_SCHEMA_VERSION,
  nodePlanningSourceVersionOf,
  nodePlanningSourceWireOf,
  own,
  readNodePlanningSourceWire,
  readSourceDeclaredMigrations,
  refuse,
  sameNodePlanningSourceBytes,
  type NodePlanningSourceBytesResult,
  type NodePlanningSourceContent,
  type NodePlanningSourceDependency,
  type NodePlanningSourceIssueCode,
  type NodePlanningSourceLayer,
  type NodePlanningSourceRefusal,
  type NodePlanningSourceResult,
} from "./node-planning-source-format.js";

export {
  NODE_PLANNING_SOURCE_CODES,
  NODE_PLANNING_SOURCE_DIGEST_DOMAIN,
  NODE_PLANNING_SOURCE_SCHEMA_VERSION,
  NODE_PLANNING_SOURCE_UNDECLARED_SCHEMA_VERSION,
} from "./node-planning-source-format.js";
export type {
  NodePlanningSourceBytesResult,
  NodePlanningSourceCode,
  NodePlanningSourceContent,
  NodePlanningSourceDependency,
  NodePlanningSourceIssue,
  NodePlanningSourceIssueCode,
  NodePlanningSourceLayer,
  NodePlanningSourceResult,
} from "./node-planning-source-format.js";

const DRAFT_KEYS = Object.freeze([
  "acceptanceCriterionContent", "directHardDependencies", "planExecutionContent",
  "predicateRegistry",
]);
const CONTENT_KEYS = Object.freeze([...DRAFT_KEYS, "version"]);
/**
 * A SECOND roster, not a widened one. `hasOnlyOwnStringKeys` plus every-key-present
 * makes every member of a roster REQUIRED, so appending the declaration to the one
 * roster would refuse every source already in the store. Accepting EITHER roster is
 * what makes the member optional without loosening the exactness of either.
 */
const DECLARING_DRAFT_KEYS = Object.freeze([...DRAFT_KEYS, DECLARED_MIGRATIONS_KEY]);
const DECLARING_CONTENT_KEYS = Object.freeze([...CONTENT_KEYS, DECLARED_MIGRATIONS_KEY]);

function forward(
  issues: readonly Readonly<{
    readonly code: NodePlanningSourceIssueCode;
    readonly layer: string;
    readonly message?: string;
  }>[],
  layer: NodePlanningSourceLayer,
): NodePlanningSourceRefusal {
  return Object.freeze({
    issues: Object.freeze(issues.map((issue) => Object.freeze({
      code: issue.code,
      layer,
      message: issue.message === undefined
        ? `${issue.code}@${issue.layer}`
        : `${issue.code}@${issue.layer}: ${issue.message}`,
    }))),
    ok: false as const,
  });
}
const same = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const sorted = (values: readonly string[]): readonly string[] => [...values].sort(
  (left, right) => left < right ? -1 : left > right ? 1 : 0,
);

function admit(value: unknown, allowDraft: boolean): NodePlanningSourceResult {
  if (!isPlainRecord(value)) {
    return refuse("NODE_PLANNING_SOURCE_MALFORMED", "NODE_PLANNING_SOURCE_ADMISSION",
      "planning source is not a plain record");
  }
  const migrations = readOwnDataProperty(value, DECLARED_MIGRATIONS_KEY);
  if (!migrations.ok) {
    return refuse("NODE_PLANNING_SOURCE_MALFORMED", "NODE_PLANNING_SOURCE_ADMISSION",
      "declaredMigrations is not a data property");
  }
  // AN ASSIGNED `undefined` IS REFUSED HERE, and that differs from the layer below
  // on purpose. `readDraftFields` treats it as absent because its decode path states
  // every roster key, so a body that never declared arrives present-and-undefined.
  // Nothing on THIS layer's decode path does that — the wire reader spreads the
  // member conditionally — so an assigned `undefined` can only come from a caller
  // who meant to state something, and silently minting a version-1 source from it
  // would answer a declaration they believed they made with a source that has none.
  if (migrations.present && migrations.value === undefined) {
    return refuse("NODE_PLANNING_SOURCE_MALFORMED", "NODE_PLANNING_SOURCE_ADMISSION",
      "declaredMigrations is stated as undefined");
  }
  const declares = migrations.present;
  const contentKeys = declares ? DECLARING_CONTENT_KEYS : CONTENT_KEYS;
  const draftKeys = declares ? DECLARING_DRAFT_KEYS : DRAFT_KEYS;
  const full = hasOnlyOwnStringKeys(value, contentKeys)
    && contentKeys.every((key) => own(value, key) !== undefined);
  const draft = hasOnlyOwnStringKeys(value, draftKeys)
    && draftKeys.every((key) => own(value, key) !== undefined);
  if (!full && (!allowDraft || !draft)) {
    return refuse("NODE_PLANNING_SOURCE_MALFORMED", "NODE_PLANNING_SOURCE_ADMISSION",
      "planning source is not an exact source record");
  }
  const declared = declares ? readSourceDeclaredMigrations(migrations.value) : undefined;
  if (declared !== undefined && !declared.ok) return declared;
  // The version a caller STATES must equal the one its CONTENT implies. Unsupported
  // and mismatched are different facts and get different codes: 3 is a version this
  // module cannot read at all, while a stated 2 over a declaration-free source is a
  // version it can read and the content contradicts.
  const version = nodePlanningSourceVersionOf(declared?.value);
  if (full) {
    const stated = own(value, "version");
    if (stated !== NODE_PLANNING_SOURCE_UNDECLARED_SCHEMA_VERSION
      && stated !== NODE_PLANNING_SOURCE_SCHEMA_VERSION) {
      return refuse("NODE_PLANNING_SOURCE_UNSUPPORTED_SCHEMA", "NODE_PLANNING_SOURCE_SCHEMA",
        "planning source version is unsupported");
    }
    if (stated !== version) {
      return refuse("NODE_PLANNING_SOURCE_SCHEMA_MISMATCH", "NODE_PLANNING_SOURCE_SCHEMA",
        "planning source states a version its content does not imply");
    }
  }
  const planEncoded = encodePlanExecutionContent(own(value, "planExecutionContent"));
  if (!planEncoded.ok) return forward([planEncoded], "PLAN_EXECUTION_CONTENT");
  const plan = decodePlanExecutionContentBytes(planEncoded.bytes);
  if (!plan.ok) return forward([plan], "PLAN_EXECUTION_CONTENT");
  const acceptanceEncoded = encodeAcceptanceCriteriaContent(
    own(value, "acceptanceCriterionContent"),
  );
  if (!acceptanceEncoded.ok) {
    return forward([acceptanceEncoded], "ACCEPTANCE_CRITERIA_CONTENT");
  }
  const acceptance = decodeAcceptanceCriteriaContentBytes(acceptanceEncoded.bytes);
  if (!acceptance.ok) return forward([acceptance], "ACCEPTANCE_CRITERIA_CONTENT");
  if (plan.content.affectedNodeIds.length !== 1 || !isGraphKey(plan.content.affectedNodeIds[0])) {
    return refuse("NODE_PLANNING_SOURCE_NODE_ROSTER_INVALID", "NODE_PLANNING_SOURCE_ADMISSION",
      "planning source must affect exactly one canonical node");
  }
  const criterionIds = acceptance.content.obligations.map(({ criterionId }) => criterionId);
  if (!same(sorted(plan.content.affectedCriterionIds), sorted(criterionIds))) {
    return refuse("NODE_PLANNING_SOURCE_CRITERIA_MISMATCH", "NODE_PLANNING_SOURCE_ADMISSION",
      "plan and acceptance criterion rosters differ");
  }
  const acceptanceRecipes = [...new Set(acceptance.content.obligations.flatMap(
    ({ verificationRecipeRefs }) => verificationRecipeRefs,
  ))];
  if (!same(sorted(plan.content.verificationRecipeRefs), sorted(acceptanceRecipes))) {
    return refuse("NODE_PLANNING_SOURCE_RECIPE_MISMATCH", "NODE_PLANNING_SOURCE_ADMISSION",
      "plan and acceptance verification recipe rosters differ");
  }
  const registry = own(value, "predicateRegistry");
  if (!isPlainArray(registry)) {
    return refuse("NODE_PLANNING_SOURCE_MALFORMED", "NODE_PLANNING_SOURCE_ADMISSION",
      "predicate registry is not a plain list");
  }
  const registryLength = readPlainArrayLength(registry);
  if (registryLength === null) {
    return refuse("NODE_PLANNING_SOURCE_MALFORMED", "NODE_PLANNING_SOURCE_ADMISSION",
      "predicate registry has no admissible length");
  }
  if (registryLength > NODE_AUTHORITY_LIMITS.maxProofEntries) {
    return refuse("NODE_PLANNING_SOURCE_LIMIT_EXCEEDED", "NODE_PLANNING_SOURCE_LIMITS",
      "predicate registry exceeds its bound");
  }
  if (!hasExactDenseArrayShape(registry, registryLength)) {
    return refuse("NODE_PLANNING_SOURCE_MALFORMED", "NODE_PLANNING_SOURCE_ADMISSION",
      "predicate registry is not a dense data-property list");
  }
  const directHardDependenciesValue = own(value, "directHardDependencies");
  if (measureNodePlanningDependencyContent(
    directHardDependenciesValue, registry,
  ) === "EXCEEDED") {
    return refuse("NODE_PLANNING_SOURCE_LIMIT_EXCEEDED", "NODE_PLANNING_SOURCE_LIMITS",
      "planning source dependency content exceeds its byte ceiling");
  }
  const composed = composePlanningEdges(directHardDependenciesValue, registry);
  if (!composed.ok) return forward(composed.issues, "NODE_AUTHORITY");
  const affectedNodeId = plan.content.affectedNodeIds[0];
  if (composed.value.entries.some(({ contract }) =>
    contract.consumerNodeKey !== affectedNodeId)) {
    return refuse(
      "NODE_PLANNING_SOURCE_DEPENDENCY_CONSUMER_MISMATCH",
      "NODE_PLANNING_SOURCE_DEPENDENCIES",
      "a direct-hard dependency is addressed to a different consumer node",
    );
  }
  const acceptedCriteria = new Set(criterionIds);
  if (composed.value.entries.some(({ contract }) =>
    !acceptedCriteria.has(contract.consumer.criterionRef)
    || !acceptedCriteria.has(contract.necessity.failedConsumerCriterionRef))) {
    return refuse(
      "NODE_PLANNING_SOURCE_DEPENDENCY_CRITERIA_MISMATCH",
      "NODE_PLANNING_SOURCE_DEPENDENCIES",
      "a dependency cites a criterion outside the source acceptance roster",
    );
  }
  if (registryLength !== composed.value.proofs.length) {
    return refuse("NODE_PLANNING_SOURCE_PROOF_ROSTER_INVALID", "NODE_PLANNING_SOURCE_PROOFS",
      "predicate registry contains an unused or unbound proof");
  }
  const directHardDependencies = composed.value.entries.map(({ contract, edgeKey }) =>
    deepFreeze<NodePlanningSourceDependency>({
      edgeKey, requirement: { contract, edgeKind: contract.edgeKind },
    }));
  const content = deepFreeze<NodePlanningSourceContent>({
    acceptanceCriterionContent: acceptance.content,
    // Spread, never an assigned `undefined`, and placed so a source that declares
    // nothing keeps the exact five-key shape and order it has always had.
    ...(declared === undefined ? {} : { declaredMigrations: declared.value }),
    directHardDependencies: Object.freeze(directHardDependencies),
    planExecutionContent: plan.content,
    predicateRegistry: composed.value.proofs,
    version,
  });
  const wire = nodePlanningSourceWireOf(content);
  if (wire === undefined) {
    return refuse("NODE_PLANNING_SOURCE_MALFORMED", "NODE_PLANNING_SOURCE_CODEC",
      "planning source cannot be canonically encoded");
  }
  if (wire.bytes.length > NODE_AUTHORITY_LIMITS.maxBytes) {
    return refuse("NODE_PLANNING_SOURCE_LIMIT_EXCEEDED", "NODE_PLANNING_SOURCE_LIMITS",
      "planning source exceeds its byte ceiling");
  }
  return Object.freeze({ content, ok: true as const, sourceDigest: wire.sourceDigest });
}

export function createNodePlanningSourceContent(value: unknown): NodePlanningSourceResult {
  return admit(value, true);
}

export function encodeNodePlanningSourceContent(value: unknown): NodePlanningSourceBytesResult {
  const admitted = admit(value, false);
  if (!admitted.ok) return admitted;
  const wire = nodePlanningSourceWireOf(admitted.content);
  return wire === undefined
    ? refuse("NODE_PLANNING_SOURCE_MALFORMED", "NODE_PLANNING_SOURCE_CODEC",
      "planning source cannot be canonically encoded")
    : Object.freeze({ bytes: new Uint8Array(wire.bytes), ok: true as const });
}

export function decodeNodePlanningSourceContentBytes(value: unknown): NodePlanningSourceResult {
  const decoded = readNodePlanningSourceWire(value);
  if (!decoded.ok) return decoded;
  const plan = decodePlanExecutionContentBytes(decoded.planBytes);
  if (!plan.ok) return forward([plan], "PLAN_EXECUTION_CONTENT");
  const acceptance = decodeAcceptanceCriteriaContentBytes(decoded.acceptanceBytes);
  if (!acceptance.ok) return forward([acceptance], "ACCEPTANCE_CRITERIA_CONTENT");
  const admitted = admit({
    acceptanceCriterionContent: acceptance.content,
    // The wire reader spreads the member only when the envelope stated one, so an
    // absent declaration reconstructs as an ABSENT key rather than an assigned
    // `undefined` — which `admit` refuses and the canonical re-encode would notice.
    ...(DECLARED_MIGRATIONS_KEY in decoded
      ? { declaredMigrations: decoded.declaredMigrations } : {}),
    directHardDependencies: decoded.directHardDependencies,
    planExecutionContent: plan.content,
    predicateRegistry: decoded.predicateRegistry,
  }, true);
  if (!admitted.ok) return admitted;
  const canonical = nodePlanningSourceWireOf(admitted.content);
  return canonical !== undefined && sameNodePlanningSourceBytes(decoded.bytes, canonical.bytes)
    ? admitted
    : refuse("NODE_PLANNING_SOURCE_NONCANONICAL", "NODE_PLANNING_SOURCE_IDENTITY",
      "bytes are not the canonical spelling of their content");
}
