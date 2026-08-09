/** Pure, inert graph-supersession decision data. Authority is applied only by the consumer. */
import { createHash } from "node:crypto";

import { evaluateCarryForward } from "../policy/approval-invalidation.js";
import type { CarryForwardInput } from "../policy/approval-contract.js";
import { deepFreeze, exact, snapshotData, validHex64 } from "../policy/policy-validation.js";

export const SUPERSESSION_DISPOSITION_KINDS = Object.freeze([
  "ADD", "CARRY", "REQUALIFY", "REEXECUTE", "CHANGE", "REMOVE",
] as const);
export type SupersessionDispositionKind = typeof SUPERSESSION_DISPOSITION_KINDS[number];
export const SUPERSESSION_KERNEL_LAYER = "SUPERSESSION_KERNEL" as const;

export interface SupersessionPredecessorBinding {
  readonly graphContentHash: string;
  readonly graphEpoch: number;
  readonly revisionId: string;
}
export interface SupersessionSuccessorBinding extends SupersessionPredecessorBinding {
  readonly predecessorGraphContentHash: string;
  readonly predecessorRevisionId: string;
}
export interface SupersessionSafeCarry {
  readonly authority: CarryForwardInput;
  readonly inputBinding: CarryForwardInput;
}
export interface SupersessionDisposition {
  readonly kind: SupersessionDispositionKind;
  readonly nodeKey: string;
  readonly predecessorAuthorityHash: string | null;
  readonly safeCarry: SupersessionSafeCarry | null;
  readonly successorAuthorityHash: string | null;
}
export interface SupersessionInput {
  readonly dispositions: readonly SupersessionDisposition[];
  readonly expectedPredecessor: SupersessionPredecessorBinding;
  readonly successor: SupersessionSuccessorBinding;
  readonly supportedCanonicalizerVersions: readonly string[];
}
export interface SupersessionDecision {
  readonly authorityHash: string;
  readonly dispositions: readonly SupersessionDisposition[];
  readonly predecessor: SupersessionPredecessorBinding & { readonly lifecycle: "SUPERSEDED" };
  readonly successor: SupersessionSuccessorBinding & { readonly lifecycle: "ACTIVE" };
  readonly supportedCanonicalizerVersions: readonly string[];
}
export interface SupersessionAcceptedResult {
  readonly decision: SupersessionDecision;
  readonly ok: true;
}
export interface SupersessionRefusal {
  readonly code: "REVISION_REBOUND" | "SUPERSESSION_CONSEQUENCE_CHANGED";
  readonly layer: typeof SUPERSESSION_KERNEL_LAYER;
  readonly ok: false;
}
export type SupersessionResult = SupersessionAcceptedResult | SupersessionRefusal;
type StructuralDisposition = Omit<SupersessionDisposition, "safeCarry"> & {
  readonly safeCarry: unknown;
};
interface StructuralInput extends Omit<SupersessionInput, "dispositions"> {
  readonly dispositions: readonly StructuralDisposition[];
}
const BINDING_KEYS = ["revisionId", "graphContentHash", "graphEpoch"] as const;
const SUCCESSOR_KEYS = [
  ...BINDING_KEYS, "predecessorRevisionId", "predecessorGraphContentHash",
] as const;
const INPUT_KEYS = [
  "dispositions", "expectedPredecessor", "successor", "supportedCanonicalizerVersions",
] as const;
const DISPOSITION_KEYS = [
  "kind", "nodeKey", "predecessorAuthorityHash", "safeCarry", "successorAuthorityHash",
] as const;
const SAFE_CARRY_KEYS = ["authority", "inputBinding"] as const;
const CARRY_FACT_KEYS = [
  "canonicalizerVersion", "dependenciesPresent", "environmentClosureUnchanged",
  "policySliceUnchanged", "predecessorResultUnchanged", "sourceHash", "targetHash",
] as const;
const MAX_REF_LENGTH = 256;

const REBOUND = deepFreeze({
  code: "REVISION_REBOUND" as const, layer: SUPERSESSION_KERNEL_LAYER, ok: false as const,
});
const CONSEQUENCE_CHANGED = deepFreeze({
  code: "SUPERSESSION_CONSEQUENCE_CHANGED" as const,
  layer: SUPERSESSION_KERNEL_LAYER, ok: false as const,
});

function validRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_REF_LENGTH;
}

function validEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function binding(value: unknown): SupersessionPredecessorBinding | undefined {
  if (!exact(value, BINDING_KEYS) || !validRef(value["revisionId"]) ||
    !validHex64(value["graphContentHash"]) || !validEpoch(value["graphEpoch"])) return undefined;
  return value as unknown as SupersessionPredecessorBinding;
}

function successor(value: unknown): SupersessionSuccessorBinding | undefined {
  if (!exact(value, SUCCESSOR_KEYS) || binding({
    graphContentHash: value["graphContentHash"], graphEpoch: value["graphEpoch"],
    revisionId: value["revisionId"],
  }) === undefined || !validRef(value["predecessorRevisionId"]) ||
    !validHex64(value["predecessorGraphContentHash"])) return undefined;
  return value as unknown as SupersessionSuccessorBinding;
}

function validHashes(value: Readonly<Record<string, unknown>>): boolean {
  const before = value["predecessorAuthorityHash"];
  const after = value["successorAuthorityHash"];
  const oldHash = before === null || validHex64(before);
  const newHash = after === null || validHex64(after);
  if (!oldHash || !newHash) return false;
  switch (value["kind"]) {
    case "ADD": return before === null && after !== null;
    case "REMOVE": return before !== null && after === null;
    case "CHANGE": return before !== null && after !== null && before !== after;
    case "CARRY": case "REQUALIFY": case "REEXECUTE":
      return before !== null && before === after;
    default: return false;
  }
}

function disposition(value: unknown): StructuralDisposition | undefined {
  if (!exact(value, DISPOSITION_KEYS) || !validRef(value["nodeKey"]) ||
    !SUPERSESSION_DISPOSITION_KINDS.some((kind) => kind === value["kind"]) ||
    !validHashes(value) || (value["kind"] !== "CARRY" && value["safeCarry"] !== null)) {
    return undefined;
  }
  return value as unknown as StructuralDisposition;
}

function structuralInput(value: unknown): StructuralInput | undefined {
  const snapshot = snapshotData(value);
  if (!snapshot.ok || !exact(snapshot.value, INPUT_KEYS)) return undefined;
  const expected = binding(snapshot.value["expectedPredecessor"]);
  const next = successor(snapshot.value["successor"]);
  const entries = snapshot.value["dispositions"];
  const versions = snapshot.value["supportedCanonicalizerVersions"];
  if (!expected || !next || !Array.isArray(entries) || entries.length === 0 ||
    entries.length > 128 || !Array.isArray(versions) || versions.length === 0 ||
    versions.length > 32 || !versions.every(validRef) || new Set(versions).size !== versions.length) {
    return undefined;
  }
  const parsed = entries.map(disposition);
  if (parsed.some((entry) => entry === undefined)) return undefined;
  const normalized = parsed as StructuralDisposition[];
  if (new Set(normalized.map((entry) => entry.nodeKey)).size !== normalized.length) return undefined;
  return { dispositions: normalized, expectedPredecessor: expected, successor: next,
    supportedCanonicalizerVersions: versions };
}

function samePredecessor(
  current: SupersessionPredecessorBinding,
  expected: SupersessionPredecessorBinding,
): boolean {
  return current.revisionId === expected.revisionId && current.graphEpoch === expected.graphEpoch &&
    current.graphContentHash === expected.graphContentHash;
}

function monotonic(
  current: SupersessionPredecessorBinding,
  next: SupersessionSuccessorBinding,
): boolean {
  return current.graphEpoch < Number.MAX_SAFE_INTEGER && next.graphEpoch === current.graphEpoch + 1 &&
    next.revisionId !== current.revisionId && next.predecessorRevisionId === current.revisionId &&
    next.predecessorGraphContentHash === current.graphContentHash;
}

