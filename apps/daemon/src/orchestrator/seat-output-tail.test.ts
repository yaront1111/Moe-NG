import { describe, expect, it } from "vitest";

import { SEAT_EXIT_ROSTER } from "./seat-exit-classifier.js";
import { createOutputTail, createSeatOutput, createStreamJsonReport,
  STREAM_JSON_MAX_LINE_BYTES } from "./seat-output-tail.js";

const MAX_BYTES = 16_384;

/** A seeded PRNG so the property loop is reproducible; mulberry32. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function byteLength(lines: readonly string[]): number {
  return lines.reduce((total, line) => total + Buffer.byteLength(line, "utf8"), 0);
}

describe("createOutputTail", () => {
  it("keeps only the last 40 of 100 pushed lines, in order", () => {
    const tail = createOutputTail();
    for (let index = 0; index < 100; index += 1) tail.push(`line ${index}\n`);
    const lines = tail.lines();
    expect(lines.length).toBe(40);
    expect(lines[0]).toBe("line 60");
    expect(lines[39]).toBe("line 99");
  });

  it("bounds a 64 KiB single chunk to the last 16 KiB, split on newlines", () => {
    const tail = createOutputTail();
    // 64 lines of 1023 bytes each = exactly 64 KiB with the newlines. Under the 40-line cap, so
    // it is the BYTE bound that has to do the work here: 16384 / 1023 leaves 16 lines.
    const chunk = Array.from(
      { length: 64 },
      (_v, i) => `${String(i).padStart(4, "0")}${"x".repeat(1019)}`,
    ).join("\n");
    expect(Buffer.byteLength(`${chunk}\n`, "utf8")).toBe(64 * 1024);
    tail.push(`${chunk}\n`);
    const lines = tail.lines();
    expect(lines.length).toBe(16);
    expect(byteLength(lines)).toBeLessThanOrEqual(MAX_BYTES);
    expect(tail.bytes()).toBe(16 * 1023);
    expect((lines[0] as string).startsWith("0048")).toBe(true);
    expect((lines[15] as string).startsWith("0063")).toBe(true);
  });

  it("drops a single line longer than maxBytes down to its last maxBytes without hanging", () => {
    const tail = createOutputTail();
    tail.push(`${"y".repeat(1_000_000)}\n`);
    expect(tail.bytes()).toBeLessThanOrEqual(MAX_BYTES);
    const lines = tail.lines();
    expect(lines.length).toBe(1);
    expect((lines[0] as string).length).toBeLessThanOrEqual(MAX_BYTES);
    // The TAIL of the line survives, not its head: the refusal sentence trails the noise.
    expect((lines[0] as string).endsWith("y")).toBe(true);
  });

  it("strips CR from CRLF input", () => {
    const tail = createOutputTail();
    tail.push("alpha\r\nbeta\r\n");
    expect(tail.lines()).toEqual(["alpha", "beta"]);
    expect(tail.lines().some((line) => line.includes("\r"))).toBe(false);
  });

  it("joins a line split across two pushes and surfaces a partial trailing line", () => {
    const tail = createOutputTail();
    tail.push("You've hit your ses");
    // The partial line is already readable — a seat that dies mid-line still yields its last words.
    expect(tail.lines()).toEqual(["You've hit your ses"]);
    tail.push("sion limit\n");
    expect(tail.lines()).toEqual(["You've hit your session limit"]);
  });

  it("keeps a UTF-8 sequence intact when it is split across two pushes", () => {
    const tail = createOutputTail();
    const encoded = Buffer.from("resets 12:10am · done\n", "utf8");
    const split = encoded.indexOf(0xC2) + 1;
    tail.push(encoded.subarray(0, split));
    tail.push(encoded.subarray(split));
    expect(tail.lines()).toEqual(["resets 12:10am · done"]);
    expect(tail.lines()[0]).not.toContain("�");
  });

  it("accepts strings and Buffers alike", () => {
    const tail = createOutputTail();
    tail.push("one\n");
    tail.push(Buffer.from("two\n", "utf8"));
    expect(tail.lines()).toEqual(["one", "two"]);
  });

  it("honours explicit bounds — the line cap first, then the byte cap", () => {
    // maxLines alone would keep bbbb/cccc/dddd (12 bytes); maxBytes 11 then drops one more.
    const tail = createOutputTail({ maxBytes: 11, maxLines: 3 });
    tail.push("aaaa\nbbbb\ncccc\ndddd\n");
    expect(tail.lines()).toEqual(["cccc", "dddd"]);
    expect(tail.bytes()).toBe(8);
    const lineCapped = createOutputTail({ maxBytes: 1024, maxLines: 3 });
    lineCapped.push("aaaa\nbbbb\ncccc\ndddd\n");
    expect(lineCapped.lines()).toEqual(["bbbb", "cccc", "dddd"]);
  });

  it("returns a frozen copy that later pushes cannot mutate", () => {
    const tail = createOutputTail();
    tail.push("first\n");
    const snapshot = tail.lines();
    expect(Object.isFrozen(snapshot)).toBe(true);
    tail.push("second\n");
    expect(snapshot).toEqual(["first"]);
  });

  it("never exceeds either bound across random chunk sizes", () => {
    const random = prng(0x5EA7);
    const tail = createOutputTail();
    let pushes = 0;
    for (let round = 0; round < 400; round += 1) {
      const size = 1 + Math.floor(random() * 900);
      const body = Array.from({ length: size }, () => (random() < 0.08 ? "\n" : "z")).join("");
      tail.push(body);
      pushes += 1;
      expect(tail.bytes()).toBeLessThanOrEqual(MAX_BYTES);
      expect(byteLength(tail.lines())).toBeLessThanOrEqual(MAX_BYTES);
      expect(tail.lines().length).toBeLessThanOrEqual(40);
    }
    // The sweep must actually have run: a zero-round loop would pass every assertion above.
    expect(pushes).toBe(400);
    expect(tail.lines().length).toBeGreaterThan(0);
  });
});

/**
 * THE STREAM-JSON REPORT. A claude seat runs `--output-format stream-json`, so every event is a
 * stdout line, and the decoder hands on exactly what a text-mode seat printed: each result event's
 * text plus a newline, and any non-event line verbatim. The fixture lines are the shapes measured
 * on claude 2.1.277 (task-815f803d comment-7c263f1c), built with JSON.stringify.
 */
