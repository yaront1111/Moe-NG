import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";
import { PRODUCT_CONTRACT_V2_BUDGET_KINDS } from "@moe/core";
import {
  ADMISSION_PURPOSES, NODE_ADMISSION_GATE_POLICIES, NODE_ADMISSION_METERS,
  NODE_AUTHORITY_LIMITS,
} from "@moe/scheduler";

import {
  PLANNER_ADMISSION_PROFILE_DIGEST_DOMAIN,
  PLANNER_ADMISSION_PROFILE_LIMITS,
  PLANNER_ADMISSION_PROFILE_VERSION,
  plannerAdmissionProfileRefusal,
  type PlannerAdmissionProfileBudgetAllocation,
  type PlannerAdmissionProfileCreateResult,
  type PlannerAdmissionProfileDecodeResult,
  type PlannerAdmissionProfileEncodeResult,
  type PlannerAdmissionProfileRefusal,
  type PlannerAdmissionProfileRevision,
  type PlannerAdmissionProfileRevisionDraft,
} from "./planner-admission-profile-contract.js";
import {
  plannerAdmissionProfileBudgetBinding,
  plannerAdmissionProfileHex64,
  plannerAdmissionProfilePositive,
  plannerAdmissionProfileText,
} from "./planner-admission-profile-fields.js";
import { exact, record, snapshotCompilerInput } from "./snapshot.js";

const DRAFT_KEYS = Object.freeze([
  "admissionGatePolicy", "allocationDecisionRef", "allocationSemantics", "authorRef",
  "authorityKind", "budgetAllocations", "budgetBindingDigest", "contractBinding", "graphId",
  "graphSnapshotIdentity", "nodeIntentDigest", "nodeKey", "policyRevision", "profileId", "revisionId",
]);
const REVISION_KEYS = Object.freeze([...DRAFT_KEYS, "revisionDigest", "version"]);
const CONTRACT_KEYS = Object.freeze(["contractId", "revisionDigest", "revisionId"]);
const ALLOCATION_KEYS = Object.freeze(["conversion", "purposeQuantities", "sourceBudget"]);
const CONVERSION_KEYS = Object.freeze(["authorityRef", "denominator", "numerator", "targetMeter"]);
const PURPOSE_KEYS = Object.freeze(["purpose", "quantity"]);
const BUDGET_KEYS = Object.freeze(["budgetId", "kind", "limit", "unit"]);
const PROVIDER_PREFIX = "provider.";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayTag = Object.getOwnPropertyDescriptor(
  typedArrayPrototype, Symbol.toStringTag,
)?.get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype, "byteLength",
)?.get;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(
  typedArrayPrototype, "byteOffset",
)?.get;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype, "byteLength",
)?.get;
const arrayBufferResizable = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype, "resizable",
)?.get;
const arrayBufferDetached = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype, "detached",
)?.get;

type Read<T> = Readonly<{ ok: true; value: T }> | PlannerAdmissionProfileRefusal;
interface ParsedPurposeQuantity { readonly purpose: string; readonly quantity: number }
interface ParsedAllocation extends Omit<PlannerAdmissionProfileBudgetAllocation, "purposeQuantities"> {
  readonly purposeComplete: boolean;
  readonly purposeQuantities: readonly ParsedPurposeQuantity[];
}

const ok = <T>(value: T): Readonly<{ ok: true; value: T }> =>
  Object.freeze({ ok: true as const, value });
const refuse = (
  code: Parameters<typeof plannerAdmissionProfileRefusal>[0],
  layer: Parameters<typeof plannerAdmissionProfileRefusal>[1],
): PlannerAdmissionProfileRefusal => plannerAdmissionProfileRefusal(code, layer);
const malformed = (): PlannerAdmissionProfileRefusal =>
  refuse("PLANNER_ADMISSION_PROFILE_MALFORMED", "PLANNER_ADMISSION_PROFILE_ADMISSION");
