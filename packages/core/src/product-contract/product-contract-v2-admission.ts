import {
  deepFreeze, exact, snapshotDataBounded, validHex64, validRef,
} from "../planning/planning-snapshot.js";
import {
  PRODUCT_CONTRACT_V2_BUDGET_KINDS,
  PRODUCT_CONTRACT_V2_LIMITS,
  PRODUCT_CONTRACT_V2_PRIORITIES,
  PRODUCT_CONTRACT_V2_VERSION,
  productContractV2Refusal,
  type ProductContractRevisionV2Draft,
  type ProductContractV2Admission,
  type ProductContractV2Assumption,
  type ProductContractV2Budget,
  type ProductContractV2Criterion,
  type ProductContractV2DecisionOption,
  type ProductContractV2DeploymentRequirement,
  type ProductContractV2DraftAdmission,
  type ProductContractV2Journey,
  type ProductContractV2Lineage,
  type ProductContractV2MaterialDecision,
  type ProductContractV2NegativeScope,
  type ProductContractV2Objective,
  type ProductContractV2ProductCompleteDefinition,
  type ProductContractV2Refusal,
  type ProductContractV2Requirement,
  type ProductContractV2SuccessMetric,
  type ProductContractV2UserJob,
} from "./product-contract-v2-contract.js";

type ReadResult<T> = Readonly<{ ok: true; value: T }> | ProductContractV2Refusal;
type ParsedRevision = Readonly<{
  body: ProductContractRevisionV2Draft;
  revisionDigest?: string;
}>;

const encoder = new TextEncoder();
const DRAFT_KEYS = Object.freeze([
  "assumptions", "authorRef", "budgets", "contractId", "criteria",
  "deploymentRequirements", "functionalRequirements", "journeys", "lineage",
  "materialDecisions", "negativeScope", "nonFunctionalRequirements", "objectives",
  "productCompleteDefinition", "retiredCriterionIds", "retiredRequirementIds", "revisionId",
  "securityPrivacyRequirements", "sourceDocumentDigests", "successMetrics",
  "technologyRequirements", "userJobs", "uxAccessibilityRequirements",
]);
const FULL_KEYS = Object.freeze(["advisoryOnly", ...DRAFT_KEYS, "revisionDigest", "version"]);
const LINEAGE_KEYS = Object.freeze(["parentRevisionDigest", "parentRevisionId"]);
const STATEMENT_KEYS = Object.freeze(["objectiveId", "statement"]);
const USER_JOB_KEYS = Object.freeze(["job", "user", "userJobId"]);
const JOURNEY_KEYS = Object.freeze(["criterionIds", "journeyId", "statement", "userJobId"]);
const REQUIREMENT_KEYS = Object.freeze([
  "dependsOnRequirementIds", "priority", "requirementId", "statement",
  "supersedesRequirementId",
]);
const DEPLOYMENT_REQUIREMENT_KEYS = Object.freeze([
  "dependsOnRequirementIds", "environmentVariableNames", "priority", "requirementId",
  "statement", "supersedesRequirementId",
]);
/** POSIX portable environment-variable name. Names only: a value cannot match this. */
const ENVIRONMENT_VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;
const CRITERION_KEYS = Object.freeze([
  "criterionId", "requirementId", "statement", "supersedesCriterionId", "verification",
]);
const NEGATIVE_SCOPE_KEYS = Object.freeze(["scopeId", "statement"]);
const ASSUMPTION_KEYS = Object.freeze([
  "assumptionId", "statement", "validationCriterionId",
]);
const BUDGET_KEYS = Object.freeze(["budgetId", "kind", "limit", "unit"]);
const METRIC_KEYS = Object.freeze([
  "measurement", "metricId", "objectiveIds", "statement", "target",
]);
const OPTION_KEYS = Object.freeze(["optionId", "statement"]);
const DECISION_KEYS = Object.freeze([
  "decisionId", "options", "question", "selectedOptionId",
]);
const COMPLETE_KEYS = Object.freeze(["criterionIds", "statement"]);

