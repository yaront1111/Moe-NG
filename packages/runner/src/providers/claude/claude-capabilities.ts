import { canonicalDigest, isNormalizedText, isSafeByteCount } from "../../canonical.js";
import type { RuntimeClosureEntry, RuntimePinningMethod } from "./claude-observation.js";

/**
 * Closed capability vocabulary for the Claude runtime (design 11.5, 14.2).
 *
 * Two rules shape everything below.
 *
 * 1. Help text is not capability proof. The probe port may hand over the CLI's
 *    entire help output and it will still move no capability off `UNSUPPORTED`;
 *    only an observation of the behaviour itself counts, and an observation that
 *    contradicts the capability it was offered for proves the opposite.
 * 2. Unproven is `UNSUPPORTED`, never absent and never optimistic. Every member
 *    of the vocabulary gets a record on every probe, so a consumer can never
 *    mistake "we did not look" for "it is not there".
 *
 * The one place the design asks for a different word is the context limit: when
 * neither an exact token limit nor a trustworthy conservative byte bound is
 * declared, the *capability* is `UNSUPPORTED` and the resulting *policy* is
 * `HOLD_UNKNOWN` (design 14.2). Those are two different statements and this
 * module reports both rather than collapsing them.
 */
export const CLAUDE_CAPABILITY_PROFILE_VERSION = "moe-claude-capability-profile/1" as const;

