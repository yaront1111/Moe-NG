import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";

import { createPlanExecutionContent } from "./plan-execution-content.js";

import {
  admitPlanRevision,
  admitPlanRevisionDraft,
  PLAN_REVISION_LIMITS,
  PLAN_REVISION_VERSION,
  planRevisionRefusal,
  type PlanRevision,
  type PlanRevisionRefusal,
} from "./plan-revision-contract.js";

export const PLAN_REVISION_DIGEST_DOMAIN = "moe-plan-revision-digest/1" as const;
export {
  PLAN_EXECUTION_CONTENT_DOMAIN, createPlanExecutionContent,
  decodePlanExecutionContentBytes, encodePlanExecutionContent,
} from "./plan-execution-content.js";
export type {
  PlanExecutionContent, PlanExecutionContentCreateResult, PlanExecutionContentDecodeResult,
  PlanExecutionContentDraft, PlanExecutionContentEncodeResult,
} from "./plan-execution-content.js";

export type PlanRevisionCreateResult =
  | Readonly<{ ok: true; revision: PlanRevision }>
  | PlanRevisionRefusal;
export type PlanRevisionDigestResult =
  | Readonly<{ ok: true; planHash: string }>
  | PlanRevisionRefusal;
export type PlanExecutionContentResult =
  | Readonly<{ digest: string; ok: true }>
  | PlanRevisionRefusal;
export type PlanRevisionEncodeResult =
  | Readonly<{ bytes: Uint8Array; ok: true }>
  | PlanRevisionRefusal;
export type PlanRevisionDecodeResult =
  | Readonly<{ ok: true; revision: PlanRevision }>
  | PlanRevisionRefusal;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DIGEST_PLACEHOLDER = "0".repeat(64);

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
  throw new TypeError("plan revision canonicalization received an unadmitted value");
}

function digestSource(revision: PlanRevision): Readonly<Record<string, unknown>> {
  return Object.freeze({
    affectedCriterionIds: revision.affectedCriterionIds,
    affectedNodeIds: revision.affectedNodeIds,
    approvalState: revision.approvalState,
    authorRef: revision.authorRef,
    graphBinding: revision.graphBinding,
    parentRevisionId: revision.parentRevisionId,
    rejectionRef: revision.rejectionRef,
    revisionId: revision.revisionId,
    steps: revision.steps,
    verificationRecipeRefs: revision.verificationRecipeRefs,
    version: revision.version,
  });
}

function digestOf(revision: PlanRevision): string {
  return createHash("sha256")
    .update(PLAN_REVISION_DIGEST_DOMAIN, "utf8")
    .update(Uint8Array.of(0))
    .update(encoder.encode(canonicalText(digestSource(revision))))
    .digest("hex");
}

const digestMismatch = (): PlanRevisionRefusal =>
  planRevisionRefusal("PLAN_REVISION_DIGEST_MISMATCH", "PLAN_REVISION_DIGEST");
const bytesInvalid = (): PlanRevisionRefusal =>
  planRevisionRefusal("PLAN_REVISION_BYTES_INVALID", "PLAN_REVISION_CODEC");
const duplicateKey = (): PlanRevisionRefusal =>
  planRevisionRefusal("PLAN_REVISION_DUPLICATE_KEY", "PLAN_REVISION_CODEC");
const noncanonical = (): PlanRevisionRefusal =>
  planRevisionRefusal("PLAN_REVISION_NONCANONICAL", "PLAN_REVISION_CANONICALIZATION");
const limitExceeded = (): PlanRevisionRefusal =>
  planRevisionRefusal("PLAN_REVISION_LIMIT_EXCEEDED", "PLAN_REVISION_LIMITS");

function canonicalBytes(revision: PlanRevision): PlanRevisionEncodeResult {
  const bytes = encoder.encode(canonicalText(revision));
  return bytes.byteLength > PLAN_REVISION_LIMITS.maxBytes
    ? limitExceeded() : Object.freeze({ bytes, ok: true as const });
}

export function createPlanRevision(draft: unknown): PlanRevisionCreateResult {
  const admitted = admitPlanRevisionDraft(draft);
  if (!admitted.ok) return admitted;
  const provisional = admitPlanRevision({
    ...admitted.draft,
    planHash: DIGEST_PLACEHOLDER,
    version: PLAN_REVISION_VERSION,
  });
  if (!provisional.ok) return provisional;
  const revision = admitPlanRevision({
    ...admitted.draft,
    planHash: digestOf(provisional.revision),
    version: PLAN_REVISION_VERSION,
  });
  if (!revision.ok) return revision;
  const bounded = canonicalBytes(revision.revision);
  return bounded.ok ? Object.freeze({ ok: true as const, revision: revision.revision }) : bounded;
}

export function derivePlanRevisionDigest(revision: unknown): PlanRevisionDigestResult {
  const admitted = admitPlanRevision(revision);
  if (!admitted.ok) return admitted;
  const bounded = canonicalBytes(admitted.revision);
  return bounded.ok
    ? Object.freeze({ ok: true as const, planHash: digestOf(admitted.revision) }) : bounded;
}

/** Admits through the existing reader first, so refusal code and layer pass through verbatim. */
export function derivePlanExecutionContent(revision: unknown): PlanExecutionContentResult {
  const admitted = admitPlanRevision(revision);
  if (!admitted.ok) return admitted;
  const bounded = canonicalBytes(admitted.revision);
  if (!bounded.ok) return bounded;
  const content = createPlanExecutionContent({
    affectedCriterionIds: admitted.revision.affectedCriterionIds,
    affectedNodeIds: admitted.revision.affectedNodeIds,
    steps: admitted.revision.steps,
    verificationRecipeRefs: admitted.revision.verificationRecipeRefs,
  });
  return content.ok ? Object.freeze({ digest: content.planExecutionContentDigest,
    ok: true as const }) : content;
}

export function encodePlanRevision(revision: unknown): PlanRevisionEncodeResult {
  const admitted = admitPlanRevision(revision);
  if (!admitted.ok) return admitted;
  const bounded = canonicalBytes(admitted.revision);
  if (!bounded.ok) return bounded;
  if (digestOf(admitted.revision) !== admitted.revision.planHash) return digestMismatch();
  return bounded;
}

export function decodePlanRevisionBytes(bytes: unknown): PlanRevisionDecodeResult {
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok) return decoded.code === "JSON_DUPLICATE_KEY" ? duplicateKey() : bytesInvalid();
  const source = new Uint8Array(bytes as Uint8Array);
  const admitted = admitPlanRevision(decoded.value);
  if (!admitted.ok) return admitted;
  if (digestOf(admitted.revision) !== admitted.revision.planHash) return digestMismatch();
  if (canonicalText(admitted.revision) !== decoder.decode(source)) return noncanonical();
  return Object.freeze({ ok: true as const, revision: admitted.revision });
}
