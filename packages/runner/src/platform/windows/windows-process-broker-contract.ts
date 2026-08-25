import { type WindowsProcessLayer } from "./windows-process-contract.js";

/**
 * The broker's four refusing layers and their FROZEN 1-BASED wire bytes
 * (`refusal.rs`, `RefusalLayer::wire`). Zero is deliberately not a layer.
 */
export const BROKER_LAYER_BY_WIRE = Object.freeze({
  1: "BROKER_DESCRIPTOR",
  2: "BROKER_PROTOCOL",
  3: "BROKER_NATIVE",
  4: "BROKER_STORE_LOCK",
} as const satisfies Readonly<Record<number, WindowsProcessLayer>>);

/** The layer a refusal wire byte names, or null. Null is the closed-set answer. */
export function brokerLayerFromWire(byte: number): WindowsProcessLayer | null {
  if (byte === 1 || byte === 2 || byte === 3 || byte === 4) {
    return BROKER_LAYER_BY_WIRE[byte];
  }
  return null;
}

/**
 * The broker's FROZEN process exit codes (`main.rs`), named as it names them.
 *
 * fd1 is the authority and these are read ONLY when fd1 carried no terminal
 * frame at all. Two exits are informative without a frame: a descriptor
 * refusal exits `REFUSAL_BASE + DescriptorReason ordinal` before fd1 is usable,
 * and a run whose end was not observed exits `EXIT_UNOBSERVED`. The descriptor
 * band ends BELOW `EXIT_LAUNCH_REFUSED`, so no ordinal can read as a launch code.
 */
export const BROKER_EXIT_CODES = Object.freeze({
  REFUSAL_BASE: 10,
  EXIT_LAUNCH_REFUSED: 20,
  EXIT_UNOBSERVED: 21,
} as const satisfies Readonly<Record<string, number>>);

/**
 * The `DescriptorReason` ordinal a broker exit code encodes, or null. Null is
 * the closed-set answer: a signal, a non-integer, and every code outside the
 * band say nothing about a descriptor.
 */
export function descriptorReasonFromExit(code: number | null): number | null {
  if (code === null || !Number.isInteger(code)) return null;
  if (code < BROKER_EXIT_CODES.REFUSAL_BASE || code >= BROKER_EXIT_CODES.EXIT_LAUNCH_REFUSED) {
    return null;
  }
  return code - BROKER_EXIT_CODES.REFUSAL_BASE;
}

/**
 * A refusal as it arrived on fd1: broker layer, layer-local reason ordinal,
 * and the numeric Win32 code (zero for a broker-owned refusal).
 */
export interface BrokerRefusal {
  readonly layer: WindowsProcessLayer;
  readonly reason: number;
  readonly code: number;
}
