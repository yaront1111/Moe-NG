import { canonicalDigest, deepFreeze, isSafeByteCount, sha256Hex } from "../../canonical.js";
import {
  MAX_FRAMED_LINES,
  analyzeStream,
  frameStream,
  type ClaudeStreamAnomaly,
  type ClaudeStreamDisposition,
} from "./claude-stream-anomalies.js";
import { claudeFailure, type ClaudeFailure } from "./claude-observation.js";

/**
 * Dual record of a Claude provider stream: the raw capture and the structured
 * events parsed from it, both bound to one stable Moe effect identity.
 *
 * ## Retention is bounded, coverage is not
 *
 * The digest always covers every captured byte — that is what "adapters
 * preserve raw structured provider output by digest" (design 11.5) requires,
 * and it must not depend on how large the output was. Verbatim INLINE retention
 * is a different question and is bounded by design 19.1: 16 MiB of capture plus
 * a 64 KiB inspectable tail, with anything larger streaming to a quota-bound
 * artifact. So an over-limit stream yields a typed artifact-ref outcome that
 * still names the exact byte count and digest of the whole capture. It is never
 * an unbounded buffer, and it is never silent truncation.
 */
export const CLAUDE_STREAM_RECORD_VERSION = "moe-claude-stream-record/1" as const;

/** design 19.1: captured stdout/stderr 16 MiB plus a 64 KiB inspectable tail. */
export const MAX_INLINE_STREAM_BYTES = 16 * 1024 * 1024;
export const MAX_INSPECTABLE_TAIL_BYTES = 64 * 1024;

export const CLAUDE_ACCEPTED_SCHEMA_VERSIONS = Object.freeze(["claude-stream-json/1"] as const);

export const CLAUDE_STREAM_ERROR_CODES = Object.freeze([
  "CLAUDE_STREAM_BYTES_INVALID",
  "CLAUDE_STREAM_EFFECT_IDENTITY_INVALID",
  "CLAUDE_STREAM_EVENT_LIMIT_EXCEEDED",
  "CLAUDE_STREAM_SCHEMA_ALLOWLIST_EMPTY",
] as const);
export type ClaudeStreamErrorCode = (typeof CLAUDE_STREAM_ERROR_CODES)[number];

export interface MoeEffectIdentity {
  readonly effectIntentId: string;
  readonly attemptRef: string;
  readonly epoch: number;
}

export interface ClaudeStreamEvent {
  readonly ordinal: number;
  readonly effectIntentId: string;
  readonly attemptRef: string;
  readonly epoch: number;
  readonly declaredSequence: number | null;
  readonly type: string | null;
  readonly schemaVersion: string | null;
  readonly byteLength: number;
  readonly lineSha256: string;
  /** Null when verbatim retention would breach the bounds above. */
  readonly lineBase64: string | null;
}

export type ClaudeRawRetention =
  | {
      readonly kind: "INLINE";
      readonly byteLength: number;
      readonly sha256: string;
      readonly rawBase64: string;
      readonly tailBase64: string;
    }
  | {
      readonly kind: "ARTIFACT_REF";
      readonly byteLength: number;
      readonly sha256: string;
      readonly tailBase64: string;
      readonly artifactRequired: true;
    };

export interface ClaudeStreamRecord {
  readonly recordVersion: typeof CLAUDE_STREAM_RECORD_VERSION;
  readonly effect: MoeEffectIdentity;
  readonly disposition: ClaudeStreamDisposition;
  readonly anomalies: readonly ClaudeStreamAnomaly[];
  readonly events: readonly ClaudeStreamEvent[];
  readonly raw: ClaudeRawRetention;
  readonly recordDigest: string;
}

export interface RecordClaudeStreamInput {
  readonly rawBytes: Uint8Array;
  readonly effect: MoeEffectIdentity;
  readonly acceptedSchemaVersions: readonly string[];
}

export interface RecordClaudeStreamOk {
  readonly ok: true;
  readonly record: ClaudeStreamRecord;
}

export type RecordClaudeStreamResult = RecordClaudeStreamOk | ClaudeFailure<ClaudeStreamErrorCode>;

