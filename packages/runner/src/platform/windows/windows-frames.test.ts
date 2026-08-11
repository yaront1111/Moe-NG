import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CHANNEL_PAYLOAD_CAPS,
  FRAME_HEADER_BYTES,
  TRUNCATED_HEADER_MESSAGE,
  TRUNCATED_PAYLOAD_MESSAGE,
  WINDOWS_PROTOCOL_VERSION,
  createFrameReader,
  encodeFrame,
  type FrameRead,
  type WindowsChannel,
} from "./windows-frames.js";
import { type WindowsProcessUnknown } from "./windows-process-contract.js";

const BROKER_SRC = join(dirname(fileURLToPath(import.meta.url)), "native", "broker", "src");
const rust = (file: string): string => readFileSync(join(BROKER_SRC, `${file}.rs`), "utf8");

/** `64 * 1024` and `6` are both legal spellings of a Rust constant here. */
const rustConstant = (source: string, name: string): number => {
  const match = new RegExp(`pub const ${name}: usize = ([^;]+);`, "u").exec(source);
  const declaration = match?.[1];
  if (declaration === undefined) {
    throw new Error(`${name} is no longer declared where this test reads it`);
  }
  const factors = declaration.split("*").map((part) => Number.parseInt(part.trim(), 10));
  if (factors.some((factor) => !Number.isSafeInteger(factor))) {
    throw new Error(`${name} is declared as an expression this test cannot evaluate`);
  }
  return factors.reduce((product, factor) => product * factor, 1);
};

/**
 * THE ANTI-DRIFT PIN. The TypeScript codec necessarily re-implements the six
 * byte header; there is no way to share the Rust one. That makes silent drift
 * the whole risk, so every constant is read out of the Rust source and compared
 * — not copied from its doc comment, and not from this file's memory of it.
 */
describe("the wire format is pinned against the Rust definition", () => {
  it("agrees on the protocol version and the header width", () => {
    const version = /pub const PROTOCOL_VERSION: u8 = (\d+);/u.exec(rust("protocol"));
    expect(version?.[1]).toBeDefined();
    expect(WINDOWS_PROTOCOL_VERSION).toBe(Number(version?.[1]));
    expect(FRAME_HEADER_BYTES).toBe(rustConstant(rust("frames"), "FRAME_HEADER_BYTES"));
    // version + opcode + a u32 length. If the header ever grows, the sum breaks.
    expect(FRAME_HEADER_BYTES).toBe(1 + 1 + 4);
  });

  it("agrees on all three per-channel caps", () => {
    const frames = rust("frames");
    expect(CHANNEL_PAYLOAD_CAPS.CONTROL).toBe(rustConstant(frames, "MAX_CONTROL_PAYLOAD"));
    expect(CHANNEL_PAYLOAD_CAPS.STATUS).toBe(rustConstant(frames, "MAX_STATUS_PAYLOAD"));
    expect(CHANNEL_PAYLOAD_CAPS.DIAGNOSTIC).toBe(rustConstant(frames, "MAX_DIAGNOSTIC_PAYLOAD"));
    // Distinct caps are the point: one global number would let an oversized
    // diagnostics frame through at control's budget.
    expect(new Set(Object.values(CHANNEL_PAYLOAD_CAPS)).size).toBe(3);
  });

  /**
   * Endianness cannot be asserted by reading a doc comment, so this reads the
   * CALLS. A Rust side that switched to big-endian would redden here before any
   * byte-level fixture below had a chance to disagree in production.
   */
  it("agrees that the length field is little-endian", () => {
    const frames = rust("frames");
    expect(frames).toContain("u32::from_le_bytes");
    expect(frames).not.toContain("from_be_bytes");
    expect(frames).not.toContain("to_be_bytes");
  });
});

// ---------------------------------------------------------------------------
// Byte-exact fixtures. Every one is written out as literal bytes, so a wrong
// offset or a flipped endianness is a value mismatch and not a shape mismatch.
// ---------------------------------------------------------------------------

const bytes = (...values: readonly number[]): Uint8Array => Uint8Array.from(values);

