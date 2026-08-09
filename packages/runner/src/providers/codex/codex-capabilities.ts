import { canonicalDigest, isNormalizedText, isSafeByteCount } from "../../canonical.js";
import type { RuntimeClosureEntry, RuntimePinningMethod } from "./codex-observation.js";

export const CODEX_CAPABILITY_PROFILE_VERSION = "moe-codex-capability-profile/1" as const;

export const CODEX_CAPABILITIES = Object.freeze([
  "CANCEL_ON_READING",
  "CONTEXT_LIMIT_DECLARATION",
  "CWD_OBSERVATION",
  "PIN_METHOD",
  "PROCESS_TREE_TERMINATION",
  "RAW_STREAM",
  "RESUME",
  "RUN_ENUMERATION_NEGATIVE_PROOF",
  "SCHEMA_VERSION_REPORT",
  "STRUCTURED_STREAM",
  "TOKENIZER_AVAILABILITY",
  "VERSION_REPORT",
] as const);
export type CodexCapability = (typeof CODEX_CAPABILITIES)[number];

export const CODEX_CAPABILITY_STATUSES = Object.freeze(["SUPPORTED", "UNSUPPORTED"] as const);
export type CodexCapabilityStatus = (typeof CODEX_CAPABILITY_STATUSES)[number];

export const CODEX_PROOF_METHODS = Object.freeze([
  "NONE",
  "CANCEL_OBSERVED",
  "CWD_OBSERVED",
  "DECLARED_LIMIT_RECORD",
  "PIN_METHOD_RECORD",
  "PROCESS_TREE_OBSERVED",
  "RAW_BYTES_OBSERVED",
  "RUN_ENUMERATION_OBSERVED",
  "SCHEMA_VERSION_RECORD",
  "STRUCTURED_RECORD_PARSED",
  "TOKENIZER_RECORD",
  "VERSION_RECORD",
] as const);
export type CodexProofMethod = (typeof CODEX_PROOF_METHODS)[number];

export const CODEX_CONTEXT_POLICIES = Object.freeze(["ADMISSIBLE", "HOLD_UNKNOWN"] as const);
export type CodexContextPolicy = (typeof CODEX_CONTEXT_POLICIES)[number];

export type CodexContextLimit =
  | { readonly kind: "EXACT_TOKENS"; readonly tokens: number }
  | { readonly kind: "CONSERVATIVE_INPUT_BYTES"; readonly bytes: number }
  | { readonly kind: "UNKNOWN" };

export interface CodexStructuredSample { readonly jsonLines: readonly string[] }
export interface CodexCancelObservation {
  readonly requestedAtSequence: number;
  readonly terminatedAtSequence: number;
}
export interface CodexCwdObservation { readonly requestedCwd: string; readonly observedCwd: string }
export interface CodexProcessTreeObservation {
  readonly childrenBefore: number;
  readonly childrenAfter: number;
}
export interface CodexRunEnumerationObservation {
  readonly enumeratedRunIds: readonly string[];
  readonly provenAbsentRunId: string;
}
export interface CodexTokenizerObservation {
  readonly tokenizerId: string;
  readonly sampleText: string;
  readonly sampleTokenCount: number;
}

/** Every field is required and explicitly nullable; absence never proves support. */
export interface CodexProbeReport {
  readonly resolvedRuntimeClosure: readonly RuntimeClosureEntry[];
  readonly reportedVersion: string | null;
  readonly schemaVersion: string | null;
  readonly pinningMethod: RuntimePinningMethod;
  readonly structuredSample: CodexStructuredSample | null;
  readonly rawSampleBase64: string | null;
  readonly cancelObservation: CodexCancelObservation | null;
  readonly cwdObservation: CodexCwdObservation | null;
  readonly processTreeObservation: CodexProcessTreeObservation | null;
  readonly runEnumeration: CodexRunEnumerationObservation | null;
  readonly tokenizer: CodexTokenizerObservation | null;
  readonly declaredContextLimit: CodexContextLimit | null;
  readonly helpText: string | null;
  readonly resumeClaim: string | null;
}

export interface CodexProbePort { readonly report: () => CodexProbeReport }
export interface CodexCapabilityRecord {
  readonly capability: CodexCapability;
  readonly status: CodexCapabilityStatus;
  readonly proofMethod: CodexProofMethod;
}
export interface CodexCapabilityProfile {
  readonly profileVersion: typeof CODEX_CAPABILITY_PROFILE_VERSION;
  readonly capabilities: readonly CodexCapabilityRecord[];
  readonly contextLimit: CodexContextLimit;
  readonly contextPolicy: CodexContextPolicy;
  readonly capabilitySchemaDigest: string;
}

export const UNPROVEN_PROBE_REPORT: CodexProbeReport = Object.freeze({
  resolvedRuntimeClosure: Object.freeze([]),
  reportedVersion: null,
  schemaVersion: null,
  pinningMethod: "UNSUPPORTED",
  structuredSample: null,
  rawSampleBase64: null,
  cancelObservation: null,
  cwdObservation: null,
  processTreeObservation: null,
  runEnumeration: null,
  tokenizer: null,
  declaredContextLimit: null,
  helpText: null,
  resumeClaim: null,
});

