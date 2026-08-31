import { createHash } from "node:crypto";

import {
  PLAN_REVISION_LIMITS, PLAN_REVISION_VERSION, planRevisionRefusal,
  readPlanRevisionSet, readPlanRevisionSteps,
} from "./plan-revision-contract.js";
import { planningContentHostility } from "./planning-content-hostile.js";
import { deepFreeze, exact, snapshotData } from "./planning-snapshot.js";
import type {
  PlanRevisionRefusal, PlanRevisionStep,
} from "./plan-revision-contract.js";

export const PLAN_EXECUTION_CONTENT_DOMAIN = "@moe/core.plan-execution-content/1" as const;
export interface PlanExecutionContentDraft {
  readonly affectedCriterionIds: readonly string[];
  readonly affectedNodeIds: readonly string[];
  readonly steps: readonly PlanRevisionStep[];
  readonly verificationRecipeRefs: readonly string[];
}
export interface PlanExecutionContent extends PlanExecutionContentDraft {
  readonly version: typeof PLAN_REVISION_VERSION;
}
export type PlanExecutionContentCreateResult =
  | Readonly<{ content: PlanExecutionContent; ok: true; planExecutionContentDigest: string }>
  | PlanRevisionRefusal;

const DRAFT_KEYS = Object.freeze([
  "affectedCriterionIds", "affectedNodeIds", "steps", "verificationRecipeRefs",
]);
const CONTENT_KEYS = Object.freeze([...DRAFT_KEYS, "version"]);
const encoder = new TextEncoder();

function canonicalText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalText(record[key])}`,
    ).join(",")}}`;
  }
  throw new TypeError("plan execution content received an unadmitted value");
}

const malformed = (): PlanRevisionRefusal =>
  planRevisionRefusal("PLAN_REVISION_MALFORMED", "PLAN_REVISION_ADMISSION");
const exceeded = (): PlanRevisionRefusal =>
  planRevisionRefusal("PLAN_REVISION_LIMIT_EXCEEDED", "PLAN_REVISION_LIMITS");

function digestOf(content: PlanExecutionContent): string {
  return createHash("sha256")
    .update(PLAN_EXECUTION_CONTENT_DOMAIN, "utf8")
    .update(Uint8Array.of(0))
    .update(encoder.encode(canonicalText(content)))
    .digest("hex");
}

/** Admits only the content that may exist before the target graph is hashed. */
export function createPlanExecutionContent(input: unknown): PlanExecutionContentCreateResult {
  const hostile = planningContentHostility(input, PLAN_REVISION_LIMITS.maxAggregateEntries);
  if (hostile !== null) return hostile === "LIMIT_EXCEEDED" ? exceeded() : malformed();
  const snapshot = snapshotData(input);
  if (!snapshot.ok) return malformed();
  const full = exact(snapshot.value, CONTENT_KEYS);
  if (!full && !exact(snapshot.value, DRAFT_KEYS)) return malformed();
  const record = snapshot.value;
  if (full && record["version"] !== PLAN_REVISION_VERSION) {
    return planRevisionRefusal("PLAN_REVISION_VERSION_UNSUPPORTED", "PLAN_REVISION_VERSION");
  }
  const criteria = readPlanRevisionSet(record["affectedCriterionIds"]);
  const nodes = readPlanRevisionSet(record["affectedNodeIds"]);
  const steps = readPlanRevisionSteps(record["steps"]);
  const recipes = readPlanRevisionSet(record["verificationRecipeRefs"]);
  if (!criteria.ok) return criteria; if (!nodes.ok) return nodes;
  if (!steps.ok) return steps; if (!recipes.ok) return recipes;
  if (criteria.value.length + nodes.value.length + steps.value.length + recipes.value.length
    > PLAN_REVISION_LIMITS.maxAggregateEntries) return exceeded();
  const content = deepFreeze<PlanExecutionContent>({
    affectedCriterionIds: criteria.value, affectedNodeIds: nodes.value, steps: steps.value,
    verificationRecipeRefs: recipes.value, version: PLAN_REVISION_VERSION,
  });
  if (encoder.encode(canonicalText(content)).byteLength > PLAN_REVISION_LIMITS.maxBytes) {
    return exceeded();
  }
  return Object.freeze({ content, ok: true as const,
    planExecutionContentDigest: digestOf(content) });
}