const invalid = (): ProductContractV2Refusal => productContractV2Refusal(
  "PRODUCT_CONTRACT_V2_PROVENANCE_INVALID", "PRODUCT_CONTRACT_V2_PROVENANCE",
);
const vacuous = (): ProductContractV2Refusal => productContractV2Refusal(
  "PRODUCT_CONTRACT_V2_PROVENANCE_VACUOUS", "PRODUCT_CONTRACT_V2_PROVENANCE",
);
const exceeded = (): ProductContractV2Refusal => productContractV2Refusal(
  "PRODUCT_CONTRACT_V2_LIMIT_EXCEEDED", "PRODUCT_CONTRACT_V2_PROVENANCE",
);
const semantic = (code: Parameters<typeof productContractV2Refusal>[0]): ProductContractV2Refusal =>
  productContractV2Refusal(code, "PRODUCT_CONTRACT_V2_SEMANTICS");
const success = <T>(value: T): Readonly<{ ok: true; value: T }> =>
  Object.freeze({ ok: true as const, value });

function readText(
  value: unknown,
  maximum: number = PRODUCT_CONTRACT_V2_LIMITS.maxIdBytes,
): ReadResult<string> {
  if (!validRef(value) || value.includes("\0") || !value.isWellFormed()
    || value.normalize("NFC") !== value) return invalid();
  if (value.trim().length === 0) return vacuous();
  if (value.trim() !== value) return invalid();
  if (value.length > maximum) return exceeded();
  return encoder.encode(value).byteLength <= maximum ? success(value) : exceeded();
}

function readNullableRef(value: unknown): ReadResult<string | null> {
  return value === null ? success(null) : readText(value);
}

function readSortedRefs(
  value: unknown,
  allowEmpty: boolean,
  maximum: number = PRODUCT_CONTRACT_V2_LIMITS.maxItemsPerSection,
): ReadResult<readonly string[]> {
  if (!Array.isArray(value)) return invalid();
  if (!allowEmpty && value.length === 0) return vacuous();
  if (value.length > maximum) return exceeded();
  const result: string[] = [];
  for (const candidate of value) {
    const item = readText(candidate); if (!item.ok) return item;
    if (result.at(-1) !== undefined && result.at(-1)! >= item.value) return invalid();
    result.push(item.value);
  }
  return success(Object.freeze(result));
}

function readSources(value: unknown): ReadResult<readonly string[]> {
  if (!Array.isArray(value)) return invalid();
  if (value.length === 0) return vacuous();
  if (value.length > PRODUCT_CONTRACT_V2_LIMITS.maxSourceDocuments) return exceeded();
  const result: string[] = [];
  for (const candidate of value) {
    if (!validHex64(candidate)) return invalid();
    if (result.at(-1) !== undefined && result.at(-1)! >= candidate) return invalid();
    result.push(candidate);
  }
  return success(Object.freeze(result));
}

function readSortedItems<T>(
  value: unknown,
  allowEmpty: boolean,
  maximum: number,
  read: (candidate: unknown) => ReadResult<T>,
  idOf: (item: T) => string,
): ReadResult<readonly T[]> {
  if (!Array.isArray(value)) return invalid();
  if (!allowEmpty && value.length === 0) return vacuous();
  if (value.length > maximum) return exceeded();
  const result: T[] = [];
  for (const candidate of value) {
    const item = read(candidate); if (!item.ok) return item;
    if (result.at(-1) !== undefined && idOf(result.at(-1)!) >= idOf(item.value)) return invalid();
    result.push(item.value);
  }
  return success(Object.freeze(result));
}

function readLineage(value: unknown): ReadResult<ProductContractV2Lineage | null> {
  if (value === null) return success(null);
  if (!exact(value, LINEAGE_KEYS) || !validHex64(value["parentRevisionDigest"])) return invalid();
  const id = readText(value["parentRevisionId"]); if (!id.ok) return id;
  return success(Object.freeze({
    parentRevisionDigest: value["parentRevisionDigest"], parentRevisionId: id.value,
  }));
}

function readObjective(value: unknown): ReadResult<ProductContractV2Objective> {
  if (!exact(value, STATEMENT_KEYS)) return invalid();
  const id = readText(value["objectiveId"]);
  const statement = readText(value["statement"], PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes);
  if (!id.ok) return id; if (!statement.ok) return statement;
  return success(Object.freeze({ objectiveId: id.value, statement: statement.value }));
}

function readUserJob(value: unknown): ReadResult<ProductContractV2UserJob> {
  if (!exact(value, USER_JOB_KEYS)) return invalid();
  const id = readText(value["userJobId"]);
  const user = readText(value["user"], PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes);
  const job = readText(value["job"], PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes);
  if (!id.ok) return id; if (!user.ok) return user; if (!job.ok) return job;
  return success(Object.freeze({ job: job.value, user: user.value, userJobId: id.value }));
}

