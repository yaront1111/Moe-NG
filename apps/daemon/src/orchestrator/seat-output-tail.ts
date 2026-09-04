/**
 * A BOUNDED TAIL of a seat's own output.
 *
 * The wrapper tees a seat's stdout/stderr through here on the way to its own streams, so the exit
 * classifier can read the provider's last words without the wrapper ever holding a seat's whole
 * transcript. Both bounds are hard: a seat that prints a megabyte on one line, or a hundred
 * thousand lines, must cost the same fixed memory as a quiet one.
 *
 * Pure: no process access, no I/O. `push` accepts exactly what a stream's `data` event hands over.
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
