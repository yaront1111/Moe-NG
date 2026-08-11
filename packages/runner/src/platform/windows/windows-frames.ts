import {
  unknownOutcome,
  type WindowsProcessUnknown,
} from "./windows-process-contract.js";

/**
 * The TypeScript half of the broker's bounded binary framing.
 *
 * BYTES ONLY, exactly as its Rust counterpart is (native/broker/src/frames.rs).
 * This module knows the version, the declared length and a payload's extent. It
 * does NOT know what an opcode means — that keeps one codec serving all three
 * channels without embedding three vocabularies, and it puts every vocabulary
 * decision one layer up where a test can pin it separately.
 *
 * THIS IS A DUPLICATED FORMAT, NOT DUPLICATED AUTHORITY. There is no way to
 * share the Rust codec with Node, so the six-byte header is necessarily written
 * twice. That makes silent drift the whole risk, which is why
 * `windows-frames.test.ts` reads the Rust constants out of the Rust source and
 * compares them rather than trusting a doc comment or this file's memory.
 *
 * ```text
 * offset 0   1 byte   version, must equal WINDOWS_PROTOCOL_VERSION
 * offset 1   1 byte   opcode, carried uninterpreted
 * offset 2   4 bytes  declared payload length, little-endian u32
 * offset 6   N bytes  payload, exactly the declared length
 * ```
 */

/** Pinned by test against `PROTOCOL_VERSION` in native/broker/src/protocol.rs. */
export const WINDOWS_PROTOCOL_VERSION = 1;

/** Version, opcode, and the little-endian u32 length. */
export const FRAME_HEADER_BYTES = 6;

/** fd0 control, fd1 status, fd2 non-authoritative diagnostics. */
export const WINDOWS_CHANNELS = Object.freeze(["CONTROL", "STATUS", "DIAGNOSTIC"] as const);
export type WindowsChannel = (typeof WINDOWS_CHANNELS)[number];

/**
 * The cap is a property of the CHANNEL rather than one global number, so an
 * oversized diagnostics frame is refused at 513 bytes even though the same
 * bytes would be legal control. Pinned by test against frames.rs.
 */
export const CHANNEL_PAYLOAD_CAPS = Object.freeze({
  CONTROL: 64 * 1024,
  STATUS: 4 * 1024,
  DIAGNOSTIC: 512,
} as const satisfies Readonly<Record<WindowsChannel, number>>);

/**
 * Exported so the tests pin a symbol rather than a retyped string. The two are
 * separate constants because folding them into one message would make "the
 * channel died mid-header" and "the peer promised bytes it never sent"
 * indistinguishable, and only the second implicates the peer.
 */
export const TRUNCATED_HEADER_MESSAGE = "the channel ended inside a frame header";
export const TRUNCATED_PAYLOAD_MESSAGE = "the channel ended inside a frame payload";

/** One frame, bounded, with its opcode still uninterpreted. */
export interface WindowsFrame {
  readonly opcode: number;
  readonly payload: Uint8Array;
}

export type FrameRead =
  | { readonly kind: "FRAME"; readonly frame: WindowsFrame }
  /** Not enough bytes have arrived yet. Not an error, and not truncation. */
  | { readonly kind: "PENDING" }
  | { readonly kind: "REFUSED"; readonly failure: WindowsProcessUnknown };

const PENDING: FrameRead = Object.freeze({ kind: "PENDING" as const });

function transportRefusal(
  code: Parameters<typeof unknownOutcome>[0],
  message: string,
): WindowsProcessUnknown {
  return unknownOutcome(code, "WINDOWS_PROCESS_TRANSPORT", message);
}

/**
 * Writes one frame, or refuses without producing a byte.
 *
 * The cap is enforced on this side too. An over-cap payload is OUR bug rather
 * than a peer's, and refusing it here means the broker never has to defend
 * against a frame we should not have sent.
 */
export function encodeFrame(
  channel: WindowsChannel,
  opcode: number,
  payload: Uint8Array,
): Uint8Array | WindowsProcessUnknown {
  if (!Number.isSafeInteger(opcode) || opcode < 0 || opcode > 0xff) {
    return transportRefusal(
      "PROCESS_BOUNDARY_FRAME_OPCODE_UNKNOWN",
      "an opcode must be a single byte",
    );
  }
  if (payload.length > CHANNEL_PAYLOAD_CAPS[channel]) {
    return transportRefusal(
      "PROCESS_BOUNDARY_FRAME_OVERSIZED",
      "the payload is larger than this channel's cap",
    );
  }
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  frame[0] = WINDOWS_PROTOCOL_VERSION;
  frame[1] = opcode;
  // Little-endian, byte by byte. A DataView call would read identically here
  // and hide the layout the Rust side pins; these four lines are the layout.
  frame[2] = payload.length & 0xff;
  frame[3] = (payload.length >>> 8) & 0xff;
  frame[4] = (payload.length >>> 16) & 0xff;
  frame[5] = (payload.length >>> 24) & 0xff;
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
}

