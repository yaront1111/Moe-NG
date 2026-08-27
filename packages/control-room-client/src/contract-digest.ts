import { createHash } from "node:crypto";

import {
  MAX_JSON_BODY_BYTES,
  MAX_JSON_DEPTH,
  MAX_JSON_STRING_UTF8_BYTES,
  RUNTIME_AGGREGATES,
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  RUNTIME_COMMAND_KINDS,
  RUNTIME_ERROR_CODES,
  RUNTIME_ERROR_REGISTRY_VERSION,
  RUNTIME_LIFECYCLES,
  RUNTIME_QUERY_ENVELOPE_VERSION,
  RUNTIME_QUERY_KINDS,
  RUNTIME_SAFE_DETAIL_KEYS,
  RUNTIME_TELEMETRY_KINDS,
  lookupRuntimeError,
} from "@moe/contracts";
import type { RuntimeAggregate } from "@moe/contracts";

const sortedCopy = <T extends string>(values: readonly T[]): readonly T[] => [...values].sort();

/**
 * Canonical serialization of the RUNTIME-ENUMERABLE contract surface. Key order is
 * fixed by construction and every list is sorted, so the digest is a pure function of
 * the registry. It deliberately does NOT cover envelope key arrays: those are
 * module-private in `@moe/contracts`, so envelope-shape drift is invisible here and is
 * caught instead by the emitted type-level exhaustive-key assertions.
 */
export function canonicalContractSurface(): string {
  const lifecycles: Record<string, readonly string[]> = {};
  for (const aggregate of sortedCopy(Object.keys(RUNTIME_LIFECYCLES) as RuntimeAggregate[])) {
    lifecycles[aggregate] = RUNTIME_LIFECYCLES[aggregate];
  }
  return JSON.stringify({
    aggregates: sortedCopy(RUNTIME_AGGREGATES),
    commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    commandKinds: sortedCopy(RUNTIME_COMMAND_KINDS),
    errorRegistryVersion: RUNTIME_ERROR_REGISTRY_VERSION,
    errors: sortedCopy(RUNTIME_ERROR_CODES).map((code) => lookupRuntimeError(code)),
    lifecycles,
    limits: {
      maxJsonBodyBytes: MAX_JSON_BODY_BYTES,
      maxJsonDepth: MAX_JSON_DEPTH,
      maxJsonStringUtf8Bytes: MAX_JSON_STRING_UTF8_BYTES,
    },
    queryEnvelopeVersion: RUNTIME_QUERY_ENVELOPE_VERSION,
    queryKinds: sortedCopy(RUNTIME_QUERY_KINDS),
    safeDetailKeys: sortedCopy(RUNTIME_SAFE_DETAIL_KEYS),
    telemetryKinds: sortedCopy(RUNTIME_TELEMETRY_KINDS),
  });
}

export function deriveContractDigest(): string {
  return createHash("sha256").update(canonicalContractSurface(), "utf8").digest("hex");
}