const exceeded = (): PlannerAdmissionProfileRefusal =>
  refuse("PLANNER_ADMISSION_PROFILE_LIMIT_EXCEEDED", "PLANNER_ADMISSION_PROFILE_LIMITS");

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function canonicalText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  if (typeof value === "object") {
    const source = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(source).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalText(source[key])}`,
    ).join(",")}}`;
  }
  throw new TypeError("PlannerAdmissionProfile canonicalization received unadmitted data");
}

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function readContract(value: unknown): Read<PlannerAdmissionProfileRevisionDraft["contractBinding"]> {
  if (!exact(value, CONTRACT_KEYS) || !plannerAdmissionProfileText(value["contractId"])
    || !plannerAdmissionProfileHex64(value["revisionDigest"])
    || !plannerAdmissionProfileText(value["revisionId"])) return malformed();
  return ok(Object.freeze({ contractId: value["contractId"], revisionDigest: value["revisionDigest"],
    revisionId: value["revisionId"] }));
}

function readBudget(value: unknown): Read<PlannerAdmissionProfileBudgetAllocation["sourceBudget"]> {
  if (!exact(value, BUDGET_KEYS) || !plannerAdmissionProfileText(value["budgetId"])
    || !plannerAdmissionProfilePositive(value["limit"]) || !plannerAdmissionProfileText(value["unit"])
    || !(PRODUCT_CONTRACT_V2_BUDGET_KINDS as readonly unknown[]).includes(value["kind"])) {
    return malformed();
  }
  return ok(Object.freeze({ budgetId: value["budgetId"], kind: value["kind"] as never,
    limit: value["limit"], unit: value["unit"] }));
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left; let b = right;
  while (b !== 0n) { const remainder = a % b; a = b; b = remainder; }
  return a;
}

function readConversion(value: unknown): Read<PlannerAdmissionProfileBudgetAllocation["conversion"]> {
  if (!exact(value, CONVERSION_KEYS) || !plannerAdmissionProfileText(value["authorityRef"])
    || !plannerAdmissionProfilePositive(value["denominator"])
    || !plannerAdmissionProfilePositive(value["numerator"])
    || !(NODE_ADMISSION_METERS as readonly unknown[]).includes(value["targetMeter"])) {
    return malformed();
  }
  const divisor = Number(gcd(BigInt(value["numerator"]), BigInt(value["denominator"])));
  return ok(Object.freeze({ authorityRef: value["authorityRef"],
    denominator: value["denominator"] / divisor, numerator: value["numerator"] / divisor,
    targetMeter: value["targetMeter"] as never }));
}

function readPurposes(value: unknown): Read<Readonly<{
  complete: boolean; quantities: readonly ParsedPurposeQuantity[];
}>> {
  if (!Array.isArray(value)) return malformed();
  if (value.length > PLANNER_ADMISSION_PROFILE_LIMITS.maxPurposeQuantities) return exceeded();
  const quantities: ParsedPurposeQuantity[] = []; let rowsValid = true;
  for (const candidate of value) {
    if (!exact(candidate, PURPOSE_KEYS)
      || !(ADMISSION_PURPOSES as readonly unknown[]).includes(candidate["purpose"])
      || !plannerAdmissionProfilePositive(candidate["quantity"])) { rowsValid = false; continue; }
    quantities.push({ purpose: candidate["purpose"] as string, quantity: candidate["quantity"] });
  }
  quantities.sort((left, right) => compare(left.purpose, right.purpose));
  const names = quantities.map((item) => item.purpose);
  const expected = [...ADMISSION_PURPOSES].sort(compare);
  const complete = rowsValid && quantities.length === expected.length
    && names.every((name, index) => name === expected[index]);
  return ok(Object.freeze({ complete, quantities: Object.freeze(quantities) }));
}

