import { faultFrameOf } from "./http/http-refusal-tag.js";
import type { FaultFrame } from "./http/http-refusal-tag.js";

/**
 * The seat-side twin of the listener's LISTENER_FAULT_FRAME. A frame that reports the daemon's
 * OWN fault (`faultFrameOf`: the durable-store layer, or a code saying something could not be
 * READ or a store call FAILED or THREW) is remembered against the bytes it became, so the MCP
 * dispatch port's exit can name it without re-parsing the answer. The seat receives the same
 * bytes it always did; on this transport the answer is otherwise seen only by the seat.
 */

/** The fault a seat is about to be answered with, and where. */
export interface McpFaultFrame extends FaultFrame {
  /** The verbatim runtime kind; null when the command bytes named none. */
  readonly kind: string | null;
  readonly surface: "command" | "query";
}

const decoder = new TextDecoder();
const faultFrames = new WeakMap<Uint8Array, FaultFrame>();

/** Remembers the fault `value` reports, if any, against `bytes`; answers `bytes` unchanged. */
export function rememberFaultFrame(value: unknown, bytes: Uint8Array): Uint8Array {
  const fault = faultFrameOf(value);
  if (fault !== null) faultFrames.set(bytes, fault);
  return bytes;
}

/** The fault remembered against these bytes, or null. */
export function faultFrameFor(bytes: Uint8Array): FaultFrame | null {
  return faultFrames.get(bytes) ?? null;
}

/**
 * Hands the fault remembered against `bytes` to the observer, then answers `bytes` unchanged.
 * Fenced: the bytes are the seat's answer, and a broken observer does not get to change them.
 */
export function discloseFaultFrame(
  observe: ((frame: McpFaultFrame) => void) | undefined,
  bytes: Uint8Array, surface: McpFaultFrame["surface"], kind: string | null,
): Uint8Array {
  const fault = faultFrameFor(bytes);
  if (fault !== null && observe !== undefined) {
    try {
      observe({ ...fault, kind, surface });
    } catch { /* the answer stands */ }
  }
  return bytes;
}

/** The command kind the envelope bytes name, or null; a decode fault answers null too. */
export function commandKindOf(bytes: Uint8Array): string | null {
  try {
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    const kind = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { commandKind?: unknown }).commandKind : undefined;
    return typeof kind === "string" ? kind : null;
  } catch {
    return null;
  }
}
