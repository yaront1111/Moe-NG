/**
 * A SEAT'S OWN OUTPUT, on its way from the child's pipes to the wrapper's console and to a BOUNDED
 * TAIL, so the exit classifier can read the provider's last words without the wrapper ever holding
 * a seat's whole transcript. Both tail bounds are hard: a seat that prints a megabyte on one line,
 * or a hundred thousand lines, must cost the same fixed memory as a quiet one.
 *
 * A claude seat runs `--output-format stream-json`, so every event is a stdout line and a working
 * seat is seen speaking. Its stdout is DECODED back to exactly what a text-mode seat printed: each
 * result event's text plus a newline, and every non-event line verbatim (measured byte for byte on
 * claude 2.1.277, task-815f803d comment-7c263f1c point 3). So the console, the tail and the exit
 * classifier see what they always saw, and the events themselves count only as activity.
 *
 * Pure: no process access, no I/O. The sinks are injected; every `push` and stream method accepts
 * exactly what a stream's `data` event hands over.
 */

export interface OutputTailOptions {
  readonly maxBytes?: number;
  readonly maxLines?: number;
}

export interface OutputTail {
  /** Bytes currently retained across every line `lines()` would return. */
  bytes(): number;
  /** The retained lines oldest-first, including a partial trailing line. Frozen. */
  lines(): readonly string[];
  push(chunk: Buffer | string): void;
}

const DEFAULT_MAX_LINES = 40;
const DEFAULT_MAX_BYTES = 16_384;

function widthOf(line: string): number {
  return Buffer.byteLength(line, "utf8");
}

/**
 * The last `limit` bytes of an over-long line. The TAIL is what matters: a provider's refusal
 * sentence trails whatever noise the seat printed before it. A leading replacement character is
 * dropped because slicing by bytes can land mid-sequence.
 */
function truncateTail(line: string, limit: number): string {
  const encoded = Buffer.from(line, "utf8");
  if (encoded.length <= limit) return line;
  const text = new TextDecoder("utf-8", { fatal: false })
    .decode(encoded.subarray(encoded.length - limit));
  return text.startsWith("�") ? text.slice(1) : text;
}

export function createOutputTail(options: OutputTailOptions = {}): OutputTail {
  const maxLines = Math.max(1, options.maxLines ?? DEFAULT_MAX_LINES);
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
  // One decoder for the life of the tail: a multi-byte sequence split across two chunks is held
  // by `stream: true` until its continuation bytes arrive, so no character is ever corrupted.
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const kept: string[] = [];
  let keptBytes = 0;
  let partial = "";

  const partialBytes = (): number => (partial === "" ? 0 : widthOf(partial));
  const count = (): number => kept.length + (partial === "" ? 0 : 1);
  const total = (): number => keptBytes + partialBytes();

  function dropOldest(): void {
    const oldest = kept.shift();
    if (oldest === undefined) {
      partial = "";
      return;
    }
    keptBytes -= widthOf(oldest);
  }

  function enforce(): void {
    while (count() > maxLines) dropOldest();
    // Stop at one survivor: a lone over-long line is truncated rather than dropped, so the seat's
    // last words are never lost to a line that happened to be long.
    while (count() > 1 && total() > maxBytes) dropOldest();
    if (total() <= maxBytes) return;
    if (partial !== "") {
      partial = truncateTail(partial, maxBytes);
      return;
    }
    const only = kept[0];
    if (only === undefined) return;
    kept[0] = truncateTail(only, maxBytes);
    keptBytes = widthOf(kept[0] as string);
  }

  function push(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (text === "") return;
    const segments = (partial + text).split("\n");
    partial = segments.pop() ?? "";
    for (const segment of segments) {
      const line = segment.endsWith("\r") ? segment.slice(0, -1) : segment;
      kept.push(line);
      keptBytes += widthOf(line);
      // Enforced per line, not per chunk: a 64 KiB chunk must never materialise every line it
      // carries before the bounds are applied.
      enforce();
    }
    enforce();
  }

  return {
    bytes: () => total(),
    lines: () => Object.freeze(partial === "" ? [...kept] : [...kept, partial]),
    push,
  };
}

/** An event line longer than this is dropped whole; the only line decoded is a seat's report. */
export const STREAM_JSON_MAX_LINE_BYTES = 1_048_576;

export interface StreamJsonReport {
  /** What a text-mode seat would have printed for this chunk; empty while an event line is open. */
  push(chunk: Buffer): Buffer;
  /** Settles a line still open at the end of the stream. */
  flush(): Buffer;
}

const LINE_FEED = 0x0A;
const OPEN_BRACE = 0x7B;
const QUOTE = 0x22;
const NOTHING = Buffer.alloc(0);
const NEWLINE = Buffer.from("\n", "utf8");

