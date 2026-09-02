import { isProxy } from "node:util/types";

import { PRODUCT_CONTRACT_V2_BUDGET_KINDS } from "@moe/core";

import {
  PLANNER_ADMISSION_PROFILE_LIMITS,
  plannerAdmissionProfileRefusal,
  type PlannerAdmissionProfileAuthority,
  type PlannerAdmissionProfileMappingExpectation,
  type PlannerAdmissionProfileMappingResult,
  type PlannerAdmissionProfileRefusal,
  type PlannerAdmissionProfileRevision,
  type PlannerAdmissionProfileSourceBudget,
} from "./planner-admission-profile-contract.js";
import {
  decodePlannerAdmissionProfileRevisionBytes,
  encodePlannerAdmissionProfileRevision,
} from "./planner-admission-profile-codec.js";
import {
  plannerAdmissionProfileBudgetBinding,
  plannerAdmissionProfileHex64,
  plannerAdmissionProfilePositive,
  plannerAdmissionProfileText,
} from "./planner-admission-profile-fields.js";
import { exact, snapshotCompilerInput } from "./snapshot.js";

const EXPECTATION_KEYS = Object.freeze([
  "authorityKind", "budgetBindingDigest", "budgetBindings", "contractBinding", "graphId",
  "graphSnapshotIdentity", "nodeIntentDigest", "nodeKey", "policyRevision",
]);
const CONTRACT_KEYS = Object.freeze(["contractId", "revisionDigest", "revisionId"]);
const BUDGET_KEYS = Object.freeze(["budgetId", "kind", "limit", "unit"]);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const refuse = (
  code: Parameters<typeof plannerAdmissionProfileRefusal>[0],
  layer: Parameters<typeof plannerAdmissionProfileRefusal>[1],
): PlannerAdmissionProfileRefusal => plannerAdmissionProfileRefusal(code, layer);

function expectationRosterExceedsLimit(value: unknown): boolean {
  if (value === null || typeof value !== "object" || isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, "budgetBindings");
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return false;
    const rows = descriptor.value;
    if (rows === null || typeof rows !== "object" || isProxy(rows) || !Array.isArray(rows)
      || Object.getPrototypeOf(rows) !== Array.prototype) return false;
    return rows.length > PLANNER_ADMISSION_PROFILE_LIMITS.maxAllocations;
  } catch {
    return false;
  }
}

function sameContract(
  left: PlannerAdmissionProfileRevision["contractBinding"], value: unknown,
): boolean {
  return exact(value, CONTRACT_KEYS) && value["contractId"] === left.contractId
    && value["revisionDigest"] === left.revisionDigest
    && value["revisionId"] === left.revisionId;
}

function readBudget(value: unknown): PlannerAdmissionProfileSourceBudget | undefined {
  if (!exact(value, BUDGET_KEYS) || !plannerAdmissionProfileText(value["budgetId"])
    || !plannerAdmissionProfileText(value["unit"])
    || !plannerAdmissionProfilePositive(value["limit"])
    || !(PRODUCT_CONTRACT_V2_BUDGET_KINDS as readonly unknown[]).includes(value["kind"])) {
    return undefined;
  }
  return Object.freeze({ budgetId: value["budgetId"], kind: value["kind"] as never,
    limit: value["limit"], unit: value["unit"] });
}

function readExpectation(value: unknown):
  | Readonly<{ expectation: PlannerAdmissionProfileMappingExpectation; ok: true }>
  | PlannerAdmissionProfileRefusal {
  if (expectationRosterExceedsLimit(value)) return refuse(
    "PLANNER_ADMISSION_PROFILE_LIMIT_EXCEEDED", "PLANNER_ADMISSION_PROFILE_LIMITS",
  );
  const snapshot = snapshotCompilerInput(value);
  if (!snapshot.ok) return refuse(
    "PLANNER_ADMISSION_PROFILE_BINDING_MISMATCH", "PLANNER_ADMISSION_PROFILE_BINDING",
  );
  const source = snapshot.value;
  if (!exact(source, EXPECTATION_KEYS)
    || (source["authorityKind"] !== "BUILDER" && source["authorityKind"] !== "VERIFIER")
    || !Array.isArray(source["budgetBindings"])) return refuse(
    "PLANNER_ADMISSION_PROFILE_BINDING_MISMATCH", "PLANNER_ADMISSION_PROFILE_BINDING",
  );
  if (source["budgetBindings"].length > PLANNER_ADMISSION_PROFILE_LIMITS.maxAllocations) {
    return refuse("PLANNER_ADMISSION_PROFILE_LIMIT_EXCEEDED",
      "PLANNER_ADMISSION_PROFILE_LIMITS");
  }
  const contract = source["contractBinding"];
  if (!exact(contract, CONTRACT_KEYS)
    || !plannerAdmissionProfileText(contract["contractId"])
    || !plannerAdmissionProfileHex64(contract["revisionDigest"])
    || !plannerAdmissionProfileText(contract["revisionId"])
    || !plannerAdmissionProfileBudgetBinding(source["budgetBindingDigest"])
    || !plannerAdmissionProfileText(source["graphId"])
    || !plannerAdmissionProfileHex64(source["graphSnapshotIdentity"])
    || !plannerAdmissionProfileHex64(source["nodeIntentDigest"])
    || !plannerAdmissionProfileText(source["nodeKey"])
    || !plannerAdmissionProfileHex64(source["policyRevision"])) return refuse(
    "PLANNER_ADMISSION_PROFILE_BINDING_MISMATCH", "PLANNER_ADMISSION_PROFILE_BINDING",
  );
  const budgetBindings: PlannerAdmissionProfileSourceBudget[] = [];
  for (const candidate of source["budgetBindings"]) {
    const budget = readBudget(candidate);
    if (budget === undefined) return refuse(
      "PLANNER_ADMISSION_PROFILE_BINDING_MISMATCH", "PLANNER_ADMISSION_PROFILE_BINDING",
    );
    budgetBindings.push(budget);
  }
  budgetBindings.sort((left, right) => compare(left.budgetId, right.budgetId));
  if (new Set(budgetBindings.map((item) => item.budgetId)).size !== budgetBindings.length) {
    return refuse("PLANNER_ADMISSION_PROFILE_MAPPING_AMBIGUOUS",
      "PLANNER_ADMISSION_PROFILE_MAPPING");
  }
  return Object.freeze({ expectation: Object.freeze({
    authorityKind: source["authorityKind"],
    budgetBindingDigest: source["budgetBindingDigest"] as string,
    budgetBindings: Object.freeze(budgetBindings),
    contractBinding: Object.freeze({ contractId: contract["contractId"] as string,
      revisionDigest: contract["revisionDigest"] as string,
      revisionId: contract["revisionId"] as string }),
    graphId: source["graphId"] as string,
    graphSnapshotIdentity: source["graphSnapshotIdentity"] as string,
    nodeIntentDigest: source["nodeIntentDigest"] as string,
    nodeKey: source["nodeKey"] as string,
    policyRevision: source["policyRevision"] as string,
  }), ok: true as const });
}