const encoded = (channel: WindowsChannel, opcode: number, payload: Uint8Array): Uint8Array => {
  const frame = encodeFrame(channel, opcode, payload);
  if (!(frame instanceof Uint8Array)) {
    throw new Error(`encodeFrame refused a legal frame: ${frame.code}`);
  }
  return frame;
};

const refusalOf = (read: FrameRead): WindowsProcessUnknown => {
  if (read.kind !== "REFUSED") throw new Error(`expected a refusal, got ${read.kind}`);
  return read.failure;
};

describe("encodeFrame lays the header out byte for byte", () => {
  it("writes an empty CANCEL frame as exactly six bytes", () => {
    expect(encoded("CONTROL", 2, new Uint8Array(0))).toEqual(bytes(0x01, 0x02, 0x00, 0x00, 0x00, 0x00));
  });

  /**
   * 258 is 0x0000_0102. Little-endian it is `02 01 00 00`; big-endian it would
   * be `00 00 01 02`. Those share no byte in any position, so this fixture
   * cannot pass under `writeUInt32BE`.
   */
  it("writes the declared length little-endian at offset 2", () => {
    const frame = encoded("CONTROL", 1, new Uint8Array(258).fill(0xab));
    expect([...frame.subarray(0, FRAME_HEADER_BYTES)]).toEqual([0x01, 0x01, 0x02, 0x01, 0x00, 0x00]);
    expect(frame.length).toBe(FRAME_HEADER_BYTES + 258);
    expect(frame[FRAME_HEADER_BYTES]).toBe(0xab);
  });

  it("puts the version at offset 0 and the opcode at offset 1, never the reverse", () => {
    const frame = encoded("STATUS", 3, bytes(0x77));
    expect(frame[0]).toBe(WINDOWS_PROTOCOL_VERSION);
    expect(frame[1]).toBe(3);
    expect(frame[6]).toBe(0x77);
  });

  it("refuses its own over-cap payload rather than emitting a frame a peer must defend against", () => {
    const failure = encodeFrame("DIAGNOSTIC", 1, new Uint8Array(CHANNEL_PAYLOAD_CAPS.DIAGNOSTIC + 1));
    expect(failure).not.toBeInstanceOf(Uint8Array);
    if (failure instanceof Uint8Array) return;
    expect(failure.code).toBe("PROCESS_BOUNDARY_FRAME_OVERSIZED");
    expect(failure.layer).toBe("WINDOWS_PROCESS_TRANSPORT");
  });

  it("accepts a payload at exactly the cap, so the bound is inclusive on both sides", () => {
    const frame = encoded("DIAGNOSTIC", 1, new Uint8Array(CHANNEL_PAYLOAD_CAPS.DIAGNOSTIC));
    expect(frame.length).toBe(FRAME_HEADER_BYTES + CHANNEL_PAYLOAD_CAPS.DIAGNOSTIC);
  });
});

