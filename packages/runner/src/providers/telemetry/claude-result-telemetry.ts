/**
 * Version-pinned parser for the Claude structured result the real launcher
 * captured, turning admitted provider bytes into provider-run facts.
 *
 * IT ADMITS NO BYTES OF ITS OWN. Framing and schema admission belong to the
 * landed stream discipline — `frameStream`/`analyzeStream` and
 * `CLAUDE_ACCEPTED_SCHEMA_VERSIONS`. A second admission path here could disagree
 * with that one, and the losing path would become a silent bypass.
 *
 * THE DECISIVE RULE: a truncated or incomplete capture yields NO counts. Summing
 * the records that did arrive would produce a plausible total indistinguishable
 * from a real one at every later layer, so this parser refuses outright with the
 * exact capture code and layer, and the wrapper turns that refusal into explicit
 * UNKNOWN quantities rather than a partial sum.
 */
import { sha256Hex } from "../../canonical.js";
import type { ClaudeStreamEvidence } from "../claude/claude-launcher.js";
import type { ClaudeModelEvidenceKind } from "../claude/claude-launch-selection.js";
import { CLAUDE_ACCEPTED_SCHEMA_VERSIONS } from "../claude/claude-stream.js";
import {
  analyzeStream, frameStream,
  type ClaudeStreamAnomaly, type ParsedStreamLine,
} from "../claude/claude-stream-anomalies.js";
import {
  countCoverage, readCount, readText, snapshotRunRef, telemetryRefusal, unknownFact,
  type ProviderCountCoverage, type ProviderInfrastructureOutcome, type ProviderQuantity,
  type ProviderRunRef, type ProviderTelemetryCode, type ProviderTelemetryLayer,
  type ProviderTelemetryRefusal, type ProviderTerminalOutcome, type ProviderText,
} from "./provider-telemetry-contracts.js";

export const CLAUDE_RESULT_TELEMETRY_VERSION = "moe-claude-result-telemetry/1" as const;

/** The two record shapes this parser reads, named as data rather than inline. */
export const CLAUDE_TELEMETRY_RECORDS =
  Object.freeze({ result: "result", initType: "system", initSubtype: "init" } as const);

/** Supported terminal subtypes. An unlisted subtype stays UNKNOWN, never guessed. */
export const CLAUDE_RESULT_SUBTYPES = Object.freeze({
  success: "COMPLETED",
  cancelled: "CANCELLED",
  error_max_turns: "MAX_TURNS_EXHAUSTED",
  error_during_execution: "ERROR_DURING_EXECUTION",
} as const satisfies Readonly<Record<string, ProviderTerminalOutcome>>);

/**
 * Snapshot evidence is READ OUT of the observed model id, never derived from a
 * declared one: a dated suffix and a Bedrock-style build stamp are both literal
 * substrings the provider itself emitted. An id carrying neither leaves both the
 * kind and the evidence UNKNOWN.
 */
export const CLAUDE_MODEL_EVIDENCE_PATTERNS =
  Object.freeze({ DATED_SNAPSHOT: /-(\d{8})$/u, BUILD_STAMP: /-(v\d+:\d+)$/u } as const);

export const CLAUDE_TOKEN_FIELDS = Object.freeze({
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  cacheCreationInputTokens: "cache_creation_input_tokens",
  cacheReadInputTokens: "cache_read_input_tokens",
} as const);
export const CLAUDE_STEP_FIELD = "num_turns" as const;

/**
 * Every anomaly the landed vocabulary can raise, mapped to the exact refusal it
 * produces here, in the landed precedence order: a resumed stream first, then an
 * unreadable schema, then a cut capture, then everything that destroyed the
 * evidence. The table is exhaustive so a new anomaly cannot fall through to a
 * silent success.
 */
const ANOMALY_REFUSALS: readonly (readonly [
  ClaudeStreamAnomaly, ProviderTelemetryCode, ProviderTelemetryLayer,
])[] = Object.freeze([
  ["RESUME_DISCONTINUITY", "TELEMETRY_STREAM_ANOMALOUS", "TELEMETRY_SCHEMA"],
  ["UNKNOWN_SCHEMA_VERSION", "TELEMETRY_SCHEMA_UNSUPPORTED", "TELEMETRY_SCHEMA"],
  ["TRUNCATION", "TELEMETRY_CAPTURE_TRUNCATED", "TELEMETRY_CAPTURE"],
  ["COUNTER_REGRESSION", "TELEMETRY_STREAM_ANOMALOUS", "TELEMETRY_SCHEMA"],
  ["DUPLICATE_EVENT", "TELEMETRY_STREAM_ANOMALOUS", "TELEMETRY_SCHEMA"],
  ["GAP", "TELEMETRY_STREAM_ANOMALOUS", "TELEMETRY_SCHEMA"],
  ["MALFORMED_RECORD", "TELEMETRY_STREAM_ANOMALOUS", "TELEMETRY_SCHEMA"],
  ["OUT_OF_ORDER", "TELEMETRY_STREAM_ANOMALOUS", "TELEMETRY_SCHEMA"],
] as const);
export const CLAUDE_TELEMETRY_ANOMALY_REFUSALS = ANOMALY_REFUSALS;