function readAllocation(value: unknown): Read<ParsedAllocation> {
  if (!exact(value, ALLOCATION_KEYS)) return malformed();
  const conversion = readConversion(value["conversion"]); if (!conversion.ok) return conversion;
  const purposes = readPurposes(value["purposeQuantities"]); if (!purposes.ok) return purposes;
  const sourceBudget = readBudget(value["sourceBudget"]); if (!sourceBudget.ok) return sourceBudget;
  return ok(Object.freeze({ conversion: conversion.value, purposeComplete: purposes.value.complete,
    purposeQuantities: purposes.value.quantities, sourceBudget: sourceBudget.value }));
}

function readAllocations(value: unknown): Read<readonly ParsedAllocation[]> {
  if (!Array.isArray(value)) return malformed();
  if (value.length === 0) return refuse(
    "PLANNER_ADMISSION_PROFILE_MAPPING_ABSENT", "PLANNER_ADMISSION_PROFILE_MAPPING",
  );
  if (value.length > PLANNER_ADMISSION_PROFILE_LIMITS.maxAllocations) return exceeded();
  const allocations: ParsedAllocation[] = []; const errors: PlannerAdmissionProfileRefusal[] = [];
  for (const candidate of value) {
    const allocation = readAllocation(candidate);
    if (allocation.ok) allocations.push(allocation.value); else errors.push(allocation);
  }
  if (errors.some((error) => error.code === "PLANNER_ADMISSION_PROFILE_LIMIT_EXCEEDED")) {
    return exceeded();
  }
  if (errors.length > 0) return malformed();
  allocations.sort((left, right) => compare(left.sourceBudget.budgetId, right.sourceBudget.budgetId));
  return ok(Object.freeze(allocations));
}

function conversionParts(allocation: ParsedAllocation): Readonly<{
  denominator: bigint; product: bigint;
}> {
  const product = BigInt(allocation.sourceBudget.limit) * BigInt(allocation.conversion.numerator);
  const denominator = BigInt(allocation.conversion.denominator);
  return Object.freeze({ denominator, product });
}

function validateAllocations(
  allocations: readonly ParsedAllocation[], authorityKind: "BUILDER" | "VERIFIER",
): Read<readonly PlannerAdmissionProfileBudgetAllocation[]> {
  if (allocations.some((item) => item.sourceBudget.kind === "MONEY"
    || item.sourceBudget.kind === "TOKEN")) return refuse(
    "PLANNER_ADMISSION_PROFILE_BUDGET_KIND_UNSUPPORTED", "PLANNER_ADMISSION_PROFILE_MAPPING",
  );
  const budgetIds = allocations.map((item) => item.sourceBudget.budgetId);
  if (new Set(budgetIds).size !== budgetIds.length) return refuse(
    "PLANNER_ADMISSION_PROFILE_MAPPING_AMBIGUOUS", "PLANNER_ADMISSION_PROFILE_MAPPING",
  );
  if (allocations.some((item) => item.conversion.targetMeter.startsWith(PROVIDER_PREFIX))) {
    return refuse("PLANNER_ADMISSION_PROFILE_PROVIDER_METER_FORBIDDEN",
      "PLANNER_ADMISSION_PROFILE_MAPPING");
  }
  const timeMeter = authorityKind === "BUILDER"
    ? "runner.authorized_ms" : "verification.authorized_ms";
  if (allocations.some((item) => item.sourceBudget.kind === "TIME"
    ? item.conversion.targetMeter !== timeMeter
    : item.conversion.targetMeter !== "attempt.count")) return refuse(
    "PLANNER_ADMISSION_PROFILE_MAPPING_ABSENT", "PLANNER_ADMISSION_PROFILE_MAPPING",
  );
  const conversions = allocations.map(conversionParts);
  if (conversions.some(({ denominator, product }) => product % denominator !== 0n)) return refuse(
    "PLANNER_ADMISSION_PROFILE_MAPPING_NONINTEGRAL", "PLANNER_ADMISSION_PROFILE_MAPPING",
  );
  const totals = conversions.map(({ denominator, product }) => product / denominator);
  if (totals.some((total) => total > MAX_SAFE)) return refuse(
    "PLANNER_ADMISSION_PROFILE_MAPPING_OVERFLOW", "PLANNER_ADMISSION_PROFILE_MAPPING",
  );
  const aggregate = new Map<string, bigint>();
  for (const allocation of allocations) {
    for (const item of allocation.purposeQuantities) {
      const key = `${item.purpose}\0${allocation.conversion.targetMeter}`;
      const next = (aggregate.get(key) ?? 0n) + BigInt(item.quantity);
      if (next > MAX_SAFE) return refuse(
        "PLANNER_ADMISSION_PROFILE_MAPPING_OVERFLOW", "PLANNER_ADMISSION_PROFILE_MAPPING",
      );
      aggregate.set(key, next);
    }
  }
  if (aggregate.size > NODE_AUTHORITY_LIMITS.maxAdmissionAmounts) return exceeded();
  if (allocations.some((item) => !item.purposeComplete)) return refuse(
    "PLANNER_ADMISSION_PROFILE_ALLOCATION_INCOMPLETE", "PLANNER_ADMISSION_PROFILE_ALLOCATION",
  );
  const admitted: PlannerAdmissionProfileBudgetAllocation[] = [];
  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index]!;
    const sum = allocation.purposeQuantities.reduce(
      (total, item) => total + BigInt(item.quantity), 0n,
    );
    if (sum !== totals[index]) return refuse(
      "PLANNER_ADMISSION_PROFILE_ALLOCATION_TOTAL_MISMATCH",
      "PLANNER_ADMISSION_PROFILE_ALLOCATION",
    );
    admitted.push(Object.freeze({ conversion: allocation.conversion,
      purposeQuantities: Object.freeze(allocation.purposeQuantities.map((item) => Object.freeze({
        purpose: item.purpose as never, quantity: item.quantity,
      }))), sourceBudget: allocation.sourceBudget }));
  }
  return ok(Object.freeze(admitted));
}