export type { ClaudeStreamAnomaly, ClaudeStreamDisposition } from "./claude-stream-anomalies.js";
export { CLAUDE_STREAM_ANOMALIES, CLAUDE_STREAM_DISPOSITIONS } from "./claude-stream-anomalies.js";

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function retain(rawBytes: Uint8Array): ClaudeRawRetention {
  const byteLength = rawBytes.byteLength;
  const sha256 = sha256Hex(rawBytes);
  const tailStart = Math.max(0, byteLength - MAX_INSPECTABLE_TAIL_BYTES);
  const tailBase64 = base64(rawBytes.subarray(tailStart));
  if (byteLength > MAX_INLINE_STREAM_BYTES) {
    return { kind: "ARTIFACT_REF", byteLength, sha256, tailBase64, artifactRequired: true };
  }
  return { kind: "INLINE", byteLength, sha256, rawBase64: base64(rawBytes), tailBase64 };
}

function isBoundedRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

/**
 * The digest input carries identities and byte counts, never the payloads. A
 * digest that embedded the capture would grow without bound and would defeat
 * the retention rule it is supposed to work alongside.
 */
function recordDigestInput(
  effect: MoeEffectIdentity,
  analysis: ReturnType<typeof analyzeStream>,
  events: readonly ClaudeStreamEvent[],
  raw: ClaudeRawRetention,
): Record<string, unknown> {
  return {
    recordVersion: CLAUDE_STREAM_RECORD_VERSION,
    effect: {
      effectIntentId: effect.effectIntentId,
      attemptRef: effect.attemptRef,
      epoch: effect.epoch,
    },
    disposition: analysis.disposition,
    anomalies: [...analysis.anomalies],
    events: events.map((event) => ({
      ordinal: event.ordinal,
      declaredSequence: event.declaredSequence,
      type: event.type,
      schemaVersion: event.schemaVersion,
      byteLength: event.byteLength,
      lineSha256: event.lineSha256,
    })),
    raw: { kind: raw.kind, byteLength: raw.byteLength, sha256: raw.sha256 },
  };
}

export function recordClaudeStream(input: RecordClaudeStreamInput): RecordClaudeStreamResult {
  if (!(input.rawBytes instanceof Uint8Array)) {
    return claudeFailure("CLAUDE_STREAM_BYTES_INVALID", "raw stream capture must be bytes");
  }
  const effect = input.effect;
  if (
    !isBoundedRef(effect.effectIntentId) ||
    !isBoundedRef(effect.attemptRef) ||
    !isSafeByteCount(effect.epoch)
  ) {
    return claudeFailure(
      "CLAUDE_STREAM_EFFECT_IDENTITY_INVALID",
      "every event binds a stable effect intent, attempt, and epoch",
    );
  }
  if (input.acceptedSchemaVersions.length === 0) {
    return claudeFailure(
      "CLAUDE_STREAM_SCHEMA_ALLOWLIST_EMPTY",
      "an empty schema allowlist would accept nothing and report every record as unknown",
    );
  }
  const framed = frameStream(input.rawBytes);
  if (framed.lineLimitExceeded) {
    return claudeFailure(
      "CLAUDE_STREAM_EVENT_LIMIT_EXCEEDED",
      `capture holds more than ${MAX_FRAMED_LINES} records; refusing rather than keeping a silent prefix`,
    );
  }
  const analysis = analyzeStream(framed, input.acceptedSchemaVersions);
  const raw = retain(input.rawBytes);
  const events = framed.lines.map((line): ClaudeStreamEvent => {
    const retainable =
      raw.kind === "INLINE" && line.bytes.byteLength <= MAX_INSPECTABLE_TAIL_BYTES;
    return {
      ordinal: line.ordinal,
      effectIntentId: effect.effectIntentId,
      attemptRef: effect.attemptRef,
      epoch: effect.epoch,
      declaredSequence: line.declaredSequence,
      type: line.type,
      schemaVersion: line.schemaVersion,
      byteLength: line.bytes.byteLength,
      lineSha256: sha256Hex(line.bytes),
      lineBase64: retainable ? base64(line.bytes) : null,
    };
  });
  const record = deepFreeze({
    recordVersion: CLAUDE_STREAM_RECORD_VERSION,
    effect: {
      effectIntentId: effect.effectIntentId,
      attemptRef: effect.attemptRef,
      epoch: effect.epoch,
    },
    disposition: analysis.disposition,
    anomalies: analysis.anomalies,
    events,
    raw,
    recordDigest: canonicalDigest(recordDigestInput(effect, analysis, events, raw)),
  } satisfies ClaudeStreamRecord);
  return Object.freeze({ ok: true as const, record });
}