export interface ClaudeObservedModel {
  readonly modelId: ProviderText;
  readonly snapshotKind: ClaudeModelEvidenceKind;
  readonly snapshotEvidence: ProviderText;
}
export interface ClaudeTokenObservations {
  readonly inputTokens: ProviderQuantity;
  readonly outputTokens: ProviderQuantity;
  readonly cacheCreationInputTokens: ProviderQuantity;
  readonly cacheReadInputTokens: ProviderQuantity;
  readonly coverage: ProviderCountCoverage;
}
export interface ClaudeStepObservations
  { readonly turns: ProviderQuantity; readonly coverage: ProviderCountCoverage }
export interface ClaudeResultTelemetry {
  readonly parserVersion: typeof CLAUDE_RESULT_TELEMETRY_VERSION;
  readonly providerRunRef: ProviderRunRef;
  readonly sequence: ProviderQuantity;
  readonly terminal: ProviderTerminalOutcome;
  readonly infrastructure: ProviderInfrastructureOutcome;
  readonly observedModel: ClaudeObservedModel;
  readonly tokens: ClaudeTokenObservations;
  readonly steps: ClaudeStepObservations;
  readonly recordCount: number;
  /** `evidence.sha256` verbatim: it already covers every captured byte. */
  readonly rawReceiptDigest: string;
}
export interface ParseClaudeResultTelemetryInput
  { readonly providerRunRef: unknown; readonly stdout: ClaudeStreamEvidence }
export type ClaudeResultTelemetryVerdict =
  | { readonly ok: true; readonly telemetry: ClaudeResultTelemetry }
  | ProviderTelemetryRefusal;

const refuse = (
  code: ProviderTelemetryCode, layer: ProviderTelemetryLayer,
): ProviderTelemetryRefusal => telemetryRefusal(code, layer);

