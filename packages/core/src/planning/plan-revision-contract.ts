import { isProxy } from "node:util/types";
import { MAX_JSON_BODY_BYTES } from "@moe/contracts";
import { deepFreeze, exact, snapshotData, validHex64 } from "./planning-snapshot.js";
export const PLAN_REVISION_VERSION = "moe-plan-revision/1" as const;
export const PLAN_REVISION_STEP_KINDS = Object.freeze([
  "ANALYSIS", "IMPLEMENTATION", "INTEGRATION", "VERIFICATION", "DOCUMENTATION", "REVIEW",
] as const);
export const PLAN_REVISION_APPROVAL_STATES = Object.freeze([
  "PENDING_APPROVAL", "APPROVED", "REJECTED",
] as const);
export const PLAN_REVISION_CODES = Object.freeze([
  "PLAN_REVISION_MALFORMED", "PLAN_REVISION_VERSION_UNSUPPORTED",
  "PLAN_REVISION_DUPLICATE_ID", "PLAN_REVISION_LIMIT_EXCEEDED",
  "PLAN_REVISION_BYTES_INVALID", "PLAN_REVISION_DUPLICATE_KEY",
  "PLAN_REVISION_NONCANONICAL", "PLAN_REVISION_DIGEST_MISMATCH",
] as const);
export const PLAN_REVISION_LAYERS = Object.freeze([
  "PLAN_REVISION_ADMISSION", "PLAN_REVISION_VERSION", "PLAN_REVISION_LIMITS",
  "PLAN_REVISION_CODEC", "PLAN_REVISION_CANONICALIZATION", "PLAN_REVISION_DIGEST",
] as const);
export const PLAN_REVISION_LIMITS = Object.freeze({
  maxAggregateEntries: 20_000,
  maxBytes: MAX_JSON_BODY_BYTES,
  maxDescriptionBytes: 65_536,
  maxIdBytes: 512,
  maxSetEntries: 10_000,
  maxSteps: 512,
});

export type PlanRevisionStepKind = (typeof PLAN_REVISION_STEP_KINDS)[number];
export type PlanRevisionApprovalState = (typeof PLAN_REVISION_APPROVAL_STATES)[number];
export type PlanRevisionCode = (typeof PLAN_REVISION_CODES)[number];
export type PlanRevisionLayer = (typeof PLAN_REVISION_LAYERS)[number];
export interface PlanRevisionStep {
  readonly description: string;
  readonly kind: PlanRevisionStepKind;
  readonly stepId: string;
}

export interface PlanRevisionGraphBinding {
  readonly graphContentHash: string;
  readonly graphRevisionRef: string;
}
export interface PlanRevisionDraft {
  readonly affectedCriterionIds: readonly string[];
  readonly affectedNodeIds: readonly string[];
  readonly approvalState: PlanRevisionApprovalState;
  readonly authorRef: string;
  readonly graphBinding: PlanRevisionGraphBinding;
  readonly parentRevisionId: string | null;
  readonly rejectionRef: string | null;
  readonly revisionId: string;
  readonly steps: readonly PlanRevisionStep[];
  readonly verificationRecipeRefs: readonly string[];
}

export interface PlanRevision extends PlanRevisionDraft {
  readonly planHash: string;
  readonly version: typeof PLAN_REVISION_VERSION;
}
export interface PlanRevisionRefusal {
  readonly code: PlanRevisionCode;
  readonly layer: PlanRevisionLayer;
  readonly ok: false;
}

export type PlanRevisionDraftAdmission =
  | Readonly<{ draft: PlanRevisionDraft; ok: true }>
  | PlanRevisionRefusal;
export type PlanRevisionAdmission =
  | Readonly<{ ok: true; revision: PlanRevision }>
  | PlanRevisionRefusal;

export type PlanRevisionReadResult<T> = Readonly<{ ok: true; value: T }> | PlanRevisionRefusal;
interface ParsedPlan {
  readonly body: PlanRevisionDraft;
  readonly planHash?: string;
}

