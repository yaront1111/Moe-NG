import { type WindowsProcessLayer } from "./windows-process-contract.js";

/**
 * The broker's three refusing layers and their FROZEN 1-BASED wire bytes
 * (`refusal.rs`, `RefusalLayer::wire`). Zero is deliberately not a layer.
 */
export const BROKER_LAYER_BY_WIRE = Object.freeze({
  1: "BROKER_DESCRIPTOR",
  2: "BROKER_PROTOCOL",
  3: "BROKER_NATIVE",
} as const satisfies Readonly<Record<number, WindowsProcessLayer>>);

/** The layer a refusal wire byte names, or null. Null is the closed-set answer. */
export function brokerLayerFromWire(byte: number): WindowsProcessLayer | null {
  if (byte === 1 || byte === 2 || byte === 3) {
    return BROKER_LAYER_BY_WIRE[byte];
  }
  return null;
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