/**
 * What text mode printed for one `{` line: a result event's text plus a newline, a line that is
 * not JSON as it came, any other event nothing. The line is PARSED, never prefix-matched: the
 * measured result event's first key is `duration_api_ms`, not `type`.
 *
 * `atEnd` is a line the stream closed on before its newline. One that opens like an event (`{"`)
 * yet does not parse was CUT mid-write (the seat was killed): text mode never printed it, and the
 * model-authored text inside it must never reach the exit classifier, so it yields nothing.
 */
function reportOf(line: Buffer, atEnd: boolean): Buffer {
  let event: { readonly result?: unknown; readonly type?: unknown };
  try {
    event = JSON.parse(line.toString("utf8")) as typeof event;
  } catch {
    if (!atEnd) return Buffer.concat([line, NEWLINE]);
    return line[1] === QUOTE ? NOTHING : line;
  }
  return event.type === "result" && typeof event.result === "string"
    ? Buffer.from(`${event.result}\n`, "utf8") : NOTHING;
}

/**
 * Decodes a claude seat's stream-json stdout into its text-mode report. It works on BYTES and
 * splits at 0x0A, which UTF-8 never puts inside a multi-byte sequence. A line's first byte sets
 * its mode: `{` buffers it to its newline and decodes it whole; anything else passes through on
 * the push that brought it, so plain text (a scripted seat, a CLI warning) is never held back.
 */
export function createStreamJsonReport(): StreamJsonReport {
  // "skip" is an event line over the bound: dropped, with every byte up to its newline.
  let mode: "event" | "skip" | "start" | "text" = "start";
  let held: Buffer[] = [];
  let heldBytes = 0;
  const reset = (): void => { held = []; heldBytes = 0; mode = "start"; };

  function push(chunk: Buffer): Buffer {
    const out: Buffer[] = [];
    let at = 0;
    while (at < chunk.length) {
      if (mode === "start") mode = chunk[at] === OPEN_BRACE ? "event" : "text";
      const newline = chunk.indexOf(LINE_FEED, at);
      const end = newline === -1 ? chunk.length : newline;
      if (mode === "text") out.push(chunk.subarray(at, newline === -1 ? end : newline + 1));
      else if (mode === "event" && heldBytes + end - at > STREAM_JSON_MAX_LINE_BYTES) {
        held = [];
        mode = "skip";
      } else if (mode === "event") {
        held.push(chunk.subarray(at, end));
        heldBytes += end - at;
      }
      if (newline === -1) break;
      if (mode === "event") out.push(reportOf(Buffer.concat(held), false));
      reset();
      at = newline + 1;
    }
    return Buffer.concat(out);
  }

  function flush(): Buffer {
    // No newline is added to a line the seat never ended: text mode would not have printed one.
    const last = mode === "event" ? reportOf(Buffer.concat(held), true) : NOTHING;
    reset();
    return last;
  }

  return Object.freeze({ flush, push });
}

type ByteSink = { write(chunk: Buffer): unknown };

export interface SeatOutputOptions {
  /** Every raw byte either pipe carried, events included: the seat's output-activity signal. */
  readonly onBytes: (bytes: number) => void;
  readonly sinks: { readonly stderr: ByteSink; readonly stdout: ByteSink };
  /** The seat's stdout is stream-json (a claude seat): decode it to the text-mode report. */
  readonly streamJson: boolean;
}

export interface SeatOutput {
  /** The child's pipes are closed: settle any report line still open. */
  close(): void;
  /** The seat printed report text or any stderr byte; protocol events alone do not count. */
  seen(): boolean;
  stderr(chunk: Buffer): void;
  stdout(chunk: Buffer): void;
  tail(): readonly string[];
}

/** The tee: each pipe to its sink and to one bounded tail, a claude seat's stdout decoded first. */
export function createSeatOutput(options: SeatOutputOptions): SeatOutput {
  const tail = createOutputTail();
  const report = options.streamJson ? createStreamJsonReport() : undefined;
  let seen = false;
  const forward = (sink: ByteSink, bytes: Buffer): void => {
    if (bytes.length === 0) return;
    seen = true;
    sink.write(bytes);
    tail.push(bytes);
  };
  return Object.freeze({
    close: (): void => { if (report !== undefined) forward(options.sinks.stdout, report.flush()); },
    seen: (): boolean => seen,
    stderr: (chunk: Buffer): void => {
      options.onBytes(chunk.length);
      forward(options.sinks.stderr, chunk);
    },
    stdout: (chunk: Buffer): void => {
      options.onBytes(chunk.length);
      forward(options.sinks.stdout, report === undefined ? chunk : report.push(chunk));
    },
    tail: (): readonly string[] => tail.lines(),
  });
}
