export const CODEX_STREAM_ANOMALIES = Object.freeze([
  "COUNTER_REGRESSION", "DUPLICATE_EVENT", "GAP", "MALFORMED_RECORD", "OUT_OF_ORDER",
  "RESUME_DISCONTINUITY", "TRUNCATION", "UNKNOWN_SCHEMA_VERSION",
] as const);
export type CodexStreamAnomaly = (typeof CODEX_STREAM_ANOMALIES)[number];

export const CODEX_STREAM_DISPOSITIONS = Object.freeze([
  "CANCELLED", "COMPLETED", "INCOMPLETE", "REFUSED_RESUME_UNSUPPORTED", "UNKNOWN",
  "UNKNOWN_SCHEMA",
] as const);
export type CodexStreamDisposition = (typeof CODEX_STREAM_DISPOSITIONS)[number];

export const MAX_FRAMED_LINES = 262_144;
const LF = 0x0a;
const CR = 0x0d;

export interface ParsedStreamLine {
  readonly ordinal: number;
  readonly bytes: Uint8Array;
  readonly declaredSequence: number | null;
  readonly type: string | null;
  readonly subtype: string | null;
  readonly schemaVersion: string | null;
  readonly resumedFrom: string | null;
}

export interface FramedStream {
  readonly lines: readonly ParsedStreamLine[];
  readonly truncatedTailByteLength: number;
  readonly lineLimitExceeded: boolean;
}

function stringField(source: Record<string, unknown>, key: string): string | null {
  return typeof source[key] === "string" ? source[key] : null;
}

function parseLine(ordinal: number, bytes: Uint8Array): ParsedStreamLine {
  const unparsed = {
    ordinal, bytes, declaredSequence: null, type: null, subtype: null,
    schemaVersion: null, resumedFrom: null,
  } satisfies ParsedStreamLine;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return unparsed;
    const record = parsed as Record<string, unknown>;
    if (!Number.isSafeInteger(record["seq"])) return unparsed;
    return {
      ordinal,
      bytes,
      declaredSequence: record["seq"] as number,
      type: stringField(record, "type"),
      subtype: stringField(record, "subtype"),
      schemaVersion: stringField(record, "schemaVersion"),
      resumedFrom: stringField(record, "resumedFrom"),
    };
  } catch { return unparsed; }
}

export function frameStream(rawBytes: Uint8Array): FramedStream {
  const lines: ParsedStreamLine[] = [];
  let start = 0;
  let ordinal = 0;
  for (let index = 0; index < rawBytes.byteLength; index += 1) {
    if (rawBytes[index] !== LF) continue;
    let end = index;
    if (end > start && rawBytes[end - 1] === CR) end -= 1;
    if (end > start) {
      if (lines.length >= MAX_FRAMED_LINES) {
        return Object.freeze({ lines: Object.freeze(lines), truncatedTailByteLength: 0, lineLimitExceeded: true });
      }
      lines.push(parseLine(ordinal, rawBytes.subarray(start, end)));
      ordinal += 1;
    }
    start = index + 1;
  }
  return Object.freeze({
    lines: Object.freeze(lines),
    truncatedTailByteLength: rawBytes.byteLength - start,
    lineLimitExceeded: false,
  });
}

function analyzeSequences(lines: readonly ParsedStreamLine[]): Set<CodexStreamAnomaly> {
  const anomalies = new Set<CodexStreamAnomaly>();
  const seen = new Set<number>();
  let first: number | null = null;
  let last: number | null = null;
  let malformed = 0;
  for (const line of lines) {
    if (line.resumedFrom !== null) anomalies.add("RESUME_DISCONTINUITY");
    if (line.declaredSequence === null) {
      anomalies.add("MALFORMED_RECORD");
      malformed += 1;
      if (last !== null) last += 1;
      continue;
    }
    const sequence = line.declaredSequence;
    if (first === null) first = sequence;
    else if (seen.has(sequence)) { anomalies.add("DUPLICATE_EVENT"); continue; }
    else if (sequence <= first) anomalies.add("COUNTER_REGRESSION");
    else if (last !== null && sequence < last) anomalies.add("OUT_OF_ORDER");
    seen.add(sequence);
    last = sequence;
  }
  if (!anomalies.has("COUNTER_REGRESSION") && seen.size > 0) {
    const sequences = [...seen];
    const span = Math.max(...sequences) - Math.min(...sequences) + 1;
    if (seen.size + malformed < span) anomalies.add("GAP");
  }
  return anomalies;
}

export interface StreamAnalysis {
  readonly anomalies: readonly CodexStreamAnomaly[];
  readonly disposition: CodexStreamDisposition;
}

const DESTRUCTIVE = Object.freeze([
  "COUNTER_REGRESSION", "GAP", "MALFORMED_RECORD", "TRUNCATION",
] as const satisfies readonly CodexStreamAnomaly[]);

function terminalDisposition(lines: readonly ParsedStreamLine[]): CodexStreamDisposition | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line?.type === "result") return line.subtype === "cancelled" ? "CANCELLED" : "COMPLETED";
  }
  return null;
}

function resolveDisposition(
  anomalies: ReadonlySet<CodexStreamAnomaly>,
  lines: readonly ParsedStreamLine[],
): CodexStreamDisposition {
  if (anomalies.has("RESUME_DISCONTINUITY")) return "REFUSED_RESUME_UNSUPPORTED";
  if (anomalies.has("UNKNOWN_SCHEMA_VERSION")) return "UNKNOWN_SCHEMA";
  if (DESTRUCTIVE.some((anomaly) => anomalies.has(anomaly))) return "UNKNOWN";
  return terminalDisposition(lines) ?? "INCOMPLETE";
}

export function analyzeStream(
  framed: FramedStream,
  acceptedSchemaVersions: readonly string[],
): StreamAnalysis {
  const collected = analyzeSequences(framed.lines);
  if (framed.truncatedTailByteLength > 0) collected.add("TRUNCATION");
  for (const line of framed.lines) {
    if (line.declaredSequence !== null && !acceptedSchemaVersions.includes(line.schemaVersion ?? "")) {
      collected.add("UNKNOWN_SCHEMA_VERSION");
    }
  }
  const anomalies = CODEX_STREAM_ANOMALIES.filter((value) => collected.has(value));
  return Object.freeze({
    anomalies: Object.freeze(anomalies),
    disposition: resolveDisposition(collected, framed.lines),
  });
}