export const CLAUDE_CAPABILITIES = Object.freeze([
  "CANCEL_ON_READING",
  "CONTEXT_LIMIT_DECLARATION",
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
export type ClaudeCapability = (typeof CLAUDE_CAPABILITIES)[number];

export const CLAUDE_CAPABILITY_STATUSES = Object.freeze(["SUPPORTED", "UNSUPPORTED"] as const);
export type ClaudeCapabilityStatus = (typeof CLAUDE_CAPABILITY_STATUSES)[number];

/** Closed set of things that can move a capability to SUPPORTED. */
export const CLAUDE_PROOF_METHODS = Object.freeze([
  "NONE",
  "CANCEL_OBSERVED",
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
export type ClaudeProofMethod = (typeof CLAUDE_PROOF_METHODS)[number];

export const CLAUDE_CONTEXT_POLICIES = Object.freeze(["ADMISSIBLE", "HOLD_UNKNOWN"] as const);
export type ClaudeContextPolicy = (typeof CLAUDE_CONTEXT_POLICIES)[number];

export type ClaudeContextLimit =
  | { readonly kind: "EXACT_TOKENS"; readonly tokens: number }
  | { readonly kind: "CONSERVATIVE_INPUT_BYTES"; readonly bytes: number }
  | { readonly kind: "UNKNOWN" };

export interface ClaudeStructuredSample {
  readonly jsonLines: readonly string[];
}

export interface ClaudeCancelObservation {
  readonly requestedAtSequence: number;
  readonly terminatedAtSequence: number;
}

export interface ClaudeProcessTreeObservation {
  readonly childrenBefore: number;
  readonly childrenAfter: number;
}

export interface ClaudeRunEnumerationObservation {
  readonly enumeratedRunIds: readonly string[];
  readonly provenAbsentRunId: string;
}

export interface ClaudeTokenizerObservation {
  readonly tokenizerId: string;
  readonly sampleText: string;
  readonly sampleTokenCount: number;
}

/**
 * Every field is required and explicitly nullable. An optional field would let a
 * port omit evidence by accident and read as a deliberate absence; here a port
 * has to state "I did not observe this".
 */
export interface ClaudeProbeReport {
  readonly resolvedRuntimeClosure: readonly RuntimeClosureEntry[];
  readonly reportedVersion: string | null;
  readonly schemaVersion: string | null;
  readonly pinningMethod: RuntimePinningMethod;
  readonly structuredSample: ClaudeStructuredSample | null;
  readonly rawSampleBase64: string | null;
  readonly cancelObservation: ClaudeCancelObservation | null;
  readonly processTreeObservation: ClaudeProcessTreeObservation | null;
  readonly runEnumeration: ClaudeRunEnumerationObservation | null;
  readonly tokenizer: ClaudeTokenizerObservation | null;
  readonly declaredContextLimit: ClaudeContextLimit | null;
  /** Recorded for diagnostics only; deliberately proves nothing. */
  readonly helpText: string | null;
  /** Deliberately ignored: resume is UNSUPPORTED in v1 whatever the CLI says. */
  readonly resumeClaim: string | null;
}

export interface ClaudeProbePort {
  readonly report: () => ClaudeProbeReport;
}

export interface ClaudeCapabilityRecord {
  readonly capability: ClaudeCapability;
  readonly status: ClaudeCapabilityStatus;
  readonly proofMethod: ClaudeProofMethod;
}

export interface ClaudeCapabilityProfile {
  readonly profileVersion: typeof CLAUDE_CAPABILITY_PROFILE_VERSION;
  readonly capabilities: readonly ClaudeCapabilityRecord[];
  readonly contextLimit: ClaudeContextLimit;
  readonly contextPolicy: ClaudeContextPolicy;
  readonly capabilitySchemaDigest: string;
}

export const UNPROVEN_PROBE_REPORT: ClaudeProbeReport = Object.freeze({
  resolvedRuntimeClosure: Object.freeze([]),
  reportedVersion: null,
  schemaVersion: null,
  pinningMethod: "UNSUPPORTED",
  structuredSample: null,
  rawSampleBase64: null,
  cancelObservation: null,
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

function parsesAsStructuredRecord(sample: ClaudeStructuredSample | null): boolean {
  if (sample === null || sample.jsonLines.length === 0) {
    return false;
  }
  return sample.jsonLines.every((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    } catch {
      return false;
    }
  });
}

function decodesToBytes(base64: string | null): boolean {
  if (base64 === null || base64.length === 0) {
    return false;
  }
  const decoded = Buffer.from(base64, "base64");
  return decoded.byteLength > 0 && decoded.toString("base64") === base64;
}

/** A cancel that landed after the stream already ended proves nothing. */
function cancelProven(observation: ClaudeCancelObservation | null): boolean {
  return (
    observation !== null &&
    isSafeByteCount(observation.requestedAtSequence) &&
    isSafeByteCount(observation.terminatedAtSequence) &&
    observation.terminatedAtSequence > observation.requestedAtSequence
  );
}

/** Surviving children disprove process-tree termination rather than proving it. */
function processTreeProven(observation: ClaudeProcessTreeObservation | null): boolean {
  return (
    observation !== null &&
    isSafeByteCount(observation.childrenBefore) &&
    observation.childrenBefore > 0 &&
    observation.childrenAfter === 0
  );
}

/** A negative proof for a run the enumeration actually listed is a contradiction. */
function runEnumerationProven(observation: ClaudeRunEnumerationObservation | null): boolean {
  return (
    observation !== null &&
    isBoundedLabel(observation.provenAbsentRunId) &&
    !observation.enumeratedRunIds.includes(observation.provenAbsentRunId)
  );
}

function tokenizerProven(observation: ClaudeTokenizerObservation | null): boolean {
  return (
    observation !== null &&
    isBoundedLabel(observation.tokenizerId) &&
    isSafeByteCount(observation.sampleTokenCount) &&
    observation.sampleTokenCount > 0
  );
}

export function resolveContextLimit(declared: ClaudeContextLimit | null): ClaudeContextLimit {
  if (declared === null) {
    return { kind: "UNKNOWN" };
  }
  if (declared.kind === "EXACT_TOKENS" && isSafeByteCount(declared.tokens) && declared.tokens > 0) {
    return { kind: "EXACT_TOKENS", tokens: declared.tokens };
  }
  if (
    declared.kind === "CONSERVATIVE_INPUT_BYTES" &&
    isSafeByteCount(declared.bytes) &&
    declared.bytes > 0
  ) {
    return { kind: "CONSERVATIVE_INPUT_BYTES", bytes: declared.bytes };
  }
  return { kind: "UNKNOWN" };
}

function record(
  capability: ClaudeCapability,
  proven: boolean,
  proofMethod: ClaudeProofMethod,
): ClaudeCapabilityRecord {
  return proven
    ? { capability, status: "SUPPORTED", proofMethod }
    : { capability, status: "UNSUPPORTED", proofMethod: "NONE" };
}

/** Emits one record per vocabulary member, in vocabulary order, every time. */
export function assessCapabilities(
  report: ClaudeProbeReport,
  contextLimit: ClaudeContextLimit,
): readonly ClaudeCapabilityRecord[] {
  return [
    record("CANCEL_ON_READING", cancelProven(report.cancelObservation), "CANCEL_OBSERVED"),
    record("CONTEXT_LIMIT_DECLARATION", contextLimit.kind !== "UNKNOWN", "DECLARED_LIMIT_RECORD"),
    record("PIN_METHOD", report.pinningMethod !== "UNSUPPORTED", "PIN_METHOD_RECORD"),
    record(
      "PROCESS_TREE_TERMINATION",
      processTreeProven(report.processTreeObservation),
      "PROCESS_TREE_OBSERVED",
    ),
    record("RAW_STREAM", decodesToBytes(report.rawSampleBase64), "RAW_BYTES_OBSERVED"),
    // Design 21.1/21.4: v1 is runtime-pinned Claude with no provider resume.
    record("RESUME", false, "NONE"),
    record(
      "RUN_ENUMERATION_NEGATIVE_PROOF",
      runEnumerationProven(report.runEnumeration),
      "RUN_ENUMERATION_OBSERVED",
    ),
    record("SCHEMA_VERSION_REPORT", isBoundedLabel(report.schemaVersion), "SCHEMA_VERSION_RECORD"),
    record(
      "STRUCTURED_STREAM",
      parsesAsStructuredRecord(report.structuredSample),
      "STRUCTURED_RECORD_PARSED",
    ),
    record("TOKENIZER_AVAILABILITY", tokenizerProven(report.tokenizer), "TOKENIZER_RECORD"),
    record("VERSION_REPORT", isBoundedLabel(report.reportedVersion), "VERSION_RECORD"),
  ];
}

export function capabilitySchemaDigestOf(
  capabilities: readonly ClaudeCapabilityRecord[],
  contextLimit: ClaudeContextLimit,
  contextPolicy: ClaudeContextPolicy,
): string {
  return canonicalDigest({
    profileVersion: CLAUDE_CAPABILITY_PROFILE_VERSION,
    vocabulary: [...CLAUDE_CAPABILITIES],
    capabilities: capabilities.map((entry) => ({
      capability: entry.capability,
      status: entry.status,
      proofMethod: entry.proofMethod,
    })),
    contextLimit: { ...contextLimit },
    contextPolicy,
  });
}