function readJourney(value: unknown): ReadResult<ProductContractV2Journey> {
  if (!exact(value, JOURNEY_KEYS)) return invalid();
  const id = readText(value["journeyId"]); const userJob = readText(value["userJobId"]);
  const statement = readText(value["statement"], PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes);
  const criteria = readSortedRefs(value["criterionIds"], false, PRODUCT_CONTRACT_V2_LIMITS.maxCriteria);
  if (!id.ok) return id; if (!userJob.ok) return userJob;
  if (!statement.ok) return statement; if (!criteria.ok) return criteria;
  return success(Object.freeze({
    criterionIds: criteria.value, journeyId: id.value,
    statement: statement.value, userJobId: userJob.value,
  }));
}

function readRequirement(value: unknown): ReadResult<ProductContractV2Requirement> {
  if (!exact(value, REQUIREMENT_KEYS)) return invalid();
  const id = readText(value["requirementId"]);
  const statement = readText(value["statement"], PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes);
  const supersedes = readNullableRef(value["supersedesRequirementId"]);
  const dependencies = readSortedRefs(value["dependsOnRequirementIds"], true);
  const priority = value["priority"];
  if (!id.ok) return id; if (!statement.ok) return statement;
  if (!supersedes.ok) return supersedes; if (!dependencies.ok) return dependencies;
  if (!PRODUCT_CONTRACT_V2_PRIORITIES.some((candidate) => candidate === priority)) return invalid();
  if (supersedes.value === id.value || dependencies.value.includes(id.value)) return invalid();
  return success(Object.freeze({
    dependsOnRequirementIds: dependencies.value,
    priority,
    requirementId: id.value,
    statement: statement.value,
    supersedesRequirementId: supersedes.value,
  } as ProductContractV2Requirement));
}

/** Names only. A value-shaped entry (`NAME=secret`) cannot match the name grammar. */
function readEnvironmentVariableNames(value: unknown): ReadResult<readonly string[]> {
  if (!Array.isArray(value)) return invalid();
  if (value.length > PRODUCT_CONTRACT_V2_LIMITS.maxEnvironmentVariableNames) return exceeded();
  const result: string[] = [];
  for (const candidate of value) {
    const name = readText(candidate, PRODUCT_CONTRACT_V2_LIMITS.maxEnvironmentVariableNameBytes);
    if (!name.ok) return name;
    if (!ENVIRONMENT_VARIABLE_NAME.test(name.value)) return invalid();
    if (result.at(-1) !== undefined && result.at(-1)! >= name.value) return invalid();
    result.push(name.value);
  }
  return success(Object.freeze(result));
}

/** Accepts a deployment requirement with OR without the optional names carrier. */
function readDeploymentRequirement(
  value: unknown,
): ReadResult<ProductContractV2DeploymentRequirement> {
  if (!exact(value, DEPLOYMENT_REQUIREMENT_KEYS)) return readRequirement(value);
  const { environmentVariableNames, ...rest } = value;
  const requirement = readRequirement(rest);
  if (!requirement.ok) return requirement;
  const names = readEnvironmentVariableNames(environmentVariableNames);
  return names.ok
    ? success(Object.freeze({ ...requirement.value, environmentVariableNames: names.value }))
    : names;
}

function readCriterion(value: unknown): ReadResult<ProductContractV2Criterion> {
  if (!exact(value, CRITERION_KEYS)) return invalid();
  const id = readText(value["criterionId"]); const requirement = readText(value["requirementId"]);
  const statement = readText(value["statement"], PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes);
  const verification = readText(value["verification"], PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes);
  const supersedes = readNullableRef(value["supersedesCriterionId"]);
  if (!id.ok) return id; if (!requirement.ok) return requirement;
  if (!statement.ok) return statement; if (!verification.ok) return verification;
  if (!supersedes.ok) return supersedes; if (supersedes.value === id.value) return invalid();
  return success(Object.freeze({
    criterionId: id.value, requirementId: requirement.value, statement: statement.value,
    supersedesCriterionId: supersedes.value, verification: verification.value,
  }));
}