const encoder = new TextEncoder();
const FULL_KEYS = Object.freeze([
  "affectedCriterionIds", "affectedNodeIds", "approvalState", "authorRef", "graphBinding",
  "parentRevisionId", "planHash", "rejectionRef", "revisionId", "steps",
  "verificationRecipeRefs", "version",
]);
const DRAFT_KEYS = FULL_KEYS.filter((key) => key !== "planHash" && key !== "version");
const STEP_KEYS = Object.freeze(["description", "kind", "stepId"]);
const GRAPH_KEYS = Object.freeze(["graphContentHash", "graphRevisionRef"]);

export function planRevisionRefusal(
  code: PlanRevisionCode,
  layer: PlanRevisionLayer,
): PlanRevisionRefusal {
  return Object.freeze({ code, layer, ok: false as const });
}

const malformed = (): PlanRevisionRefusal =>
  planRevisionRefusal("PLAN_REVISION_MALFORMED", "PLAN_REVISION_ADMISSION");
const exceeded = (): PlanRevisionRefusal =>
  planRevisionRefusal("PLAN_REVISION_LIMIT_EXCEEDED", "PLAN_REVISION_LIMITS");
const duplicated = (): PlanRevisionRefusal =>
  planRevisionRefusal("PLAN_REVISION_DUPLICATE_ID", "PLAN_REVISION_LIMITS");
const success = <T>(value: T): Readonly<{ ok: true; value: T }> =>
  Object.freeze({ ok: true as const, value });

function hostileObject(
  value: unknown,
  seen = new WeakSet<object>(),
): PlanRevisionRefusal | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (isProxy(value)) return malformed();
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    const array = Array.isArray(value);
    if (array ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null) return malformed();
    if (array && value.length > PLAN_REVISION_LIMITS.maxSetEntries) return exceeded();
    for (const key of Reflect.ownKeys(value)) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || property === undefined || !("value" in property)) {
        return malformed();
      }
      const nested = hostileObject(property.value, seen);
      if (nested !== undefined) return nested;
    }
    return undefined;
  } catch {
    return malformed();
  } finally {
    seen.delete(value);
  }
}

function readText(value: unknown, maximum: number): PlanRevisionReadResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || !value.isWellFormed() || value.normalize("NFC") !== value) return malformed();
  if (encoder.encode(value).byteLength > maximum) return exceeded();
  return success(value);
}

function readNullableText(value: unknown): PlanRevisionReadResult<string | null> {
  return value === null ? success(null) : readText(value, PLAN_REVISION_LIMITS.maxIdBytes);
}

export function readPlanRevisionSet(value: unknown): PlanRevisionReadResult<readonly string[]> {
  if (!Array.isArray(value) || value.length === 0) return malformed();
  if (value.length > PLAN_REVISION_LIMITS.maxSetEntries) return exceeded();
  const items: string[] = [];
  for (const candidate of value) {
    const item = readText(candidate, PLAN_REVISION_LIMITS.maxIdBytes);
    if (!item.ok) return item;
    const previous = items.at(-1);
    if (previous === item.value) return duplicated();
    if (previous !== undefined && previous > item.value) return malformed();
    items.push(item.value);
  }
  return success(Object.freeze(items));
}

function readStep(value: unknown): PlanRevisionReadResult<PlanRevisionStep> {
  if (!exact(value, STEP_KEYS)) return malformed();
  const stepId = readText(value["stepId"], PLAN_REVISION_LIMITS.maxIdBytes);
  const description = readText(value["description"], PLAN_REVISION_LIMITS.maxDescriptionBytes);
  if (!stepId.ok) return stepId;
  if (!description.ok) return description;
  const kind = value["kind"];
  if (typeof kind !== "string" || !PLAN_REVISION_STEP_KINDS.includes(kind as PlanRevisionStepKind)) {
    return malformed();
  }
  return success(Object.freeze({ description: description.value, kind: kind as PlanRevisionStepKind,
    stepId: stepId.value }));
}

export function readPlanRevisionSteps(value: unknown): PlanRevisionReadResult<readonly PlanRevisionStep[]> {
  if (!Array.isArray(value) || value.length === 0) return malformed();
  if (value.length > PLAN_REVISION_LIMITS.maxSteps) return exceeded();
  const ids = new Set<string>();
  const steps: PlanRevisionStep[] = [];
  for (const candidate of value) {
    const step = readStep(candidate);
    if (!step.ok) return step;
    if (ids.has(step.value.stepId)) return duplicated();
    ids.add(step.value.stepId);
    steps.push(step.value);
  }
  return success(Object.freeze(steps));
}