function admitDraftSnapshot(value: unknown): Read<PlannerAdmissionProfileRevisionDraft> {
  if (!exact(value, DRAFT_KEYS)) return malformed();
  if (!(NODE_ADMISSION_GATE_POLICIES as readonly unknown[]).includes(value["admissionGatePolicy"])) {
    return refuse("PLANNER_ADMISSION_PROFILE_GATE_POLICY_INVALID",
      "PLANNER_ADMISSION_PROFILE_ADMISSION");
  }
  if (value["allocationSemantics"] !== "SINGLE_ADMISSION_FULL_ENVELOPE"
    || (value["authorityKind"] !== "BUILDER" && value["authorityKind"] !== "VERIFIER")) {
    return malformed();
  }
  const texts = ["allocationDecisionRef", "authorRef", "budgetBindingDigest", "graphId", "nodeKey",
    "profileId", "revisionId"] as const;
  if (texts.some((key) => !plannerAdmissionProfileText(value[key]))) return malformed();
  if (!plannerAdmissionProfileBudgetBinding(value["budgetBindingDigest"])) return malformed();
  if (!["graphSnapshotIdentity", "nodeIntentDigest", "policyRevision"].every(
    (key) => plannerAdmissionProfileHex64(value[key]),
  )) return malformed();
  const contractBinding = readContract(value["contractBinding"]); if (!contractBinding.ok) return contractBinding;
  const parsed = readAllocations(value["budgetAllocations"]); if (!parsed.ok) return parsed;
  const budgetAllocations = validateAllocations(parsed.value, value["authorityKind"]);
  if (!budgetAllocations.ok) return budgetAllocations;
  return ok(deepFreeze({ admissionGatePolicy: value["admissionGatePolicy"] as never,
    allocationDecisionRef: value["allocationDecisionRef"] as string,
    allocationSemantics: "SINGLE_ADMISSION_FULL_ENVELOPE" as const,
    authorRef: value["authorRef"] as string, authorityKind: value["authorityKind"],
    budgetAllocations: budgetAllocations.value,
    budgetBindingDigest: value["budgetBindingDigest"] as string,
    contractBinding: contractBinding.value, graphId: value["graphId"] as string,
    graphSnapshotIdentity: value["graphSnapshotIdentity"] as string,
    nodeIntentDigest: value["nodeIntentDigest"] as string, nodeKey: value["nodeKey"] as string,
    policyRevision: value["policyRevision"] as string, profileId: value["profileId"] as string,
    revisionId: value["revisionId"] as string }));
}