describe("the reader refuses hostile headers", () => {
  it("reads a byte-exact 258-byte little-endian declaration", () => {
    const reader = createFrameReader("CONTROL");
    reader.push(bytes(0x01, 0x09, 0x02, 0x01, 0x00, 0x00, ...new Uint8Array(258)));
    const read = reader.next();
    expect(read.kind).toBe("FRAME");
    if (read.kind !== "FRAME") return;
    expect(read.frame.opcode).toBe(0x09);
    expect(read.frame.payload.length).toBe(258);
  });

  it("refuses a wrong version byte with its own exact code", () => {
    const reader = createFrameReader("STATUS");
    reader.push(bytes(0x02, 0x01, 0x00, 0x00, 0x00, 0x00));
    const failure = refusalOf(reader.next());
    expect(failure.code).toBe("PROCESS_BOUNDARY_FRAME_VERSION_MISMATCH");
    expect(failure.layer).toBe("WINDOWS_PROCESS_TRANSPORT");
  });

  /**
   * THE ORDER IS THE CONTRACT, and it is the Rust order: header, then VERSION,
   * then the bound check. This frame is wrong on both counts; a reader that
   * bound-checked first would answer FRAME_OVERSIZED and a future re-layout of
   * the protocol would then read as garbage rather than as a version mismatch.
   */
  it("answers version mismatch before the bound check when a frame is wrong on both", () => {
    const reader = createFrameReader("STATUS");
    reader.push(bytes(0x09, 0x01, 0xff, 0xff, 0xff, 0xff));
    expect(refusalOf(reader.next()).code).toBe("PROCESS_BOUNDARY_FRAME_VERSION_MISMATCH");
  });

  /**
   * THE DECLARED LENGTH IS ATTACKER INPUT. 0xFFFF_FFFF is 4 GiB. The
   * discriminating assertion is REFUSED rather than PENDING: a reader that
   * waited for `6 + declared` bytes before bound-checking would answer PENDING
   * here forever, and a reader that sized a buffer from it would throw or
   * exhaust memory. Only six bytes are ever buffered.
   */
  it("refuses a declared length near u32::MAX from the header alone", () => {
    const reader = createFrameReader("CONTROL");
    reader.push(bytes(0x01, 0x01, 0xff, 0xff, 0xff, 0xff));
    const read = reader.next();
    expect(read.kind).toBe("REFUSED");
    expect(refusalOf(read).code).toBe("PROCESS_BOUNDARY_FRAME_OVERSIZED");
    expect(reader.buffered()).toBe(FRAME_HEADER_BYTES);
  });

  it("refuses one byte over the channel's own cap, not one byte over some global cap", () => {
    const over = CHANNEL_PAYLOAD_CAPS.DIAGNOSTIC + 1;
    const reader = createFrameReader("DIAGNOSTIC");
    reader.push(bytes(0x01, 0x01, over & 0xff, (over >>> 8) & 0xff, 0x00, 0x00));
    expect(refusalOf(reader.next()).code).toBe("PROCESS_BOUNDARY_FRAME_OVERSIZED");
    // The identical bytes are legal on CONTROL, whose cap is far larger.
    const control = createFrameReader("CONTROL");
    control.push(bytes(0x01, 0x01, over & 0xff, (over >>> 8) & 0xff, 0x00, 0x00));
    expect(control.next().kind).toBe("PENDING");
  });

  it("waits for the whole header before judging the version", () => {
    const reader = createFrameReader("STATUS");
    reader.push(bytes(0x02));
    expect(reader.next().kind).toBe("PENDING");
  });
});

