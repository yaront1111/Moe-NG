import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";

import {
  admitVerificationRecipeRevision, admitVerificationRecipeRevisionDraft,
} from "./verification-recipe-admission.js";
import {
  VERIFICATION_RECIPE_DIGEST_DOMAIN,
  VERIFICATION_RECIPE_LIMITS,
  VERIFICATION_RECIPE_VERSION,
  verificationRecipeRefusal,
  type VerificationRecipeEncodeResult,
  type VerificationRecipeProfileAdmission,
  type VerificationRecipeRefusal,
  type VerificationRecipeRevision,
} from "./verification-recipe-contract.js";
import { admitVerificationRecipeExecutionProfileBindings } from
  "./verification-recipe-profile-admission.js";

export {
  VERIFICATION_RECIPE_BUILD_AGENT_SAFE_ENVIRONMENT_NAMES,
  VERIFICATION_RECIPE_CODES,
  VERIFICATION_RECIPE_DIGEST_DOMAIN,
  VERIFICATION_RECIPE_FORBIDDEN_SHELL_TOOLS,
  VERIFICATION_RECIPE_FRESH_VERIFIER_SAFE_ENVIRONMENT_NAMES,
  VERIFICATION_RECIPE_LAYERS,
  VERIFICATION_RECIPE_LIMITS,
  VERIFICATION_RECIPE_NETWORK_ACCESS_MODES,
  VERIFICATION_RECIPE_NETWORK_PLANE_IDENTITIES,
  VERIFICATION_RECIPE_OUTPUT_MOUNTS,
  VERIFICATION_RECIPE_VERSION,
} from "./verification-recipe-contract.js";
export type {
  VerificationRecipeCode,
  VerificationRecipeCreateResult,
  VerificationRecipeDecodeResult,
  VerificationRecipeEncodeResult,
  VerificationRecipeExpectedOutput,
  VerificationRecipeExpectedRefusal,
  VerificationRecipeEvidenceParserRevision,
  VerificationRecipeImageRef,
  VerificationRecipeLayer,
  VerificationRecipeNetworkPolicy,
  VerificationRecipeOutputMount,
  VerificationRecipeProfileAdmission,
  VerificationRecipeRefusal,
  VerificationRecipeResourceCaps,
  VerificationRecipeRevision,
  VerificationRecipeRevisionDraft,
  VerificationRecipeToolRef,
} from "./verification-recipe-contract.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DIGEST_PLACEHOLDER = "0".repeat(64);
const refusal = (
  code: Parameters<typeof verificationRecipeRefusal>[0],
  layer: Parameters<typeof verificationRecipeRefusal>[1],
): VerificationRecipeRefusal => verificationRecipeRefusal(code, layer);

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
  throw new TypeError("VerificationRecipeRevision canonicalization received unadmitted data");
}

function digestOf(revision: VerificationRecipeRevision): string {
  const { revisionDigest: _digest, ...source } = revision;
  return createHash("sha256")
    .update(VERIFICATION_RECIPE_DIGEST_DOMAIN, "utf8")
    .update(Uint8Array.of(0))
    .update(encoder.encode(canonicalText(source)))
    .digest("hex");
}

function canonicalBytes(revision: VerificationRecipeRevision): VerificationRecipeEncodeResult {
  const bytes = encoder.encode(canonicalText(revision));
  return bytes.byteLength > VERIFICATION_RECIPE_LIMITS.maxBytes
    ? refusal("VERIFICATION_RECIPE_LIMIT_EXCEEDED", "VERIFICATION_RECIPE_LIMITS")
    : Object.freeze({ bytes, ok: true as const });
}

export function createVerificationRecipeRevision(value: unknown) {
  const admitted = admitVerificationRecipeRevisionDraft(value); if (!admitted.ok) return admitted;
  const provisional: VerificationRecipeRevision = Object.freeze({
    ...admitted.draft, revisionDigest: DIGEST_PLACEHOLDER, version: VERIFICATION_RECIPE_VERSION,
  });
  const final: VerificationRecipeRevision = Object.freeze({
    ...admitted.draft, revisionDigest: digestOf(provisional), version: VERIFICATION_RECIPE_VERSION,
  });
  const bounded = canonicalBytes(final);
  return bounded.ok ? Object.freeze({ ok: true as const, revision: final }) : bounded;
}

export function admitVerificationRecipeForExecutionProfile(
  recipeValue: unknown,
  executionProfileValue: unknown,
): VerificationRecipeProfileAdmission {
  const admitted = admitVerificationRecipeRevision(recipeValue); if (!admitted.ok) return admitted;
  if (digestOf(admitted.revision) !== admitted.revision.revisionDigest) return refusal(
    "VERIFICATION_RECIPE_DIGEST_MISMATCH", "VERIFICATION_RECIPE_DIGEST",
  );
  return admitVerificationRecipeExecutionProfileBindings(
    admitted.revision, executionProfileValue,
  );
}

export function encodeVerificationRecipeRevision(value: unknown) {
  const admitted = admitVerificationRecipeRevision(value); if (!admitted.ok) return admitted;
  const bounded = canonicalBytes(admitted.revision); if (!bounded.ok) return bounded;
  return digestOf(admitted.revision) === admitted.revision.revisionDigest ? bounded : refusal(
    "VERIFICATION_RECIPE_DIGEST_MISMATCH", "VERIFICATION_RECIPE_DIGEST",
  );
}

function decodeRefusal(code: string): VerificationRecipeRefusal {
  if (code === "JSON_DUPLICATE_KEY") return refusal(
    "VERIFICATION_RECIPE_DUPLICATE_KEY", "VERIFICATION_RECIPE_CODEC",
  );
  if (code === "JSON_BODY_LIMIT_EXCEEDED" || code === "JSON_DEPTH_LIMIT_EXCEEDED"
    || code === "JSON_STRING_LIMIT_EXCEEDED") return refusal(
    "VERIFICATION_RECIPE_LIMIT_EXCEEDED", "VERIFICATION_RECIPE_LIMITS",
  );
  return refusal("VERIFICATION_RECIPE_BYTES_INVALID", "VERIFICATION_RECIPE_CODEC");
}

export function decodeVerificationRecipeRevisionBytes(bytes: unknown) {
  const decoded = decodeBoundedJsonBytes(bytes); if (!decoded.ok) return decodeRefusal(decoded.code);
  const source = new Uint8Array(bytes as Uint8Array);
  const admitted = admitVerificationRecipeRevision(decoded.value); if (!admitted.ok) return admitted;
  if (digestOf(admitted.revision) !== admitted.revision.revisionDigest) return refusal(
    "VERIFICATION_RECIPE_DIGEST_MISMATCH", "VERIFICATION_RECIPE_DIGEST",
  );
  if (canonicalText(admitted.revision) !== decoder.decode(source)) return refusal(
    "VERIFICATION_RECIPE_NONCANONICAL", "VERIFICATION_RECIPE_CANONICALIZATION",
  );
  return Object.freeze({ ok: true as const, revision: admitted.revision });
}