function readNegativeScope(value: unknown): ReadResult<ProductContractV2NegativeScope> {
  if (!exact(value, NEGATIVE_SCOPE_KEYS)) return invalid();
  const id = readText(value["scopeId"]);
  const statement = readText(value["statement"], PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes);
  if (!id.ok) return id; if (!statement.ok) return statement;
  return success(Object.freeze({ scopeId: id.value, statement: statement.value }));
}

function readAssumption(value: unknown): ReadResult<ProductContractV2Assumption> {
  if (!exact(value, ASSUMPTION_KEYS)) return invalid();
  const id = readText(value["assumptionId"]);
  const criterion = readText(value["validationCriterionId"]);
  const statement = readText(value["statement"], PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes);
  if (!id.ok) return id; if (!criterion.ok) return criterion; if (!statement.ok) return statement;
  return success(Object.freeze({
    assumptionId: id.value, statement: statement.value, validationCriterionId: criterion.value,
  }));
}

function readBudget(value: unknown): ReadResult<ProductContractV2Budget> {
  if (!exact(value, BUDGET_KEYS)) return invalid();
  const id = readText(value["budgetId"]); const unit = readText(value["unit"]);
  const kind = value["kind"]; const limit = value["limit"];
  if (!id.ok) return id; if (!unit.ok) return unit;
  if (!PRODUCT_CONTRACT_V2_BUDGET_KINDS.some((candidate) => candidate === kind)
    || !Number.isSafeInteger(limit) || (limit as number) <= 0) return invalid();
  return success(Object.freeze({
    budgetId: id.value, kind, limit, unit: unit.value,
  } as ProductContractV2Budget));
}

function readMetric(value: unknown): ReadResult<ProductContractV2SuccessMetric> {
  if (!exact(value, METRIC_KEYS)) return invalid();
  const id = readText(value["metricId"]);
  const objectives = readSortedRefs(value["objectiveIds"], false);
  const statement = readText(value["statement"], PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes);
  const measurement = readText(value["measurement"], PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes);
  const target = readText(value["target"], PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes);
  if (!id.ok) return id; if (!objectives.ok) return objectives;
  if (!statement.ok) return statement; if (!measurement.ok) return measurement; if (!target.ok) return target;
  return success(Object.freeze({
    measurement: measurement.value, metricId: id.value, objectiveIds: objectives.value,
    statement: statement.value, target: target.value,
  }));
}

function readOption(value: unknown): ReadResult<ProductContractV2DecisionOption> {
  if (!exact(value, OPTION_KEYS)) return invalid();
  const id = readText(value["optionId"]);
  const statement = readText(value["statement"], PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes);
  if (!id.ok) return id; if (!statement.ok) return statement;
  return success(Object.freeze({ optionId: id.value, statement: statement.value }));
}

function readDecision(value: unknown): ReadResult<ProductContractV2MaterialDecision> {
  if (!exact(value, DECISION_KEYS)) return invalid();
  const id = readText(value["decisionId"]);
  const question = readText(value["question"], PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes);
  const selected = readNullableRef(value["selectedOptionId"]);
  const options = readSortedItems(
    value["options"], false, PRODUCT_CONTRACT_V2_LIMITS.maxOptionsPerDecision,
    readOption, (item) => item.optionId,
  );
  if (!id.ok) return id; if (!question.ok) return question;
  if (!selected.ok) return selected; if (!options.ok) return options;
  if (options.value.length < 2) return vacuous();
  return success(Object.freeze({
    decisionId: id.value, options: options.value, question: question.value,
    selectedOptionId: selected.value,
  }));
}

function readComplete(value: unknown): ReadResult<ProductContractV2ProductCompleteDefinition> {
  if (!exact(value, COMPLETE_KEYS)) return invalid();
  const criteria = readSortedRefs(value["criterionIds"], false, PRODUCT_CONTRACT_V2_LIMITS.maxCriteria);
  const statement = readText(value["statement"], PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes);
  if (!criteria.ok) return criteria; if (!statement.ok) return statement;
  return success(Object.freeze({ criterionIds: criteria.value, statement: statement.value }));
}

function requirementCycle(requirements: readonly ProductContractV2Requirement[]): boolean {
  const dependencies = new Map(requirements.map((item) => [item.requirementId, item.dependsOnRequirementIds]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) if (visit(dependency)) return true;
    visiting.delete(id); visited.add(id); return false;
  };
  return requirements.some((item) => visit(item.requirementId));
}