const TEXT = "Done · 3 files changed";
const BANNER = SEAT_EXIT_ROSTER.find((entry) => entry.id === "claude/rate-limit-429")?.sample ?? "";
const NOTHING = Buffer.alloc(0);
const bytesOf = (text: string): Buffer => Buffer.from(text, "utf8");
const event = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;
const INIT = event({ type: "system", subtype: "init", model: "claude-opus-5", session_id: "s-1", tools: ["Edit"] });
const STATUS = event({ type: "system", subtype: "status", status: "requesting", session_id: "s-1" });
const delta = (text: string): string => event({ type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text }, index: 0 }, session_id: "s-1" });
const assistant = (text: string, extra: Record<string, unknown> = {}): string => event({ type: "assistant",
  message: { content: [{ type: "text", text }], model: "claude-opus-5", role: "assistant" }, session_id: "s-1", ...extra });
/** The measured key order: a result event does NOT start with "type". */
const result = (text: string, extra: Record<string, unknown> = {}): string => event({
  duration_api_ms: 67, is_error: false, result: text, subtype: "success", type: "result", ...extra });
const OK_STREAM = INIT + STATUS + delta("Done ") + delta("· 3 files changed") + assistant(TEXT) + result(TEXT);
const LIMIT_STREAM = INIT + STATUS + assistant(BANNER, { error: "rate_limit", is_api_error_message: true })
  + result(BANNER, { api_error_status: 429, is_error: true, terminal_reason: "api_error" });

/** Feeds `stream` through one report in `size`-byte chunks, then flushes; every output concatenated. */
function decode(stream: string, size = Number.POSITIVE_INFINITY): { readonly bytes: Buffer; readonly pushes: number } {
  const input = bytesOf(stream);
  const report = createStreamJsonReport();
  const out: Buffer[] = [];
  let pushes = 0;
  for (let at = 0; at < input.length; at += size) {
    out.push(report.push(input.subarray(at, at + size)));
    pushes += 1;
  }
  out.push(report.flush());
  return { bytes: Buffer.concat(out), pushes };
}