function admitDraft(value: unknown): Read<PlannerAdmissionProfileRevisionDraft> {
  const snapshot = snapshotCompilerInput(value);
  return snapshot.ok ? admitDraftSnapshot(snapshot.value) : malformed();
}

function admitRevision(value: unknown): Read<PlannerAdmissionProfileRevision> {
  const snapshot = snapshotCompilerInput(value); if (!snapshot.ok) return malformed();
  const source = record(snapshot.value);
  if (source !== undefined && Object.hasOwn(source, "version")
    && source["version"] !== PLANNER_ADMISSION_PROFILE_VERSION) return refuse(
    "PLANNER_ADMISSION_PROFILE_VERSION_UNSUPPORTED", "PLANNER_ADMISSION_PROFILE_VERSION",
  );
  if (!exact(snapshot.value, REVISION_KEYS)
    || !plannerAdmissionProfileHex64(snapshot.value["revisionDigest"])) {
    return malformed();
  }
  const draftValue: Record<string, unknown> = {};
  for (const key of DRAFT_KEYS) draftValue[key] = snapshot.value[key];
  const draft = admitDraftSnapshot(draftValue); if (!draft.ok) return draft;
  return ok(revisionOf(draft.value, snapshot.value["revisionDigest"]));
}

function digestOf(revision: PlannerAdmissionProfileRevision): string {
  const { revisionDigest: _digest, ...source } = revision;
  return createHash("sha256").update(PLANNER_ADMISSION_PROFILE_DIGEST_DOMAIN, "utf8")
    .update(Uint8Array.of(0)).update(encoder.encode(canonicalText(source))).digest("hex");
}

function revisionOf(
  draft: PlannerAdmissionProfileRevisionDraft, revisionDigest: string,
): PlannerAdmissionProfileRevision {
  return deepFreeze({ admissionGatePolicy: draft.admissionGatePolicy,
    allocationDecisionRef: draft.allocationDecisionRef,
    allocationSemantics: draft.allocationSemantics, authorRef: draft.authorRef,
    authorityKind: draft.authorityKind, budgetAllocations: draft.budgetAllocations,
    budgetBindingDigest: draft.budgetBindingDigest, contractBinding: draft.contractBinding,
    graphId: draft.graphId, graphSnapshotIdentity: draft.graphSnapshotIdentity,
    nodeIntentDigest: draft.nodeIntentDigest, nodeKey: draft.nodeKey,
    policyRevision: draft.policyRevision, profileId: draft.profileId, revisionDigest,
    revisionId: draft.revisionId, version: PLANNER_ADMISSION_PROFILE_VERSION });
}

function canonicalBytes(revision: PlannerAdmissionProfileRevision): PlannerAdmissionProfileEncodeResult {
  const bytes = encoder.encode(canonicalText(revision));
  return bytes.byteLength > PLANNER_ADMISSION_PROFILE_LIMITS.maxBytes
    ? exceeded() : Object.freeze({ bytes, ok: true as const });
}

export function createPlannerAdmissionProfileRevision(value: unknown): PlannerAdmissionProfileCreateResult {
  const draft = admitDraft(value); if (!draft.ok) return draft;
  const provisional = revisionOf(draft.value, "0".repeat(64));
  const revision = revisionOf(draft.value, digestOf(provisional));
  const bounded = canonicalBytes(revision);
  return bounded.ok ? Object.freeze({ ok: true as const, revision }) : bounded;
}

