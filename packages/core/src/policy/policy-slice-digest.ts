import { createHash } from "node:crypto";

import type { PolicySlice } from "./policy-contract.js";
import { deepFreeze, snapshotData, validSlice } from "./policy-validation.js";

export const POLICY_SLICE_DIGEST_VERSION = "moe.policy.slice.content.v1" as const;
export const POLICY_SLICE_DIGEST_CODES = Object.freeze(["POLICY_SLICE_INVALID"] as const);
export const POLICY_SLICE_DIGEST_LAYERS = Object.freeze(["POLICY_SLICE_CODEC"] as const);

export type PolicySliceDigestCode = (typeof POLICY_SLICE_DIGEST_CODES)[number];
export type PolicySliceDigestLayer = (typeof POLICY_SLICE_DIGEST_LAYERS)[number];

export interface PolicySliceDigestAcceptedResult {
  readonly digest: string;
  readonly ok: true;
}

export interface PolicySliceDigestRefusal {
  readonly code: PolicySliceDigestCode;
  readonly layer: PolicySliceDigestLayer;
  readonly ok: false;
}

export type PolicySliceDigestResult =
  | PolicySliceDigestAcceptedResult
  | PolicySliceDigestRefusal;

const REFUSAL: PolicySliceDigestRefusal = Object.freeze({
  code: "POLICY_SLICE_INVALID",
  layer: "POLICY_SLICE_CODEC",
  ok: false,
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number"
    || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/**
 * The digested material. An ABSENT or EMPTY classification table is omitted entirely, so every
 * slice authored before the vocabulary existed keeps its v1 identity byte for byte. A NONEMPTY
 * table enters under the SAME v1 domain, sorted by fact id so entry order cannot spell one table
 * two ways; `validSlice` has already proven the ids unique, so that sort is total.
 */
function sliceMaterial(slice: PolicySlice): Readonly<Record<string, unknown>> {
  const material: Record<string, unknown> = {
    autoApprovalOptIns: slice.autoApprovalOptIns,
    rules: slice.rules,
  };
  const classifications = slice.riskClassifications ?? [];
  if (classifications.length > 0) {
    material["riskClassifications"] = [...classifications]
      .sort((left, right) => left.factId < right.factId ? -1 : 1);
  }
  return material;
}

/**
 * Derives the content identity for one exact policy slice. `sliceRef` is deliberately excluded:
 * the caller must set it to the returned digest, so including it would create a hash fixed point.
 */
export function derivePolicySliceDigest(value: unknown): PolicySliceDigestResult {
  try {
    const snapshot = snapshotData(value);
    if (!snapshot.ok || !validSlice(snapshot.value)) return REFUSAL;
    const body = canonicalJson(sliceMaterial(snapshot.value));
    const digest = createHash("sha256")
      .update(POLICY_SLICE_DIGEST_VERSION, "utf8")
      .update(Uint8Array.of(0))
      .update(body, "utf8")
      .digest("hex");
    return deepFreeze({ digest, ok: true as const });
  } catch {
    return REFUSAL;
  }
}
