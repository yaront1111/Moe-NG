/**
 * Line framing, record parsing, and the closed anomaly vocabulary for a Claude
 * provider stream (design 11.5).
 *
 * Nothing here reads bytes from a process — it is handed the complete raw
 * capture and reports what the bytes say. That keeps every judgement about a
 * stream reproducible from the stored capture alone.
 */
export const CLAUDE_STREAM_ANOMALIES = Object.freeze([
  "COUNTER_REGRESSION",
  "DUPLICATE_EVENT",
  "GAP",
  "MALFORMED_RECORD",
  "OUT_OF_ORDER",
  "RESUME_DISCONTINUITY",
  "TRUNCATION",
  "UNKNOWN_SCHEMA_VERSION",
] as const);
export type ClaudeStreamAnomaly = (typeof CLAUDE_STREAM_ANOMALIES)[number];

/**
 * `UNKNOWN_SCHEMA` is deliberately its own disposition and NOT the wrapper's
 * `PROVIDER_CAPABILITY_CHANGED`. That code is the wrapper's pre-activation
 * refusal when a resolved runtime no longer matches its quote-bound
 * observation; this one is a mid-stream record the adapter cannot read. Keeping
 * them distinct is what lets a reconciler tell "the runtime changed under us"
 * from "this run emitted something we do not understand".
 */
export const CLAUDE_STREAM_DISPOSITIONS = Object.freeze([
  "CANCELLED",
  "COMPLETED",
  "INCOMPLETE",
  "REFUSED_RESUME_UNSUPPORTED",
  "UNKNOWN",
  "UNKNOWN_SCHEMA",
] as const);
export type ClaudeStreamDisposition = (typeof CLAUDE_STREAM_DISPOSITIONS)[number];

const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

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
  /** Bytes after the last newline. Non-zero means the capture was cut. */
  readonly truncatedTailByteLength: number;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function parseLine(ordinal: number, bytes: Uint8Array): ParsedStreamLine {
  const unparsed: ParsedStreamLine = {
    ordinal,
    bytes,
    declaredSequence: null,
    type: null,
    subtype: null,
    schemaVersion: null,
    resumedFrom: null,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return unparsed;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return unparsed;
  }
  const record = parsed as Record<string, unknown>;
  const sequence = record["seq"];
  if (!Number.isSafeInteger(sequence)) {
    return unparsed;
  }
  return {
    ordinal,
    bytes,
    declaredSequence: sequence as number,
    type: readString(record, "type"),
    subtype: readString(record, "subtype"),
    schemaVersion: readString(record, "schemaVersion"),
    resumedFrom: readString(record, "resumedFrom"),
  };
}

/**
 * Frames on `\n` and strips one trailing `\r`, so a Windows CRLF capture yields
 * the same records as a POSIX one while the raw bytes stay untouched for the
 * digest. A non-empty segment after the final newline is a cut capture, not a
 * record: emitting it as one would let a half-written line be read as content.
 */
export function frameStream(rawBytes: Uint8Array): FramedStream {
  const lines: ParsedStreamLine[] = [];
  let start = 0;
  let ordinal = 0;
  for (let index = 0; index < rawBytes.byteLength; index += 1) {
    if (rawBytes[index] !== LINE_FEED) {
      continue;
    }
    let end = index;
    if (end > start && rawBytes[end - 1] === CARRIAGE_RETURN) {
      end -= 1;
    }
    if (end > start) {
      lines.push(parseLine(ordinal, rawBytes.subarray(start, end)));
      ordinal += 1;
    }
    start = index + 1;
  }
  return Object.freeze({
    lines: Object.freeze(lines),
    truncatedTailByteLength: rawBytes.byteLength - start,
  });
}

interface SequenceAnalysis {
  readonly anomalies: ReadonlySet<ClaudeStreamAnomaly>;
}

/**
 * Gap analysis runs over the SET of observed sequences, not delivery order.
 * Out-of-order delivery looks exactly like a gap followed by a late arrival, so
 * judging it record-by-record would report a hole that the next record fills. A
 * malformed record still occupied a slot in the stream — it is counted as one,
 * because treating an unreadable record as a missing one invents a gap.
 *
 * When the counter restarts, contiguity is undefined across the restart, so gap
 * analysis is skipped rather than guessed.
 */