describe("truncation is only knowable when the channel ends", () => {
  it("distinguishes a truncated header from a truncated payload", () => {
    const header = createFrameReader("STATUS");
    header.push(bytes(0x01, 0x01, 0x04));
    expect(header.next().kind).toBe("PENDING");
    const headerFailure = header.finish();
    expect(headerFailure?.code).toBe("PROCESS_BOUNDARY_FRAME_TRUNCATED");
    expect(headerFailure?.message).toBe(TRUNCATED_HEADER_MESSAGE);

    const payload = createFrameReader("STATUS");
    payload.push(bytes(0x01, 0x01, 0x04, 0x00, 0x00, 0x00, 0xaa, 0xbb));
    expect(payload.next().kind).toBe("PENDING");
    const payloadFailure = payload.finish();
    expect(payloadFailure?.code).toBe("PROCESS_BOUNDARY_FRAME_TRUNCATED");
    expect(payloadFailure?.message).toBe(TRUNCATED_PAYLOAD_MESSAGE);
    expect(TRUNCATED_HEADER_MESSAGE).not.toBe(TRUNCATED_PAYLOAD_MESSAGE);
  });

  it("is silent when the channel ends exactly on a frame boundary", () => {
    const reader = createFrameReader("STATUS");
    reader.push(encoded("STATUS", 2, bytes(0x01, 0x00, 0x00, 0x00, 0x00)));
    expect(reader.next().kind).toBe("FRAME");
    expect(reader.next().kind).toBe("PENDING");
    expect(reader.finish()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Chunk boundaries. A pipe delivers partial frames and several frames at once;
// a reader that assumes one chunk is one frame passes every naive test.
// ---------------------------------------------------------------------------

const drain = (channel: WindowsChannel, chunks: readonly Uint8Array[]): readonly FrameRead[] => {
  const reader = createFrameReader(channel);
  const reads: FrameRead[] = [];
  for (const chunk of chunks) {
    reader.push(chunk);
    for (;;) {
      const read = reader.next();
      if (read.kind === "PENDING") break;
      reads.push(read);
      if (read.kind === "REFUSED") return reads;
    }
  }
  return reads;
};

const readable = (reads: readonly FrameRead[]): readonly { opcode: number; payload: number[] }[] =>
  reads.map((read) => {
    if (read.kind !== "FRAME") throw new Error(`expected a frame, got ${read.kind}`);
    return { opcode: read.frame.opcode, payload: [...read.frame.payload] };
  });

const oneAtATime = (stream: Uint8Array): readonly Uint8Array[] =>
  [...stream].map((byte) => Uint8Array.of(byte));

describe("chunk boundaries do not change what is read", () => {
  const stream = (): Uint8Array => {
    const first = encoded("STATUS", 1, bytes(0x01, 0x02, 0x03, 0x04, 0x08, 0x07, 0x06, 0x05));
    const second = encoded("STATUS", 2, bytes(0x01, 0x00, 0x00, 0x00, 0x00));
    const third = encoded("STATUS", 3, new Uint8Array(0));
    const joined = new Uint8Array(first.length + second.length + third.length);
    joined.set(first, 0);
    joined.set(second, first.length);
    joined.set(third, first.length + second.length);
    return joined;
  };

  const EXPECTED = [
    { opcode: 1, payload: [0x01, 0x02, 0x03, 0x04, 0x08, 0x07, 0x06, 0x05] },
    { opcode: 2, payload: [0x01, 0x00, 0x00, 0x00, 0x00] },
    { opcode: 3, payload: [] },
  ];

  it("reads three frames out of ONE coalesced chunk", () => {
    const reads = drain("STATUS", [stream()]);
    // A sweep that produced no frames would pass a length-free assertion.
    expect(reads.length).toBe(3);
    expect(readable(reads)).toEqual(EXPECTED);
  });

  it("reads the same three frames from one-byte chunks", () => {
    const fragments = oneAtATime(stream());
    expect(fragments.length).toBe(stream().length);
    expect(fragments.length).toBeGreaterThan(3);
    expect(readable(drain("STATUS", fragments))).toEqual(EXPECTED);
  });

  it("reads the same three frames when a chunk straddles every header", () => {
    const whole = stream();
    // 3, then 5, then 7 ... deliberately coprime with the 6-byte header so a
    // split lands inside a header, inside a length field and inside a payload.
    const chunks: Uint8Array[] = [];
    for (let at = 0, size = 3; at < whole.length; size += 2) {
      chunks.push(whole.subarray(at, Math.min(at + size, whole.length)));
      at += size;
    }
    expect(chunks.length).toBeGreaterThan(1);
    expect(readable(drain("STATUS", chunks))).toEqual(EXPECTED);
  });

  it("refuses a hostile frame at the same point no matter how it is fragmented", () => {
    const hostile = bytes(0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x02, 0x09, 0xff, 0xff, 0xff, 0xff);
    const coalesced = drain("STATUS", [hostile]);
    const fragmented = drain("STATUS", oneAtATime(hostile));
    expect(coalesced.length).toBe(2);
    expect(coalesced[0]?.kind).toBe("FRAME");
    expect(refusalOf(coalesced[1] as FrameRead).code).toBe(
      "PROCESS_BOUNDARY_FRAME_VERSION_MISMATCH",
    );
    expect(fragmented.map((read) => read.kind)).toEqual(coalesced.map((read) => read.kind));
    expect(refusalOf(fragmented[1] as FrameRead).code).toBe(
      refusalOf(coalesced[1] as FrameRead).code,
    );
  });

  it("keeps a payload's bytes out of the next frame's header", () => {
    // The payload IS a well-formed frame. A reader that rescanned its own
    // buffer instead of consuming exactly the declared length would surface it.
    const inner = encoded("STATUS", 3, new Uint8Array(0));
    const outer = encoded("STATUS", 1, inner);
    const reads = drain("STATUS", [outer]);
    expect(reads.length).toBe(1);
    expect(readable(reads)).toEqual([{ opcode: 1, payload: [...inner] }]);
  });
});