function sameBudget(left: PlannerAdmissionProfileSourceBudget,
  right: PlannerAdmissionProfileSourceBudget): boolean {
  return left.budgetId === right.budgetId && left.kind === right.kind
    && left.limit === right.limit && left.unit === right.unit;
}

function aggregateAmounts(revision: PlannerAdmissionProfileRevision):
  | Readonly<{ amounts: PlannerAdmissionProfileAuthority["admissionAmounts"]; ok: true }>
  | PlannerAdmissionProfileRefusal {
  const aggregate = new Map<string, Readonly<{ meter: string; purpose: string; quantity: bigint }>>();
  for (const allocation of revision.budgetAllocations) {
    for (const quantity of allocation.purposeQuantities) {
      const key = `${quantity.purpose}\0${allocation.conversion.targetMeter}`;
      const previous = aggregate.get(key);
      const next = (previous?.quantity ?? 0n) + BigInt(quantity.quantity);
      if (next > MAX_SAFE) return refuse(
        "PLANNER_ADMISSION_PROFILE_MAPPING_OVERFLOW", "PLANNER_ADMISSION_PROFILE_MAPPING",
      );
      aggregate.set(key, Object.freeze({ meter: allocation.conversion.targetMeter,
        purpose: quantity.purpose, quantity: next }));
    }
  }
  const amounts = Object.freeze([...aggregate.entries()]
    .sort(([left], [right]) => compare(left, right))
    .map(([, item]) => Object.freeze({ meter: item.meter as never,
      purpose: item.purpose as never, quantity: Number(item.quantity) })));
  return Object.freeze({ amounts, ok: true as const });
}

export function mapPlannerAdmissionProfileRevision(
  value: unknown, expectedValue: unknown,
): PlannerAdmissionProfileMappingResult {
  const encoded = encodePlannerAdmissionProfileRevision(value); if (!encoded.ok) return encoded;
  const decoded = decodePlannerAdmissionProfileRevisionBytes(encoded.bytes);
  if (!decoded.ok) return decoded;
  const revision = decoded.revision;
  const admittedExpected = readExpectation(expectedValue); if (!admittedExpected.ok) return admittedExpected;
  const expected = admittedExpected.expectation;
  if (!sameContract(revision.contractBinding, expected.contractBinding)
    || revision.graphId !== expected.graphId || revision.nodeKey !== expected.nodeKey
    || revision.authorityKind !== expected.authorityKind
    || revision.policyRevision !== expected.policyRevision
    || revision.budgetBindingDigest !== expected.budgetBindingDigest
    || revision.graphSnapshotIdentity !== expected.graphSnapshotIdentity
    || revision.nodeIntentDigest !== expected.nodeIntentDigest) return refuse(
    "PLANNER_ADMISSION_PROFILE_BINDING_MISMATCH", "PLANNER_ADMISSION_PROFILE_BINDING",
  );
  const expectedById = new Map(expected.budgetBindings.map((budget) => [budget.budgetId, budget]));
  if (expectedById.size !== revision.budgetAllocations.length) return refuse(
    "PLANNER_ADMISSION_PROFILE_MAPPING_ABSENT", "PLANNER_ADMISSION_PROFILE_MAPPING",
  );
  for (const allocation of revision.budgetAllocations) {
    const expectedBudget = expectedById.get(allocation.sourceBudget.budgetId);
    if (expectedBudget === undefined) return refuse(
      "PLANNER_ADMISSION_PROFILE_MAPPING_ABSENT", "PLANNER_ADMISSION_PROFILE_MAPPING",
    );
    if (!sameBudget(allocation.sourceBudget, expectedBudget)) return refuse(
      "PLANNER_ADMISSION_PROFILE_BINDING_MISMATCH", "PLANNER_ADMISSION_PROFILE_BINDING",
    );
  }
  const aggregated = aggregateAmounts(revision); if (!aggregated.ok) return aggregated;
  return Object.freeze({ authority: Object.freeze({ admissionAmounts: aggregated.amounts,
    admissionGatePolicy: revision.admissionGatePolicy }), ok: true as const,
    profileBinding: Object.freeze({ nodeKey: revision.nodeKey, profileId: revision.profileId,
      revisionDigest: revision.revisionDigest, revisionId: revision.revisionId,
      version: revision.version }) });
}
