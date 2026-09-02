import { isProxy } from "node:util/types";
import { derivePolicySliceDigest } from "@moe/core";
import type { JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { stateOf, versionOf } from "../bootstrap/bootstrap-ledger.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { installedSlices } from "../bootstrap/bootstrap-policy-services.js";
import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";

export interface StableRunPolicySelection {
  readonly fence: Readonly<{ readonly aggregateId: string; readonly expectedVersion: number }>;
  readonly slice: JsonValue;
  readonly sliceRef: string;
}

export type StableRunPolicySelectionResult =
  | Readonly<{ ok: true; selection: StableRunPolicySelection }>
  | Readonly<{ ok: false; reason: "ABSENT" | "VERSION_DRIFT" }>;

function isInertJson(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || isProxy(value) || seen.has(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return false;
    } else if (prototype !== Object.prototype && prototype !== null) return false;
    seen.add(value);
    const keys = Reflect.ownKeys(value);
    const length = Array.isArray(value)
      ? Reflect.getOwnPropertyDescriptor(value, "length")?.value as unknown : null;
    if (Array.isArray(value) && (!Number.isSafeInteger(length) || (length as number) < 0
      || keys.length !== (length as number) + 1)) return false;
    for (const key of keys) {
      if (key === "length" && Array.isArray(value)) continue;
      if (typeof key !== "string") return false;
      if (Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/u.test(key)) return false;
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
        || !isInertJson(descriptor.value, seen)) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    seen.delete(value);
  }
}

function exactOwnData(value: object, keys: readonly string[]): boolean {
  try {
    return Reflect.ownKeys(value).length === keys.length && keys.every((key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

/** Re-admits a captured selection before direct evaluation can treat it as durable authority. */
export function admitStableRunPolicySelection(
  value: unknown, projectId: string,
): StableRunPolicySelection | null {
  if (!isInertJson(value) || value === null || typeof value !== "object"
    || !exactOwnData(value, ["fence", "slice", "sliceRef"])) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const fence = record["fence"];
  const slice = record["slice"];
  const sliceRef = record["sliceRef"];
  if (fence === null || typeof fence !== "object"
    || !exactOwnData(fence, ["aggregateId", "expectedVersion"])
    || typeof sliceRef !== "string") return null;
  const stableFence = fence as Readonly<Record<string, unknown>>;
  const expectedVersion = stableFence["expectedVersion"];
  const aggregateId = stableFence["aggregateId"];
  const digest = derivePolicySliceDigest(slice);
  if (aggregateId !== policyAggregateId(projectId)
    || !Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0
    || !digest.ok || digest.digest !== sliceRef
    || slice === null || typeof slice !== "object" || Array.isArray(slice)
    || (slice as Readonly<Record<string, unknown>>)["sliceRef"] !== sliceRef) return null;
  return Object.freeze({
    fence: Object.freeze({ aggregateId, expectedVersion }) as StableRunPolicySelection["fence"],
    slice: slice as JsonValue,
    sliceRef,
  });
}

function installedEvaluationSlice(
  ledger: DurableLedger, projectId: string,
): Readonly<{ slice: JsonValue; sliceRef: string }> | null {
  const installed = installedSlices(stateOf(ledger, policyAggregateId(projectId)));
  let selected: Readonly<{ slice: JsonValue; sliceRef: string }> | null = null;
  for (const [sliceRef, slice] of Object.entries(installed)) {
    const digest = derivePolicySliceDigest(slice);
    if (digest.ok && digest.digest === sliceRef) selected = { slice, sliceRef };
  }
  return selected;
}

/** Captures one selection only when both store observations equal the ledger's exact version. */
export function captureStableRunPolicySelection(
  store: Pick<SqliteEventStore, "getAggregateVersion">,
  ledger: DurableLedger,
  projectId: string,
): StableRunPolicySelectionResult {
  const aggregateId = policyAggregateId(projectId);
  try {
    const before = store.getAggregateVersion(aggregateId);
    const selected = installedEvaluationSlice(ledger, projectId);
    const after = store.getAggregateVersion(aggregateId);
    if (!Number.isSafeInteger(before) || before < 0 || before !== after
      || versionOf(ledger, aggregateId) !== before) {
      return Object.freeze({ ok: false as const, reason: "VERSION_DRIFT" as const });
    }
    if (selected === null) {
      return Object.freeze({ ok: false as const, reason: "ABSENT" as const });
    }
    return Object.freeze({
      ok: true as const,
      selection: Object.freeze({
        fence: Object.freeze({ aggregateId, expectedVersion: before }),
        slice: selected.slice,
        sliceRef: selected.sliceRef,
      }),
    });
  } catch {
    return Object.freeze({ ok: false as const, reason: "VERSION_DRIFT" as const });
  }
}
