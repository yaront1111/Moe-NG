import { canonicalDigest, deepFreeze, isSafeByteCount, sha256Hex } from "../../canonical.js";
import { codexFailure, type CodexFailure } from "./codex-observation.js";
import {
  MAX_FRAMED_LINES,
  analyzeStream,
  frameStream,
  type CodexStreamAnomaly,
  type CodexStreamDisposition,
} from "./codex-stream-anomalies.js";

export const CODEX_STREAM_RECORD_VERSION = "moe-codex-stream-record/1" as const;
export const MAX_INLINE_STREAM_BYTES = 16 * 1024 * 1024;
export const MAX_INSPECTABLE_TAIL_BYTES = 64 * 1024;
export const CODEX_ACCEPTED_SCHEMA_VERSIONS = Object.freeze(["codex-stream-json/1"] as const);

export const CODEX_STREAM_ERROR_CODES = Object.freeze([
  "CODEX_STREAM_BYTES_INVALID",
  "CODEX_STREAM_EFFECT_IDENTITY_INVALID",
  "CODEX_STREAM_EVENT_LIMIT_EXCEEDED",
  "CODEX_STREAM_SCHEMA_ALLOWLIST_EMPTY",
] as const);
export type CodexStreamErrorCode = (typeof CODEX_STREAM_ERROR_CODES)[number];

export interface MoeEffectIdentity {
  readonly effectIntentId: string;
  readonly attemptRef: string;
  readonly epoch: number;
}

export interface CodexStreamEvent {
  readonly ordinal: number;
  readonly effectIntentId: string;
  readonly attemptRef: string;
  readonly epoch: number;
  readonly declaredSequence: number | null;
  readonly type: string | null;
  readonly schemaVersion: string | null;
  readonly byteLength: number;
  readonly lineSha256: string;
  readonly lineBase64: string | null;
}

export type CodexRawRetention =
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

export interface CodexStreamRecord {
  readonly recordVersion: typeof CODEX_STREAM_RECORD_VERSION;
  readonly effect: MoeEffectIdentity;
  readonly disposition: CodexStreamDisposition;
  readonly anomalies: readonly CodexStreamAnomaly[];
  readonly events: readonly CodexStreamEvent[];
  readonly raw: CodexRawRetention;
  readonly recordDigest: string;
}

export interface RecordCodexStreamInput {
  readonly rawBytes: Uint8Array;
  readonly effect: MoeEffectIdentity;
  readonly acceptedSchemaVersions: readonly string[];
}

export type RecordCodexStreamResult =
  | { readonly ok: true; readonly record: CodexStreamRecord }
  | CodexFailure<CodexStreamErrorCode>;

export type { CodexStreamAnomaly, CodexStreamDisposition } from "./codex-stream-anomalies.js";
export { CODEX_STREAM_ANOMALIES, CODEX_STREAM_DISPOSITIONS } from "./codex-stream-anomalies.js";

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function retain(rawBytes: Uint8Array): CodexRawRetention {
  const byteLength = rawBytes.byteLength;
  const sha256 = sha256Hex(rawBytes);
  const tailBase64 = base64(rawBytes.subarray(Math.max(0, byteLength - MAX_INSPECTABLE_TAIL_BYTES)));
  if (byteLength > MAX_INLINE_STREAM_BYTES) {
    return { kind: "ARTIFACT_REF", byteLength, sha256, tailBase64, artifactRequired: true };
  }
  return { kind: "INLINE", byteLength, sha256, rawBase64: base64(rawBytes), tailBase64 };
}

function boundedRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function recordDigestInput(
  effect: MoeEffectIdentity,
  analysis: ReturnType<typeof analyzeStream>,
  events: readonly CodexStreamEvent[],
  raw: CodexRawRetention,
): Record<string, unknown> {
  return {
    recordVersion: CODEX_STREAM_RECORD_VERSION,
    effect: { ...effect },
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

export function recordCodexStream(input: RecordCodexStreamInput): RecordCodexStreamResult {
  if (!(input.rawBytes instanceof Uint8Array)) {
    return codexFailure("CODEX_STREAM_BYTES_INVALID", "raw stream capture must be bytes");
  }
  const effect = input.effect;
  if (!boundedRef(effect.effectIntentId) || !boundedRef(effect.attemptRef) ||
      !isSafeByteCount(effect.epoch)) {
    return codexFailure(
      "CODEX_STREAM_EFFECT_IDENTITY_INVALID",
      "every event binds a stable effect intent, attempt, and epoch",
    );
  }
  if (!Array.isArray(input.acceptedSchemaVersions) || input.acceptedSchemaVersions.length === 0) {
    return codexFailure("CODEX_STREAM_SCHEMA_ALLOWLIST_EMPTY", "schema allowlist must be non-empty");
  }
  const framed = frameStream(input.rawBytes);
  if (framed.lineLimitExceeded) {
    return codexFailure(
      "CODEX_STREAM_EVENT_LIMIT_EXCEEDED",
      `capture holds more than ${MAX_FRAMED_LINES} records`,
    );
  }
  const analysis = analyzeStream(framed, input.acceptedSchemaVersions);
  const raw = retain(input.rawBytes);
  const events = framed.lines.map((line): CodexStreamEvent => ({
    ordinal: line.ordinal,
    effectIntentId: effect.effectIntentId,
    attemptRef: effect.attemptRef,
    epoch: effect.epoch,
    declaredSequence: line.declaredSequence,
    type: line.type,
    schemaVersion: line.schemaVersion,
    byteLength: line.bytes.byteLength,
    lineSha256: sha256Hex(line.bytes),
    lineBase64: raw.kind === "INLINE" && line.bytes.byteLength <= MAX_INSPECTABLE_TAIL_BYTES ?
      base64(line.bytes) : null,
  }));
  const record = deepFreeze({
    recordVersion: CODEX_STREAM_RECORD_VERSION,
    effect: { ...effect },
    disposition: analysis.disposition,
    anomalies: analysis.anomalies,
    events,
    raw,
    recordDigest: canonicalDigest(recordDigestInput(effect, analysis, events, raw)),
  } satisfies CodexStreamRecord);
  return Object.freeze({ ok: true as const, record });
}