/** A result line of exactly `bytes` bytes, newline excluded. */
function resultLineOf(bytes: number): string {
  const bare = JSON.stringify({ duration_api_ms: 1, pad: "", result: TEXT, type: "result" });
  return JSON.stringify({ duration_api_ms: 1, pad: "x".repeat(bytes - bytesOf(bare).length), result: TEXT, type: "result" });
}

function collectingSink(): { readonly bytes: () => Buffer; readonly write: (chunk: Buffer) => boolean } {
  const chunks: Buffer[] = [];
  return { bytes: () => Buffer.concat(chunks), write: (chunk) => { chunks.push(chunk); return true; } };
}

describe("createStreamJsonReport", () => {
  it("decodes an OK stream to exactly what text mode printed, however the pipe chunks it", () => {
    // The measured shape, pinned: a prefix match on `{"type":"result"` would never fire.
    expect(result(TEXT).startsWith("{\"duration_api_ms\":")).toBe(true);
    const length = bytesOf(OK_STREAM).length;
    for (const size of [length, 1, 7]) {
      const decoded = decode(OK_STREAM, size);
      expect(decoded.pushes).toBe(Math.ceil(length / size));
      expect(decoded.bytes).toEqual(bytesOf(`${TEXT}\n`));
    }
  });

  it("decodes the measured 429 stream to the roster's live banner line", () => {
    expect(BANNER.startsWith("API Error: Request rejected (429) · ")).toBe(true);
    expect(decode(LIMIT_STREAM).bytes).toEqual(bytesOf(`${BANNER}\n`));
    expect(decode(LIMIT_STREAM, 7).bytes).toEqual(bytesOf(`${BANNER}\n`));
  });

  it("passes a non-event line through eagerly and byte-exact, before its newline arrives", () => {
    const report = createStreamJsonReport();
    expect(report.push(bytesOf("working on it"))).toEqual(bytesOf("working on it"));
    expect(report.push(bytesOf(" {still}\n"))).toEqual(bytesOf(" {still}\n"));
    // A multi-byte character split across two chunks goes out exactly as it came.
    expect(report.push(Buffer.from([0xE2, 0x82]))).toEqual(Buffer.from([0xE2, 0x82]));
    expect(report.push(Buffer.from([0xAC, 0x0A]))).toEqual(Buffer.from([0xAC, 0x0A]));
    expect(report.flush()).toEqual(NOTHING);
  });

  it("keeps plain lines and decoded reports in their order within one chunk", () => {
    expect(decode(`alpha\n${result(TEXT)}\nomega`).bytes).toEqual(bytesOf(`alpha\n${TEXT}\n\nomega`));
  });

  it("forwards a '{' line that is not JSON raw at its newline, and settles a pending line at flush", () => {
    const report = createStreamJsonReport();
    expect(report.push(bytesOf("{not json"))).toEqual(NOTHING);
    expect(report.push(bytesOf("\n"))).toEqual(bytesOf("{not json\n"));
    // At flush no newline is added that text mode would not have printed.
    expect(decode("{partial").bytes).toEqual(bytesOf("{partial"));
    expect(decode(result(TEXT).trimEnd()).bytes).toEqual(bytesOf(`${TEXT}\n`));
    expect(decode(STATUS.trimEnd()).bytes).toEqual(NOTHING);
  });

  it("yields nothing for an event the stream closed on mid-write, whatever text it carries", () => {
    // A seat killed while writing: the cut line opens like an event and no longer parses.
    const cut = assistant("You've hit your usage limit · resets 3am").slice(0, 120);
    expect(cut.startsWith("{\"type\":\"assistant\"")).toBe(true);
    expect(cut).toContain("usage limit");
    expect(decode(cut).bytes).toEqual(NOTHING);
    // A cut result is no report either: the seat never finished saying it.
    expect(decode(result(TEXT).slice(0, 30)).bytes).toEqual(NOTHING);
  });

  it("forwards nothing for an event that is not a result, whatever text it carries", () => {
    const lines = [
      assistant("You've hit your usage limit · resets 3am"),
      delta("You've hit your usage limit · resets 3am"),
      event({ type: "system", subtype: "api_retry", attempt: 1, error: "connection_error", max_retries: 10 }),
      event({ duration_api_ms: 1, is_error: true, subtype: "error_during_execution", type: "result" }),
      INIT,
      STATUS,
    ];
    for (const line of lines) expect(decode(line).bytes).toEqual(NOTHING);
    expect(lines.length).toBe(6);
  });

  it("drops a line longer than STREAM_JSON_MAX_LINE_BYTES and still decodes the next one", () => {
    expect(STREAM_JSON_MAX_LINE_BYTES).toBe(1_048_576);
    const exact = resultLineOf(STREAM_JSON_MAX_LINE_BYTES);
    expect(bytesOf(exact).length).toBe(STREAM_JSON_MAX_LINE_BYTES);
    expect(decode(`${exact}\n`, 65_536).bytes).toEqual(bytesOf(`${TEXT}\n`));
    const over = resultLineOf(STREAM_JSON_MAX_LINE_BYTES + 1);
    const decoded = decode(`${over}\n${result("next")}`, 65_536);
    expect(decoded.pushes).toBe(17);
    expect(decoded.bytes).toEqual(bytesOf("next\n"));
    expect(decode(over, 65_536).bytes).toEqual(NOTHING);
  });
});