function recordOf(line: ParsedStreamLine): Readonly<Record<string, unknown>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(line.bytes).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function nested(
  record: Readonly<Record<string, unknown>> | null, key: string,
): Readonly<Record<string, unknown>> | null {
  const value = record === null ? null : record[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function observedModelOf(lines: readonly ParsedStreamLine[]): ClaudeObservedModel {
  const absent = unknownFact("TELEMETRY_MODEL_ABSENT", "TELEMETRY_RESULT");
  const ids = new Set<string>();
  for (const line of lines) {
    if (line.type !== CLAUDE_TELEMETRY_RECORDS.initType) continue;
    if (line.subtype !== CLAUDE_TELEMETRY_RECORDS.initSubtype) continue;
    const observed = readText(recordOf(line), "model", absent);
    if (observed.known) ids.add(observed.value);
  }
  if (ids.size !== 1) {
    const code = ids.size === 0 ? "TELEMETRY_MODEL_ABSENT" : "TELEMETRY_MODEL_AMBIGUOUS";
    const fact = unknownFact(code, "TELEMETRY_RESULT");
    return Object.freeze({ modelId: fact, snapshotKind: "UNKNOWN", snapshotEvidence: fact });
  }
  const [value] = [...ids];
  const modelId: ProviderText = Object.freeze({ known: true as const, value: value as string });
  for (const kind of ["DATED_SNAPSHOT", "BUILD_STAMP"] as const) {
    const evidence = CLAUDE_MODEL_EVIDENCE_PATTERNS[kind].exec(value as string)?.[1];
    if (evidence === undefined) continue;
    return Object.freeze({
      modelId, snapshotKind: kind,
      snapshotEvidence: Object.freeze({ known: true as const, value: evidence }),
    });
  }
  return Object.freeze({ modelId, snapshotKind: "UNKNOWN", snapshotEvidence: absent });
}

function tokensOf(result: Readonly<Record<string, unknown>> | null): ClaudeTokenObservations {
  const absent = unknownFact(
    result === null ? "TELEMETRY_RESULT_ABSENT" : "TELEMETRY_USAGE_ABSENT", "TELEMETRY_RESULT",
  );
  const usage = nested(result, "usage");
  const counts = Object.freeze({
    inputTokens: readCount(usage, CLAUDE_TOKEN_FIELDS.inputTokens, absent),
    outputTokens: readCount(usage, CLAUDE_TOKEN_FIELDS.outputTokens, absent),
    cacheCreationInputTokens:
      readCount(usage, CLAUDE_TOKEN_FIELDS.cacheCreationInputTokens, absent),
    cacheReadInputTokens: readCount(usage, CLAUDE_TOKEN_FIELDS.cacheReadInputTokens, absent),
  });
  return Object.freeze({ ...counts, coverage: countCoverage(Object.values(counts)) });
}

function stepsOf(result: Readonly<Record<string, unknown>> | null): ClaudeStepObservations {
  const absent = unknownFact(
    result === null ? "TELEMETRY_RESULT_ABSENT" : "TELEMETRY_STEPS_ABSENT", "TELEMETRY_RESULT",
  );
  const turns = readCount(result, CLAUDE_STEP_FIELD, absent);
  return Object.freeze({ turns, coverage: countCoverage([turns]) });
}

/**
 * `Object.hasOwn` rather than a bare lookup: `subtype` is provider-supplied, and
 * `"constructor"` would otherwise resolve through the prototype into a value
 * this closed vocabulary never contains.
 */
function terminalOf(subtype: string | null): ProviderTerminalOutcome {
  const supported: Readonly<Record<string, ProviderTerminalOutcome>> = CLAUDE_RESULT_SUBTYPES;
  if (subtype === null || !Object.hasOwn(supported, subtype)) return "UNKNOWN";
  return supported[subtype] ?? "UNKNOWN";
}

function decodeCapture(evidence: ClaudeStreamEvidence): Uint8Array | ProviderTelemetryRefusal {
  if (evidence.complete !== true) return refuse("TELEMETRY_CAPTURE_INCOMPLETE", "TELEMETRY_CAPTURE");
  if (evidence.truncated !== false) return refuse("TELEMETRY_CAPTURE_TRUNCATED", "TELEMETRY_CAPTURE");
  const bytes = Buffer.from(evidence.capturedBase64, "base64");
  if (
    bytes.toString("base64") !== evidence.capturedBase64 ||
    bytes.byteLength !== evidence.byteLength ||
    sha256Hex(bytes) !== evidence.sha256
  ) {
    return refuse("TELEMETRY_CAPTURE_UNDECODABLE", "TELEMETRY_CAPTURE");
  }
  return bytes;
}

export function parseClaudeResultTelemetry(
  input: ParseClaudeResultTelemetryInput,
): ClaudeResultTelemetryVerdict {
  const providerRunRef = snapshotRunRef(input.providerRunRef);
  if (providerRunRef === null) return refuse("TELEMETRY_RUN_REF_MALFORMED", "TELEMETRY_INPUT");
  const decoded = decodeCapture(input.stdout);
  if (!(decoded instanceof Uint8Array)) return decoded;
  const framed = frameStream(decoded);
  if (framed.lineLimitExceeded) return refuse("TELEMETRY_STREAM_ANOMALOUS", "TELEMETRY_SCHEMA");
  const raised = new Set(analyzeStream(framed, CLAUDE_ACCEPTED_SCHEMA_VERSIONS).anomalies);
  for (const [anomaly, code, layer] of ANOMALY_REFUSALS) {
    if (raised.has(anomaly)) return refuse(code, layer);
  }
  const terminalLine = [...framed.lines].reverse()
    .find((line) => line.type === CLAUDE_TELEMETRY_RECORDS.result) ?? null;
  const result = terminalLine === null ? null : recordOf(terminalLine);
  const sequence = terminalLine === null || terminalLine.declaredSequence === null
    ? unknownFact("TELEMETRY_RESULT_ABSENT", "TELEMETRY_RESULT")
    : Object.freeze({ known: true as const, value: terminalLine.declaredSequence });
  return Object.freeze({
    ok: true as const,
    telemetry: Object.freeze({
      parserVersion: CLAUDE_RESULT_TELEMETRY_VERSION,
      providerRunRef,
      sequence,
      terminal: terminalOf(terminalLine?.subtype ?? null),
      infrastructure: "NONE" as const,
      observedModel: observedModelOf(framed.lines),
      tokens: tokensOf(result),
      steps: stepsOf(result),
      recordCount: framed.lines.length,
      rawReceiptDigest: input.stdout.sha256,
    }),
  });
}