function analyzeSequences(lines: readonly ParsedStreamLine[]): SequenceAnalysis {
  const anomalies = new Set<ClaudeStreamAnomaly>();
  const seen = new Set<number>();
  let firstSequence: number | null = null;
  let lastSequence: number | null = null;
  let malformedCount = 0;
  for (const line of lines) {
    if (line.resumedFrom !== null) {
      anomalies.add("RESUME_DISCONTINUITY");
    }
    if (line.declaredSequence === null) {
      anomalies.add("MALFORMED_RECORD");
      malformedCount += 1;
      if (lastSequence !== null) {
        lastSequence += 1;
      }
      continue;
    }
    const sequence = line.declaredSequence;
    if (firstSequence === null) {
      firstSequence = sequence;
    } else if (seen.has(sequence)) {
      anomalies.add("DUPLICATE_EVENT");
      continue;
    } else if (sequence <= firstSequence) {
      anomalies.add("COUNTER_REGRESSION");
    } else if (lastSequence !== null && sequence < lastSequence) {
      anomalies.add("OUT_OF_ORDER");
    }
    seen.add(sequence);
    lastSequence = sequence;
  }
  if (!anomalies.has("COUNTER_REGRESSION") && seen.size > 0) {
    const sequences = [...seen];
    const span = Math.max(...sequences) - Math.min(...sequences) + 1;
    if (seen.size + malformedCount < span) {
      anomalies.add("GAP");
    }
  }
  return { anomalies };
}

export interface StreamAnalysis {
  readonly anomalies: readonly ClaudeStreamAnomaly[];
  readonly disposition: ClaudeStreamDisposition;
}

/** Anomalies that mean the stream can no longer prove what happened. */
const DESTRUCTIVE: readonly ClaudeStreamAnomaly[] = Object.freeze([
  "COUNTER_REGRESSION",
  "GAP",
  "MALFORMED_RECORD",
  "TRUNCATION",
]);

function terminalDisposition(
  lines: readonly ParsedStreamLine[],
): ClaudeStreamDisposition | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line?.type === "result") {
      return line.subtype === "cancelled" ? "CANCELLED" : "COMPLETED";
    }
  }
  return null;
}

/**
 * Precedence, strongest first: a resumed stream is refused outright because
 * RESUME is `UNSUPPORTED` in v1; an unreadable schema comes next because we
 * cannot interpret what follows; then anything that destroyed the evidence;
 * only then may a terminal record speak for the run.
 */
export function analyzeStream(
  framed: FramedStream,
  acceptedSchemaVersions: readonly string[],
): StreamAnalysis {
  const { anomalies } = analyzeSequences(framed.lines);
  const collected = new Set(anomalies);
  if (framed.truncatedTailByteLength > 0) {
    collected.add("TRUNCATION");
  }
  for (const line of framed.lines) {
    if (line.declaredSequence !== null && !acceptedSchemaVersions.includes(line.schemaVersion ?? "")) {
      collected.add("UNKNOWN_SCHEMA_VERSION");
    }
  }
  const ordered = CLAUDE_STREAM_ANOMALIES.filter((anomaly) => collected.has(anomaly));
  const disposition = resolveDisposition(collected, framed.lines);
  return Object.freeze({ anomalies: Object.freeze(ordered), disposition });
}

function resolveDisposition(
  anomalies: ReadonlySet<ClaudeStreamAnomaly>,
  lines: readonly ParsedStreamLine[],
): ClaudeStreamDisposition {
  if (anomalies.has("RESUME_DISCONTINUITY")) {
    return "REFUSED_RESUME_UNSUPPORTED";
  }
  if (anomalies.has("UNKNOWN_SCHEMA_VERSION")) {
    return "UNKNOWN_SCHEMA";
  }
  if (DESTRUCTIVE.some((anomaly) => anomalies.has(anomaly))) {
    return "UNKNOWN";
  }
  return terminalDisposition(lines) ?? "INCOMPLETE";
}