describe("createSeatOutput", () => {
  it("streams a claude seat: every raw byte is activity, only decoded report text is output", () => {
    const counted: number[] = [];
    const stdout = collectingSink();
    const stderr = collectingSink();
    const output = createSeatOutput({ onBytes: (bytes) => { counted.push(bytes); }, sinks: { stderr, stdout }, streamJson: true });
    output.stdout(bytesOf(INIT + STATUS));
    output.stdout(bytesOf(delta("Done ")));
    // Events alone: the seat is speaking, but has printed nothing a text-mode seat would have.
    expect(counted).toEqual([bytesOf(INIT + STATUS).length, bytesOf(delta("Done ")).length]);
    expect(output.seen()).toBe(false);
    expect(stdout.bytes()).toEqual(NOTHING);
    expect(output.tail()).toEqual([]);

    output.stdout(bytesOf(result(TEXT)));
    expect(output.seen()).toBe(true);
    expect(stdout.bytes()).toEqual(bytesOf(`${TEXT}\n`));
    expect(output.tail()).toEqual([TEXT]);

    output.stderr(bytesOf("{\"warn\": 1}\n"));
    expect(stderr.bytes()).toEqual(bytesOf("{\"warn\": 1}\n"));
    expect(output.tail()).toEqual([TEXT, "{\"warn\": 1}"]);
    expect(counted.length).toBe(4);
  });

  it("counts any stderr byte of a streaming seat as seen, and flushes a pending report at close", () => {
    const quiet = createSeatOutput({ onBytes: () => undefined,
      sinks: { stderr: collectingSink(), stdout: collectingSink() }, streamJson: true });
    expect(quiet.seen()).toBe(false);
    quiet.stderr(bytesOf("x"));
    expect(quiet.seen()).toBe(true);

    const stdout = collectingSink();
    const pending = createSeatOutput({ onBytes: () => undefined, sinks: { stderr: collectingSink(), stdout }, streamJson: true });
    pending.stdout(bytesOf(result(TEXT).trimEnd()));
    expect(pending.seen()).toBe(false);
    pending.close();
    expect(pending.seen()).toBe(true);
    expect(stdout.bytes()).toEqual(bytesOf(`${TEXT}\n`));
    expect(pending.tail()).toEqual([TEXT]);
  });

  it("passes a non-streaming (codex) seat's bytes through raw, and any byte is seen", () => {
    const counted: number[] = [];
    const stdout = collectingSink();
    const stderr = collectingSink();
    const output = createSeatOutput({ onBytes: (bytes) => { counted.push(bytes); }, sinks: { stderr, stdout }, streamJson: false });
    output.stdout(bytesOf(STATUS));
    expect(output.seen()).toBe(true);
    expect(stdout.bytes()).toEqual(bytesOf(STATUS));
    output.stderr(Buffer.from([0xE2, 0x82]));
    output.stderr(Buffer.from([0xAC, 0x0A]));
    output.close();
    expect(stderr.bytes()).toEqual(Buffer.from([0xE2, 0x82, 0xAC, 0x0A]));
    expect(stdout.bytes()).toEqual(bytesOf(STATUS));
    expect(output.tail()).toEqual([STATUS.trimEnd(), "€"]);
    expect(counted).toEqual([bytesOf(STATUS).length, 2, 2]);
  });
});