function readGraph(value: unknown): PlanRevisionReadResult<PlanRevisionGraphBinding> {
  if (!exact(value, GRAPH_KEYS) || !validHex64(value["graphContentHash"])) return malformed();
  const revision = readText(value["graphRevisionRef"], PLAN_REVISION_LIMITS.maxIdBytes);
  return revision.ok ? success(Object.freeze({ graphContentHash: value["graphContentHash"],
    graphRevisionRef: revision.value })) : revision;
}

function parsePlan(value: unknown, full: boolean): PlanRevisionReadResult<ParsedPlan> {
  const hostile = hostileObject(value);
  if (hostile !== undefined) return hostile;
  const snapshot = snapshotData(value);
  if (!snapshot.ok || !exact(snapshot.value, full ? FULL_KEYS : DRAFT_KEYS)) return malformed();
  const record = snapshot.value;
  if (full && record["version"] !== PLAN_REVISION_VERSION) {
    return planRevisionRefusal("PLAN_REVISION_VERSION_UNSUPPORTED", "PLAN_REVISION_VERSION");
  }
  const revisionId = readText(record["revisionId"], PLAN_REVISION_LIMITS.maxIdBytes);
  const parentRevisionId = readNullableText(record["parentRevisionId"]);
  const rejectionRef = readNullableText(record["rejectionRef"]);
  const authorRef = readText(record["authorRef"], PLAN_REVISION_LIMITS.maxIdBytes);
  const graphBinding = readGraph(record["graphBinding"]);
  const steps = readPlanRevisionSteps(record["steps"]);
  const nodes = readPlanRevisionSet(record["affectedNodeIds"]);
  const criteria = readPlanRevisionSet(record["affectedCriterionIds"]);
  const recipes = readPlanRevisionSet(record["verificationRecipeRefs"]);
  if (!revisionId.ok) return revisionId; if (!parentRevisionId.ok) return parentRevisionId;
  if (!rejectionRef.ok) return rejectionRef; if (!authorRef.ok) return authorRef;
  if (!graphBinding.ok) return graphBinding; if (!steps.ok) return steps;
  if (!nodes.ok) return nodes; if (!criteria.ok) return criteria; if (!recipes.ok) return recipes;
  const approvalState = record["approvalState"];
  if (typeof approvalState !== "string"
    || !PLAN_REVISION_APPROVAL_STATES.includes(approvalState as PlanRevisionApprovalState)) {
    return malformed();
  }
  if (steps.value.length + nodes.value.length + criteria.value.length + recipes.value.length
    > PLAN_REVISION_LIMITS.maxAggregateEntries) return exceeded();
  const body = Object.freeze({ affectedCriterionIds: criteria.value, affectedNodeIds: nodes.value,
    approvalState: approvalState as PlanRevisionApprovalState, authorRef: authorRef.value,
    graphBinding: graphBinding.value, parentRevisionId: parentRevisionId.value,
    rejectionRef: rejectionRef.value, revisionId: revisionId.value, steps: steps.value,
    verificationRecipeRefs: recipes.value });
  if (!full) return success({ body });
  return validHex64(record["planHash"])
    ? success({ body, planHash: record["planHash"] }) : malformed();
}

export function admitPlanRevisionDraft(value: unknown): PlanRevisionDraftAdmission {
  const parsed = parsePlan(value, false);
  return parsed.ok
    ? Object.freeze({ draft: deepFreeze({ ...parsed.value.body }), ok: true as const })
    : parsed;
}

export function admitPlanRevision(value: unknown): PlanRevisionAdmission {
  const parsed = parsePlan(value, true);
  if (!parsed.ok) return parsed;
  return Object.freeze({ ok: true as const, revision: deepFreeze({ ...parsed.value.body,
    planHash: parsed.value.planHash!, version: PLAN_REVISION_VERSION }) });
}