function sameSorted(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateSemantics(body: ProductContractRevisionV2Draft): ProductContractV2Refusal | undefined {
  const requirements = [
    ...body.deploymentRequirements,
    ...body.functionalRequirements,
    ...body.nonFunctionalRequirements,
    ...body.securityPrivacyRequirements,
    ...body.technologyRequirements,
    ...body.uxAccessibilityRequirements,
  ];
  const requirementIds = new Set<string>();
  for (const item of requirements) {
    if (requirementIds.has(item.requirementId)) return semantic("PRODUCT_CONTRACT_V2_REFERENCE_INVALID");
    requirementIds.add(item.requirementId);
  }
  if (body.retiredRequirementIds.some((id) => requirementIds.has(id))) {
    return semantic("PRODUCT_CONTRACT_V2_REFERENCE_INVALID");
  }
  const retiredRequirements = new Set(body.retiredRequirementIds);
  const supersededRequirements = new Set<string>();
  for (const item of requirements) {
    if (item.dependsOnRequirementIds.some((id) => !requirementIds.has(id))) {
      return semantic("PRODUCT_CONTRACT_V2_REFERENCE_INVALID");
    }
    if (item.supersedesRequirementId !== null
      && (!retiredRequirements.has(item.supersedesRequirementId)
        || supersededRequirements.has(item.supersedesRequirementId))) {
      return semantic("PRODUCT_CONTRACT_V2_REFERENCE_INVALID");
    }
    if (item.supersedesRequirementId !== null) {
      supersededRequirements.add(item.supersedesRequirementId);
    }
  }
  if (requirementCycle(requirements)) return semantic("PRODUCT_CONTRACT_V2_REQUIREMENT_CYCLE");

  const criterionIds = new Set(body.criteria.map((item) => item.criterionId));
  if (body.retiredCriterionIds.some((id) => criterionIds.has(id))) {
    return semantic("PRODUCT_CONTRACT_V2_REFERENCE_INVALID");
  }
  const retiredCriteria = new Set(body.retiredCriterionIds);
  const supersededCriteria = new Set<string>();
  const coveredRequirements = new Set<string>();
  for (const item of body.criteria) {
    if (!requirementIds.has(item.requirementId)) return semantic("PRODUCT_CONTRACT_V2_REFERENCE_INVALID");
    if (item.supersedesCriterionId !== null
      && (!retiredCriteria.has(item.supersedesCriterionId)
        || supersededCriteria.has(item.supersedesCriterionId))) {
      return semantic("PRODUCT_CONTRACT_V2_REFERENCE_INVALID");
    }
    if (item.supersedesCriterionId !== null) supersededCriteria.add(item.supersedesCriterionId);
    coveredRequirements.add(item.requirementId);
  }
  if ([...requirementIds].some((id) => !coveredRequirements.has(id))) {
    return semantic("PRODUCT_CONTRACT_V2_COVERAGE_INCOMPLETE");
  }

  const userJobs = new Set(body.userJobs.map((item) => item.userJobId));
  const representedUserJobs = new Set<string>();
  for (const journey of body.journeys) {
    if (!userJobs.has(journey.userJobId)
      || journey.criterionIds.some((id) => !criterionIds.has(id))) {
      return semantic("PRODUCT_CONTRACT_V2_REFERENCE_INVALID");
    }
    representedUserJobs.add(journey.userJobId);
  }
  if ([...userJobs].some((id) => !representedUserJobs.has(id))) {
    return semantic("PRODUCT_CONTRACT_V2_COVERAGE_INCOMPLETE");
  }
  if (body.assumptions.some((item) => !criterionIds.has(item.validationCriterionId))) {
    return semantic("PRODUCT_CONTRACT_V2_REFERENCE_INVALID");
  }

  const objectives = new Set(body.objectives.map((item) => item.objectiveId));
  const measured = new Set<string>();
  for (const metric of body.successMetrics) {
    if (metric.objectiveIds.some((id) => !objectives.has(id))) {
      return semantic("PRODUCT_CONTRACT_V2_REFERENCE_INVALID");
    }
    metric.objectiveIds.forEach((id) => measured.add(id));
  }
  if ([...objectives].some((id) => !measured.has(id))) {
    return semantic("PRODUCT_CONTRACT_V2_COVERAGE_INCOMPLETE");
  }

  for (const decision of body.materialDecisions) {
    if (decision.selectedOptionId === null) {
      return semantic("PRODUCT_CONTRACT_V2_MATERIAL_DECISION_UNRESOLVED");
    }
    if (!decision.options.some((option) => option.optionId === decision.selectedOptionId)) {
      return semantic("PRODUCT_CONTRACT_V2_REFERENCE_INVALID");
    }
  }
  const allCriteria = [...criterionIds].sort();
  if (!sameSorted(body.productCompleteDefinition.criterionIds, allCriteria)) {
    return semantic("PRODUCT_CONTRACT_V2_COVERAGE_INCOMPLETE");
  }
  return undefined;
}

function parseRevision(value: unknown, full: boolean): ReadResult<ParsedRevision> {
  const snapshot = snapshotDataBounded(value, {
    maxArrayLength: PRODUCT_CONTRACT_V2_LIMITS.maxRetiredIds,
    maxDepth: PRODUCT_CONTRACT_V2_LIMITS.maxSnapshotDepth,
    maxNodes: PRODUCT_CONTRACT_V2_LIMITS.maxSnapshotNodes,
  });
  if (!snapshot.ok) return snapshot.limitExceeded ? exceeded() : invalid();
  if (!exact(snapshot.value, full ? FULL_KEYS : DRAFT_KEYS)) return invalid();
  const record = snapshot.value;
  if (full && record["version"] !== PRODUCT_CONTRACT_V2_VERSION) {
    return productContractV2Refusal(
      "PRODUCT_CONTRACT_V2_VERSION_UNSUPPORTED", "PRODUCT_CONTRACT_V2_PROVENANCE",
    );
  }
  if (full && record["advisoryOnly"] !== true) return invalid();

  const author = readText(record["authorRef"]); const contract = readText(record["contractId"]);
  const revision = readText(record["revisionId"]); const lineage = readLineage(record["lineage"]);
  const sources = readSources(record["sourceDocumentDigests"]);
  const retiredRequirements = readSortedRefs(
    record["retiredRequirementIds"], true, PRODUCT_CONTRACT_V2_LIMITS.maxRetiredIds,
  );
  const retiredCriteria = readSortedRefs(
    record["retiredCriterionIds"], true, PRODUCT_CONTRACT_V2_LIMITS.maxRetiredIds,
  );
  const objectives = readSortedItems(record["objectives"], false,
    PRODUCT_CONTRACT_V2_LIMITS.maxItemsPerSection, readObjective, (item) => item.objectiveId);
  const userJobs = readSortedItems(record["userJobs"], false,
    PRODUCT_CONTRACT_V2_LIMITS.maxItemsPerSection, readUserJob, (item) => item.userJobId);
  const journeys = readSortedItems(record["journeys"], false,
    PRODUCT_CONTRACT_V2_LIMITS.maxItemsPerSection, readJourney, (item) => item.journeyId);
  const functional = readSortedItems(record["functionalRequirements"], false,
    PRODUCT_CONTRACT_V2_LIMITS.maxItemsPerSection, readRequirement, (item) => item.requirementId);
  const nonFunctional = readSortedItems(record["nonFunctionalRequirements"], false,
    PRODUCT_CONTRACT_V2_LIMITS.maxItemsPerSection, readRequirement, (item) => item.requirementId);
  const ux = readSortedItems(record["uxAccessibilityRequirements"], false,
    PRODUCT_CONTRACT_V2_LIMITS.maxItemsPerSection, readRequirement, (item) => item.requirementId);
  const security = readSortedItems(record["securityPrivacyRequirements"], false,
    PRODUCT_CONTRACT_V2_LIMITS.maxItemsPerSection, readRequirement, (item) => item.requirementId);
  const technology = readSortedItems(record["technologyRequirements"], false,
    PRODUCT_CONTRACT_V2_LIMITS.maxItemsPerSection, readRequirement, (item) => item.requirementId);
  const deployment = readSortedItems(record["deploymentRequirements"], false,
    PRODUCT_CONTRACT_V2_LIMITS.maxItemsPerSection, readDeploymentRequirement,
    (item) => item.requirementId);
  const criteria = readSortedItems(record["criteria"], false,
    PRODUCT_CONTRACT_V2_LIMITS.maxCriteria, readCriterion, (item) => item.criterionId);
  const negativeScope = readSortedItems(record["negativeScope"], false,
    PRODUCT_CONTRACT_V2_LIMITS.maxItemsPerSection, readNegativeScope, (item) => item.scopeId);
  const assumptions = readSortedItems(record["assumptions"], true,
    PRODUCT_CONTRACT_V2_LIMITS.maxItemsPerSection, readAssumption, (item) => item.assumptionId);
  const budgets = readSortedItems(record["budgets"], false,
    PRODUCT_CONTRACT_V2_LIMITS.maxBudgets, readBudget, (item) => item.budgetId);
  const metrics = readSortedItems(record["successMetrics"], false,
    PRODUCT_CONTRACT_V2_LIMITS.maxItemsPerSection, readMetric, (item) => item.metricId);
  const decisions = readSortedItems(record["materialDecisions"], true,
    PRODUCT_CONTRACT_V2_LIMITS.maxDecisions, readDecision, (item) => item.decisionId);
  const complete = readComplete(record["productCompleteDefinition"]);

  const values = [author, contract, revision, lineage, sources, retiredRequirements, retiredCriteria,
    objectives, userJobs, journeys, functional, nonFunctional, ux, security, technology, deployment,
    criteria, negativeScope, assumptions, budgets, metrics, decisions, complete];
  const refusal = values.find((item) => !item.ok);
  if (refusal !== undefined && !refusal.ok) return refusal;
  if (!author.ok || !contract.ok || !revision.ok || !lineage.ok || !sources.ok
    || !retiredRequirements.ok || !retiredCriteria.ok || !objectives.ok || !userJobs.ok
    || !journeys.ok || !functional.ok || !nonFunctional.ok || !ux.ok || !security.ok
    || !technology.ok || !deployment.ok || !criteria.ok || !negativeScope.ok || !assumptions.ok
    || !budgets.ok || !metrics.ok || !decisions.ok || !complete.ok) return invalid();

  const body: ProductContractRevisionV2Draft = Object.freeze({
    assumptions: assumptions.value,
    authorRef: author.value,
    budgets: budgets.value,
    contractId: contract.value,
    criteria: criteria.value,
    deploymentRequirements: deployment.value,
    functionalRequirements: functional.value,
    journeys: journeys.value,
    lineage: lineage.value,
    materialDecisions: decisions.value,
    negativeScope: negativeScope.value,
    nonFunctionalRequirements: nonFunctional.value,
    objectives: objectives.value,
    productCompleteDefinition: complete.value,
    retiredCriterionIds: retiredCriteria.value,
    retiredRequirementIds: retiredRequirements.value,
    revisionId: revision.value,
    securityPrivacyRequirements: security.value,
    sourceDocumentDigests: sources.value,
    successMetrics: metrics.value,
    technologyRequirements: technology.value,
    userJobs: userJobs.value,
    uxAccessibilityRequirements: ux.value,
  });
  if (body.lineage === null && (body.retiredCriterionIds.length > 0
    || body.retiredRequirementIds.length > 0
    || body.criteria.some((item) => item.supersedesCriterionId !== null)
    || requirementsOf(body).some((item) => item.supersedesRequirementId !== null))) return invalid();
  const semanticRefusal = validateSemantics(body); if (semanticRefusal !== undefined) return semanticRefusal;
  if (!full) return success({ body });
  return validHex64(record["revisionDigest"])
    ? success({ body, revisionDigest: record["revisionDigest"] }) : invalid();
}

function requirementsOf(body: ProductContractRevisionV2Draft): readonly ProductContractV2Requirement[] {
  return [
    ...body.deploymentRequirements, ...body.functionalRequirements,
    ...body.nonFunctionalRequirements, ...body.securityPrivacyRequirements,
    ...body.technologyRequirements, ...body.uxAccessibilityRequirements,
  ];
}

export function admitProductContractRevisionV2Draft(
  value: unknown,
): ProductContractV2DraftAdmission {
  const parsed = parseRevision(value, false);
  return parsed.ok
    ? Object.freeze({ draft: deepFreeze({ ...parsed.value.body }), ok: true as const })
    : parsed;
}

export function admitProductContractRevisionV2(value: unknown): ProductContractV2Admission {
  const parsed = parseRevision(value, true); if (!parsed.ok) return parsed;
  return Object.freeze({ ok: true as const, revision: deepFreeze({
    ...parsed.value.body,
    advisoryOnly: true as const,
    revisionDigest: parsed.value.revisionDigest!,
    version: PRODUCT_CONTRACT_V2_VERSION,
  }) });
}
