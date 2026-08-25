import {
  brokerLayerFromWire,
  type BrokerRefusal,
} from "./windows-process-broker-contract.js";
import {
  unknownOutcome,
  processIdentity,
  type WindowsProcessIdentity,
  type WindowsProcessUnknown,
} from "./windows-process-contract.js";
import { type WindowsFrame } from "./windows-frames.js";

/**
 * The broker's outbound status vocabulary on fd1, decoded.
 *
 * MIRRORS native/broker/src/status.rs AND refusal.rs, byte for byte:
 *
 * ```text
 * opcode 1  STARTED   pid u32 LE, creation time u64 LE            12 bytes
 * opcode 2  COMPLETED kind u8 (1 exited, 2 unknown), value u32 LE  5 bytes
 * opcode 3  REFUSED   layer u8, reason u16 LE, code u32 LE         7 bytes
 * ```
 *
 * EVERY PAYLOAD IS FIXED WIDTH, so a length that is not exactly right is a
 * refusal rather than something to read as far as it goes. Reading a short
 * payload "as far as it goes" is how a truncated identity becomes a plausible
 * one.
 */

const STARTED_PAYLOAD_BYTES = 12;
const COMPLETED_PAYLOAD_BYTES = 5;
const REFUSED_PAYLOAD_BYTES = 7;

/** `Completed::Exited(code)` and `Completed::Unknown(reason)` from status.rs. */
export type BrokerExit =
  | { readonly kind: "EXITED"; readonly code: number }
  | { readonly kind: "UNOBSERVED"; readonly reason: number };

export type BrokerStatus =
  | { readonly kind: "STARTED"; readonly identity: WindowsProcessIdentity }
  | { readonly kind: "COMPLETED"; readonly exit: BrokerExit }
  | { readonly kind: "REFUSED"; readonly refusal: BrokerRefusal };

function malformed(message: string): WindowsProcessUnknown {
  return unknownOutcome(
    "PROCESS_BOUNDARY_FRAME_PAYLOAD_MALFORMED",
    "WINDOWS_PROCESS_TRANSPORT",
    message,
  );
}

function readU32(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at] ?? 0) +
    (bytes[at + 1] ?? 0) * 0x100 +
    (bytes[at + 2] ?? 0) * 0x10000 +
    (bytes[at + 3] ?? 0) * 0x1000000
  );
}

/** A FILETIME needs all 64 bits, so it is accumulated as a bigint throughout. */
function readU64(bytes: Uint8Array, at: number): bigint {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[at + index] ?? 0);
  }
  return value;
}

/**
 * One status frame, or a typed refusal.
 *
 * The opcode is judged against a CLOSED vocabulary — 1, 2 or 3 and nothing
 * else — so a byte outside it is refused rather than treated as a status this
 * side has not heard of yet.
 */
export function decodeStatus(frame: WindowsFrame): BrokerStatus | WindowsProcessUnknown {
  const { opcode, payload } = frame;
  if (opcode === 1) {
    if (payload.length !== STARTED_PAYLOAD_BYTES) {
      return malformed("a started frame is exactly a u32 pid and a u64 creation time");
    }
    return {
      kind: "STARTED",
      identity: processIdentity(readU32(payload, 0), readU64(payload, 4)),
    };
  }
  if (opcode === 2) {
    return decodeCompleted(payload);
  }
  if (opcode === 3) {
    return decodeRefused(payload);
  }
  return unknownOutcome(
    "PROCESS_BOUNDARY_FRAME_OPCODE_UNKNOWN",
    "WINDOWS_PROCESS_TRANSPORT",
    "the status opcode is not a member of the broker's closed outbound vocabulary",
  );
}

function decodeCompleted(payload: Uint8Array): BrokerStatus | WindowsProcessUnknown {
  if (payload.length !== COMPLETED_PAYLOAD_BYTES) {
    return malformed("a completed frame is exactly a discriminant byte and a u32");
  }
  const value = readU32(payload, 1);
  // 1 and 2 are the ONLY discriminants status.rs emits. A third would mean the
  // broker grew a case this side does not understand, and guessing which of the
  // two it resembles is exactly how an unobserved exit becomes a proven one.
  if (payload[0] === 1) {
    return { kind: "COMPLETED", exit: { kind: "EXITED", code: value } };
  }
  if (payload[0] === 2) {
    return { kind: "COMPLETED", exit: { kind: "UNOBSERVED", reason: value } };
  }
  return malformed("a completed frame's discriminant is neither exited nor unknown");
}

function decodeRefused(payload: Uint8Array): BrokerStatus | WindowsProcessUnknown {
  if (payload.length !== REFUSED_PAYLOAD_BYTES) {
    return malformed("a refused frame is exactly a layer byte, a u16 reason and a u32 code");
  }
  const layer = brokerLayerFromWire(payload[0] ?? 0);
  if (layer === null) {
    // Without a layer the ordinal is meaningless: descriptor reason 0 and
    // protocol reason 0 are different refusals.
    return malformed("the refusal layer byte is not one of the broker's four layers");
  }
  const refusal: BrokerRefusal = {
    layer,
    reason: (payload[1] ?? 0) + (payload[2] ?? 0) * 0x100,
    code: readU32(payload, 3),
  };
  return { kind: "REFUSED", refusal };
}
