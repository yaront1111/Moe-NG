import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";

import {
  admitExecutionIsolationProfileRevision,
  admitExecutionIsolationProfileRevisionDraft,
} from "./execution-isolation-profile-admission.js";
import {
  EXECUTION_ISOLATION_PROFILE_DIGEST_DOMAIN,
  EXECUTION_ISOLATION_PROFILE_LIMITS,
  EXECUTION_ISOLATION_PROFILE_VERSION,
  executionIsolationProfileRefusal,
  type ExecutionIsolationProfileEncodeResult,
  type ExecutionIsolationProfileRefusal,
  type ExecutionIsolationProfileRevision,
} from "./execution-isolation-profile-contract.js";

export {
  EXECUTION_ISOLATION_BUILD_AGENT_MOUNT_SHAPE,
  EXECUTION_ISOLATION_FRESH_VERIFIER_MOUNT_SHAPE,
  EXECUTION_ISOLATION_NETWORK_ACCESS_MODES,
  EXECUTION_ISOLATION_NETWORK_PLANE_IDENTITIES,
  EXECUTION_ISOLATION_PROFILE_CODES,
  EXECUTION_ISOLATION_PROFILE_DEFAULT_PLANE,
  EXECUTION_ISOLATION_PROFILE_DIGEST_DOMAIN,
  EXECUTION_ISOLATION_PROFILE_FORBIDDEN_HOST_INPUTS,
  EXECUTION_ISOLATION_PROFILE_LAYERS,
  EXECUTION_ISOLATION_PROFILE_LIMITS,
  EXECUTION_ISOLATION_PROFILE_PLANES,
  EXECUTION_ISOLATION_PROFILE_PURPOSES,
  EXECUTION_ISOLATION_PROFILE_VERSION,
} from "./execution-isolation-profile-contract.js";
export type {
  ExecutionIsolationCredentialBrokerRef,
  ExecutionIsolationEndpointPolicyRef,
  ExecutionIsolationForbiddenHostInput,
  ExecutionIsolationImageRef,
  ExecutionIsolationMount,
  ExecutionIsolationNetwork,
  ExecutionIsolationNetworkAccessMode,
  ExecutionIsolationNetworkPlaneIdentity,
  ExecutionIsolationPlane,
  ExecutionIsolationProfileCode,
  ExecutionIsolationProfileCreateResult,
  ExecutionIsolationProfileDecodeResult,
  ExecutionIsolationProfileEncodeResult,
  ExecutionIsolationProfileLayer,
  ExecutionIsolationProfileRefusal,
  ExecutionIsolationProfileRevision,
  ExecutionIsolationProfileRevisionDraft,
  ExecutionIsolationPurpose,
  ExecutionIsolationResourceLimits,
  ExecutionIsolationToolRef,
} from "./execution-isolation-profile-contract.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DIGEST_PLACEHOLDER = "0".repeat(64);
const refusal = (
  code: Parameters<typeof executionIsolationProfileRefusal>[0],
  layer: Parameters<typeof executionIsolationProfileRefusal>[1],
): ExecutionIsolationProfileRefusal => executionIsolationProfileRefusal(code, layer);

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
  throw new TypeError("ExecutionIsolationProfileRevision canonicalization received unadmitted data");
}

function digestOf(revision: ExecutionIsolationProfileRevision): string {
  const { revisionDigest: _digest, ...source } = revision;
  return createHash("sha256")
    .update(EXECUTION_ISOLATION_PROFILE_DIGEST_DOMAIN, "utf8")
    .update(Uint8Array.of(0))
    .update(encoder.encode(canonicalText(source)))
    .digest("hex");
}

function canonicalBytes(revision: ExecutionIsolationProfileRevision): ExecutionIsolationProfileEncodeResult {
  const bytes = encoder.encode(canonicalText(revision));
  return bytes.byteLength > EXECUTION_ISOLATION_PROFILE_LIMITS.maxBytes
    ? refusal(
      "EXECUTION_ISOLATION_PROFILE_LIMIT_EXCEEDED", "EXECUTION_ISOLATION_PROFILE_LIMITS",
    ) : Object.freeze({ bytes, ok: true as const });
}

export function createExecutionIsolationProfileRevision(value: unknown) {
  const admitted = admitExecutionIsolationProfileRevisionDraft(value); if (!admitted.ok) return admitted;
  const provisional: ExecutionIsolationProfileRevision = Object.freeze({
    ...admitted.draft,
    revisionDigest: DIGEST_PLACEHOLDER,
    version: EXECUTION_ISOLATION_PROFILE_VERSION,
  });
  const final: ExecutionIsolationProfileRevision = Object.freeze({
    ...admitted.draft,
    revisionDigest: digestOf(provisional),
    version: EXECUTION_ISOLATION_PROFILE_VERSION,
  });
  const bounded = canonicalBytes(final);
  return bounded.ok ? Object.freeze({ ok: true as const, revision: final }) : bounded;
}

export function encodeExecutionIsolationProfileRevision(value: unknown) {
  const admitted = admitExecutionIsolationProfileRevision(value); if (!admitted.ok) return admitted;
  const bounded = canonicalBytes(admitted.revision); if (!bounded.ok) return bounded;
  return digestOf(admitted.revision) === admitted.revision.revisionDigest ? bounded : refusal(
    "EXECUTION_ISOLATION_PROFILE_DIGEST_MISMATCH", "EXECUTION_ISOLATION_PROFILE_DIGEST",
  );
}

function decodeRefusal(code: string): ExecutionIsolationProfileRefusal {
  if (code === "JSON_DUPLICATE_KEY") return refusal(
    "EXECUTION_ISOLATION_PROFILE_DUPLICATE_KEY", "EXECUTION_ISOLATION_PROFILE_CODEC",
  );
  if (code === "JSON_BODY_LIMIT_EXCEEDED" || code === "JSON_DEPTH_LIMIT_EXCEEDED"
    || code === "JSON_STRING_LIMIT_EXCEEDED") return refusal(
    "EXECUTION_ISOLATION_PROFILE_LIMIT_EXCEEDED", "EXECUTION_ISOLATION_PROFILE_LIMITS",
  );
  return refusal(
    "EXECUTION_ISOLATION_PROFILE_BYTES_INVALID", "EXECUTION_ISOLATION_PROFILE_CODEC",
  );
}

export function decodeExecutionIsolationProfileRevisionBytes(bytes: unknown) {
  const decoded = decodeBoundedJsonBytes(bytes); if (!decoded.ok) return decodeRefusal(decoded.code);
  const source = new Uint8Array(bytes as Uint8Array);
  const admitted = admitExecutionIsolationProfileRevision(decoded.value); if (!admitted.ok) return admitted;
  if (digestOf(admitted.revision) !== admitted.revision.revisionDigest) return refusal(
    "EXECUTION_ISOLATION_PROFILE_DIGEST_MISMATCH", "EXECUTION_ISOLATION_PROFILE_DIGEST",
  );
  if (canonicalText(admitted.revision) !== decoder.decode(source)) return refusal(
    "EXECUTION_ISOLATION_PROFILE_NONCANONICAL",
    "EXECUTION_ISOLATION_PROFILE_CANONICALIZATION",
  );
  return Object.freeze({ ok: true as const, revision: admitted.revision });
}