export function isBoundedLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isNormalizedText(value);
}

function parsesStructured(sample: CodexStructuredSample | null): boolean {
  if (sample === null || sample.jsonLines.length === 0) return false;
  return sample.jsonLines.every((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    } catch { return false; }
  });
}

function decodesToBytes(base64: string | null): boolean {
  if (base64 === null || base64.length === 0) return false;
  const decoded = Buffer.from(base64, "base64");
  return decoded.byteLength > 0 && decoded.toString("base64") === base64;
}

function cancelProven(value: CodexCancelObservation | null): boolean {
  return value !== null && isSafeByteCount(value.requestedAtSequence) &&
    isSafeByteCount(value.terminatedAtSequence) &&
    value.terminatedAtSequence > value.requestedAtSequence;
}

function cwdProven(value: CodexCwdObservation | null): boolean {
  return value !== null && isBoundedLabel(value.requestedCwd) &&
    value.requestedCwd === value.observedCwd;
}

function processTreeProven(value: CodexProcessTreeObservation | null): boolean {
  return value !== null && isSafeByteCount(value.childrenBefore) && value.childrenBefore > 0 &&
    value.childrenAfter === 0;
}

function runEnumerationProven(value: CodexRunEnumerationObservation | null): boolean {
  return value !== null && isBoundedLabel(value.provenAbsentRunId) &&
    !value.enumeratedRunIds.includes(value.provenAbsentRunId);
}

function tokenizerProven(value: CodexTokenizerObservation | null): boolean {
  return value !== null && isBoundedLabel(value.tokenizerId) &&
    isSafeByteCount(value.sampleTokenCount) && value.sampleTokenCount > 0;
}

export function resolveContextLimit(value: CodexContextLimit | null): CodexContextLimit {
  if (value?.kind === "EXACT_TOKENS" && isSafeByteCount(value.tokens) && value.tokens > 0) {
    return { kind: "EXACT_TOKENS", tokens: value.tokens };
  }
  if (value?.kind === "CONSERVATIVE_INPUT_BYTES" &&
      isSafeByteCount(value.bytes) && value.bytes > 0) {
    return { kind: "CONSERVATIVE_INPUT_BYTES", bytes: value.bytes };
  }
  return { kind: "UNKNOWN" };
}

function record(
  capability: CodexCapability,
  proven: boolean,
  proofMethod: CodexProofMethod,
): CodexCapabilityRecord {
  return proven ? { capability, status: "SUPPORTED", proofMethod } :
    { capability, status: "UNSUPPORTED", proofMethod: "NONE" };
}

export function assessCapabilities(
  report: CodexProbeReport,
  limit: CodexContextLimit,
): readonly CodexCapabilityRecord[] {
  return [
    record("CANCEL_ON_READING", cancelProven(report.cancelObservation), "CANCEL_OBSERVED"),
    record("CONTEXT_LIMIT_DECLARATION", limit.kind !== "UNKNOWN", "DECLARED_LIMIT_RECORD"),
    record("CWD_OBSERVATION", cwdProven(report.cwdObservation), "CWD_OBSERVED"),
    record("PIN_METHOD", report.pinningMethod !== "UNSUPPORTED", "PIN_METHOD_RECORD"),
    record("PROCESS_TREE_TERMINATION", processTreeProven(report.processTreeObservation), "PROCESS_TREE_OBSERVED"),
    record("RAW_STREAM", decodesToBytes(report.rawSampleBase64), "RAW_BYTES_OBSERVED"),
    record("RESUME", false, "NONE"),
    record("RUN_ENUMERATION_NEGATIVE_PROOF", runEnumerationProven(report.runEnumeration), "RUN_ENUMERATION_OBSERVED"),
    record("SCHEMA_VERSION_REPORT", isBoundedLabel(report.schemaVersion), "SCHEMA_VERSION_RECORD"),
    record("STRUCTURED_STREAM", parsesStructured(report.structuredSample), "STRUCTURED_RECORD_PARSED"),
    record("TOKENIZER_AVAILABILITY", tokenizerProven(report.tokenizer), "TOKENIZER_RECORD"),
    record("VERSION_REPORT", isBoundedLabel(report.reportedVersion), "VERSION_RECORD"),
  ];
}

export function capabilitySchemaDigestOf(
  capabilities: readonly CodexCapabilityRecord[],
  contextLimit: CodexContextLimit,
  contextPolicy: CodexContextPolicy,
): string {
  return canonicalDigest({
    profileVersion: CODEX_CAPABILITY_PROFILE_VERSION,
    vocabulary: [...CODEX_CAPABILITIES],
    capabilities: capabilities.map((entry) => ({ ...entry })),
    contextLimit: { ...contextLimit },
    contextPolicy,
  });
}