export function encodePlannerAdmissionProfileRevision(value: unknown): PlannerAdmissionProfileEncodeResult {
  const admitted = admitRevision(value); if (!admitted.ok) return admitted;
  if (digestOf(admitted.value) !== admitted.value.revisionDigest) return refuse(
    "PLANNER_ADMISSION_PROFILE_DIGEST_MISMATCH", "PLANNER_ADMISSION_PROFILE_DIGEST",
  );
  return canonicalBytes(admitted.value);
}

function decodeRefusal(code: string): PlannerAdmissionProfileRefusal {
  if (code === "JSON_DUPLICATE_KEY") return refuse(
    "PLANNER_ADMISSION_PROFILE_DUPLICATE_KEY", "PLANNER_ADMISSION_PROFILE_CODEC",
  );
  if (code === "JSON_BODY_LIMIT_EXCEEDED" || code === "JSON_DEPTH_LIMIT_EXCEEDED"
    || code === "JSON_STRING_LIMIT_EXCEEDED") return exceeded();
  return refuse("PLANNER_ADMISSION_PROFILE_BYTES_INVALID", "PLANNER_ADMISSION_PROFILE_CODEC");
}

function snapshotProfileBytes(value: unknown): Read<Uint8Array> {
  if (!typedArrayTag || !typedArrayBuffer || !typedArrayByteLength
    || !typedArrayByteOffset || !arrayBufferByteLength) return refuse(
    "PLANNER_ADMISSION_PROFILE_BYTES_INVALID", "PLANNER_ADMISSION_PROFILE_CODEC",
  );
  try {
    if (Reflect.apply(typedArrayTag, value, []) !== "Uint8Array") return refuse(
      "PLANNER_ADMISSION_PROFILE_BYTES_INVALID", "PLANNER_ADMISSION_PROFILE_CODEC",
    );
    const buffer = Reflect.apply(typedArrayBuffer, value, []) as ArrayBufferLike;
    Reflect.apply(arrayBufferByteLength, buffer, []);
    if (arrayBufferResizable && Reflect.apply(arrayBufferResizable, buffer, []) === true) {
      return refuse("PLANNER_ADMISSION_PROFILE_BYTES_INVALID", "PLANNER_ADMISSION_PROFILE_CODEC");
    }
    if (arrayBufferDetached && Reflect.apply(arrayBufferDetached, buffer, []) === true) {
      return refuse("PLANNER_ADMISSION_PROFILE_BYTES_INVALID", "PLANNER_ADMISSION_PROFILE_CODEC");
    }
    const byteLength = Reflect.apply(typedArrayByteLength, value, []) as number;
    if (byteLength > PLANNER_ADMISSION_PROFILE_LIMITS.maxBytes) return exceeded();
    const byteOffset = Reflect.apply(typedArrayByteOffset, value, []) as number;
    const source = new Uint8Array(buffer, byteOffset, byteLength);
    const snapshot = new Uint8Array(byteLength); snapshot.set(source);
    return ok(snapshot);
  } catch {
    return refuse("PLANNER_ADMISSION_PROFILE_BYTES_INVALID", "PLANNER_ADMISSION_PROFILE_CODEC");
  }
}

export function decodePlannerAdmissionProfileRevisionBytes(
  value: unknown,
): PlannerAdmissionProfileDecodeResult {
  const captured = snapshotProfileBytes(value); if (!captured.ok) return captured;
  const source = captured.value;
  const decoded = decodeBoundedJsonBytes(source); if (!decoded.ok) return decodeRefusal(decoded.code);
  const admitted = admitRevision(decoded.value); if (!admitted.ok) return admitted;
  if (digestOf(admitted.value) !== admitted.value.revisionDigest) return refuse(
    "PLANNER_ADMISSION_PROFILE_DIGEST_MISMATCH", "PLANNER_ADMISSION_PROFILE_DIGEST",
  );
  if (canonicalText(admitted.value) !== decoder.decode(source)) return refuse(
    "PLANNER_ADMISSION_PROFILE_NONCANONICAL", "PLANNER_ADMISSION_PROFILE_CANONICALIZATION",
  );
  return Object.freeze({ ok: true as const, revision: admitted.value });
}