function validCarry(
  entry: StructuralDisposition,
  versions: readonly string[],
): SupersessionSafeCarry | undefined {
  if (!exact(entry.safeCarry, SAFE_CARRY_KEYS)) return undefined;
  const authority = entry.safeCarry["authority"];
  const inputBinding = entry.safeCarry["inputBinding"];
  const authorityVerdict = evaluateCarryForward(authority, versions);
  const inputVerdict = evaluateCarryForward(inputBinding, versions);
  if (!authorityVerdict.ok || !authorityVerdict.value.valid || !inputVerdict.ok ||
    !inputVerdict.value.valid || !exact(authority, CARRY_FACT_KEYS) ||
    !exact(inputBinding, CARRY_FACT_KEYS) ||
    authority["sourceHash"] !== entry.predecessorAuthorityHash ||
    authority["targetHash"] !== entry.successorAuthorityHash) return undefined;
  return { authority: authority as unknown as CarryForwardInput,
    inputBinding: inputBinding as unknown as CarryForwardInput };
}

function normalizedDispositions(candidate: StructuralInput): SupersessionDisposition[] | undefined {
  const normalized: SupersessionDisposition[] = [];
  for (const entry of [...candidate.dispositions].sort((left, right) =>
    left.nodeKey < right.nodeKey ? -1 : left.nodeKey > right.nodeKey ? 1 : 0)) {
    const safeCarry = entry.kind === "CARRY"
      ? validCarry(entry, candidate.supportedCanonicalizerVersions) : null;
    if (entry.kind === "CARRY" && safeCarry === undefined) return undefined;
    normalized.push({ ...entry, safeCarry: safeCarry ?? null });
  }
  return normalized;
}

function authorityHash(decision: Omit<SupersessionDecision, "authorityHash">): string {
  const digest = createHash("sha256");
  const frame = (label: string, raw: string | number | boolean | null): void => {
    const value = raw === null ? "<null>" : String(raw);
    const labelBytes = Buffer.from(label); const valueBytes = Buffer.from(value);
    digest.update(String(labelBytes.length)).update(":").update(labelBytes)
      .update(String(valueBytes.length)).update(":").update(valueBytes);
  };
  frame("domain", "@moe/core.supersession.authority/v1");
  for (const key of BINDING_KEYS) frame(`predecessor.${key}`, decision.predecessor[key]);
  frame("predecessor.lifecycle", decision.predecessor.lifecycle);
  for (const key of SUCCESSOR_KEYS) frame(`successor.${key}`, decision.successor[key]);
  frame("successor.lifecycle", decision.successor.lifecycle);
  frame("dispositions.count", decision.dispositions.length);
  decision.dispositions.forEach((entry, index) => {
    const prefix = `dispositions.${index}.`;
    for (const key of ["nodeKey", "kind", "predecessorAuthorityHash",
      "successorAuthorityHash"] as const) frame(`${prefix}${key}`, entry[key]);
    frame(`${prefix}safeCarry.present`, entry.safeCarry !== null);
    if (entry.safeCarry === null) return;
    for (const group of SAFE_CARRY_KEYS) for (const key of CARRY_FACT_KEYS) {
      frame(`${prefix}safeCarry.${group}.${key}`, entry.safeCarry[group][key]);
    }
  });
  frame("supportedCanonicalizerVersions.count", decision.supportedCanonicalizerVersions.length);
  decision.supportedCanonicalizerVersions.forEach((version, index) =>
    frame(`supportedCanonicalizerVersions.${index}`, version));
  return digest.digest("hex");
}

/** Decides only from frozen input facts; the consumer later applies the returned transition. */
export function decideSupersession(currentValue: unknown, inputValue: unknown): SupersessionResult {
  const currentSnapshot = snapshotData(currentValue);
  if (!currentSnapshot.ok) return REBOUND;
  const current = binding(currentSnapshot.value);
  const candidate = structuralInput(inputValue);
  if (!current || !candidate || !samePredecessor(current, candidate.expectedPredecessor) ||
    !monotonic(current, candidate.successor)) return REBOUND;
  const dispositions = normalizedDispositions(candidate);
  if (!dispositions) return CONSEQUENCE_CHANGED;
  const withoutHash = {
    dispositions, predecessor: { ...current, lifecycle: "SUPERSEDED" as const },
    successor: { ...candidate.successor, lifecycle: "ACTIVE" as const },
    supportedCanonicalizerVersions: [...candidate.supportedCanonicalizerVersions].sort(),
  };
  return deepFreeze({ decision: { ...withoutHash, authorityHash: authorityHash(withoutHash) },
    ok: true as const });
}
