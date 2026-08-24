import { createHash } from "node:crypto";

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
 * Derives the content identity for one exact policy slice. `sliceRef` is deliberately excluded:
 * the caller must set it to the returned digest, so including it would create a hash fixed point.
 */
export function derivePolicySliceDigest(value: unknown): PolicySliceDigestResult {
  try {
    const snapshot = snapshotData(value);
    if (!snapshot.ok || !validSlice(snapshot.value)) return REFUSAL;
    const body = canonicalJson({
      autoApprovalOptIns: snapshot.value.autoApprovalOptIns,
      rules: snapshot.value.rules,
    });
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