/**
 * A chunk-accumulating reader over one channel.
 *
 * A PIPE DOES NOT DELIVER FRAMES, IT DELIVERS BYTES. One chunk may hold three
 * frames, or a third of one, and the split can land inside a length field. So
 * every chunk is appended to a buffer and frames are drained out of it; nothing
 * here assumes a chunk boundary means anything at all.
 */
export interface WindowsFrameReader {
  /** Appends bytes as they arrive. Never parses. */
  push(chunk: Uint8Array): void;
  /** The next frame, or PENDING, or a refusal. Consumes only what it returns. */
  next(): FrameRead;
  /**
   * Declares the channel ended. Non-null when bytes were left mid-frame, which
   * is the only point at which truncation is knowable — before the end, short
   * is indistinguishable from slow.
   */
  finish(): WindowsProcessUnknown | null;
  /** How many unconsumed bytes are held. Lets a test prove what was NOT read. */
  buffered(): number;
}

export function createFrameReader(channel: WindowsChannel): WindowsFrameReader {
  const cap = CHANNEL_PAYLOAD_CAPS[channel];
  let held: Uint8Array = new Uint8Array(0);
  let refused = false;

  const append = (chunk: Uint8Array): void => {
    if (chunk.length === 0) {
      return;
    }
    const grown = new Uint8Array(held.length + chunk.length);
    grown.set(held, 0);
    grown.set(chunk, held.length);
    held = grown;
  };

  const refuse = (
    code: Parameters<typeof unknownOutcome>[0],
    message: string,
  ): FrameRead => {
    refused = true;
    return Object.freeze({ kind: "REFUSED" as const, failure: transportRefusal(code, message) });
  };

  return {
    push(chunk: Uint8Array): void {
      append(chunk);
    },

    next(): FrameRead {
      // A refused channel stays refused. Resuming after a hostile frame would
      // let a peer resynchronise on bytes of its own choosing.
      if (refused || held.length < FRAME_HEADER_BYTES) {
        return PENDING;
      }
      // VERSION FIRST, exactly as read_frame does. A wrong-version frame is
      // refused before its length or its opcode is looked at, so a future
      // re-layout of this protocol reports a mismatch rather than garbage.
      if (held[0] !== WINDOWS_PROTOCOL_VERSION) {
        return refuse(
          "PROCESS_BOUNDARY_FRAME_VERSION_MISMATCH",
          "the frame's version byte is not the frozen protocol version",
        );
      }
      const declared = readDeclaredLength(held);
      // THE DECLARED LENGTH IS ATTACKER INPUT, so it is compared against a
      // compile-time constant BEFORE it is used to size, slice or wait for
      // anything. Checking availability first would make a 4 GiB declaration
      // an unbounded wait instead of a refusal.
      if (declared > cap) {
        return refuse(
          "PROCESS_BOUNDARY_FRAME_OVERSIZED",
          "the declared payload length is larger than this channel's cap",
        );
      }
      const total = FRAME_HEADER_BYTES + declared;
      if (held.length < total) {
        return PENDING;
      }
      // `slice` rather than `subarray`: a view would keep the whole accumulated
      // buffer alive and would alias bytes this reader is about to drop.
      const payload = held.slice(FRAME_HEADER_BYTES, total);
      const opcode = held[1] ?? 0;
      held = held.slice(total);
      return Object.freeze({ kind: "FRAME" as const, frame: Object.freeze({ opcode, payload }) });
    },

    finish(): WindowsProcessUnknown | null {
      if (refused || held.length === 0) {
        return null;
      }
      const message =
        held.length < FRAME_HEADER_BYTES ? TRUNCATED_HEADER_MESSAGE : TRUNCATED_PAYLOAD_MESSAGE;
      return transportRefusal("PROCESS_BOUNDARY_FRAME_TRUNCATED", message);
    },

    buffered(): number {
      return held.length;
    },
  };
}

/**
 * The declared length, little-endian, from offset 2.
 *
 * `>>> 0` rather than `<< 24`: the top byte shifted left by 24 is NEGATIVE
 * under JavaScript's signed 32-bit bitwise operators, so a length near
 * `u32::MAX` would compare as less than the cap and defeat the bound check
 * immediately above its only caller. Multiplying by 2**24 keeps it unsigned.
 */
function readDeclaredLength(head: Uint8Array): number {
  return (
    (head[2] ?? 0) + (head[3] ?? 0) * 0x100 + (head[4] ?? 0) * 0x10000 + (head[5] ?? 0) * 0x1000000
  );
}
