/**
 * Hostile-shape parsers for one node's readiness fact bundle. Shape only: no
 * confidence is decided here and no readiness is derived. Each parser returns
 * `null` on an unusable shape so its caller picks the stable code and layer.
 *
 * Split out of ./readiness-facts.ts to keep both files inside the per-file line
 * cap; the classification rules live there, the byte-level refusals live here.
 */
import {
  dense,
  isDigest,
  isRef,
  isVersion,
  oneOf,
  record,
} from "../admission/admission-model.js";
import type { DependencyFactBinding } from "../dependencies/dependency-contract.js";
import { CALLER_FACT_CODES, type CallerFactCode } from "./readiness-model.js";

export const BUNDLE_KEYS = [
  "nodeKey",
  "currentGate",
  "facts",
  "wait",
  "currentFactVersions",
] as const;
export const BUNDLE_REQUIRED = ["nodeKey", "currentGate", "facts"] as const;

const FACT_KEYS = [
  "code",
  "confidence",
  "provenance",
  "horizonGate",
  "recoveryRef",
] as const;
const PROVENANCE_KEYS = [
  "sourceFactRef",
  "sourceFactVersion",
  "sourceFactDigest",
] as const;

/** One attributed entry, still unclassified. */
export interface RawReadinessFact {
  readonly code: CallerFactCode;
  readonly confidence: unknown;
  readonly provenance: DependencyFactBinding | null;
  readonly horizonGate: unknown;
  readonly recoveryRef: string | null;
}

export function parseProvenance(value: unknown): DependencyFactBinding | null {
  const item = record(value, PROVENANCE_KEYS);
  if (
    item === null ||
    !isRef(item["sourceFactRef"]) ||
    !isVersion(item["sourceFactVersion"]) ||
    !isDigest(item["sourceFactDigest"])
  ) {
    return null;
  }
  return {
    sourceFactRef: item["sourceFactRef"],
    sourceFactVersion: item["sourceFactVersion"],
    sourceFactDigest: item["sourceFactDigest"],
  };
}

/** Absent means "the caller declared no current versions", not a refusal. */
export function parseCurrentVersions(
  value: unknown,
): ReadonlyMap<string, number> | null {
  if (value === undefined || value === null) {
    return new Map();
  }
  const entries = dense(value);
  if (entries === null) {
    return null;
  }
  const versions = new Map<string, number>();
  for (const entry of entries) {
    const item = record(entry, ["sourceFactRef", "version"]);
    if (
      item === null ||
      !isRef(item["sourceFactRef"]) ||
      !isVersion(item["version"]) ||
      versions.has(item["sourceFactRef"])
    ) {
      return null;
    }
    versions.set(item["sourceFactRef"], item["version"]);
  }
  return versions;
}

/**
 * Attribute one entry to its code. An entry whose code is absent, unknown, or
 * structural (a code only this engine may emit) cannot be attributed at all, so
 * the caller refuses the whole bundle rather than silently dropping an input
 * the caller believed it had supplied.
 */
export function parseRawFact(value: unknown): RawReadinessFact | null {
  const item = record(value, FACT_KEYS);
  if (item === null || !oneOf(item["code"], CALLER_FACT_CODES)) {
    return null;
  }
  const recoveryRef = item["recoveryRef"];
  return {
    code: item["code"],
    confidence: item["confidence"],
    provenance: parseProvenance(item["provenance"]),
    horizonGate: item["horizonGate"],
    recoveryRef: isRef(recoveryRef) ? recoveryRef : null,
  };
}
