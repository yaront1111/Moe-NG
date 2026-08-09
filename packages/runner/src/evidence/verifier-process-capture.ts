import { sha256Hex } from "../canonical.js";
import {
  MAX_VERIFIER_OUTPUT_BYTES,
  type VerifierStreamCapture,
} from "./verifier-process-contract.js";

export interface StreamCollector {
  /** True exactly once, on the chunk that first crossed the bound. */
  readonly append: (chunk: Uint8Array) => boolean;
  readonly seal: () => VerifierStreamCapture;
}

/**
 * Bytes are counted AS THEY ARRIVE and the tail is dropped at the bound. A
 * collector that concatenated first and measured afterwards would let a chatty
 * verifier allocate without limit before anything noticed, which turns a noisy
 * child into a daemon-wide memory failure.
 */
export function createStreamCollector(): StreamCollector {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let truncated = false;
  return Object.freeze({
    append(chunk: Uint8Array): boolean {
      if (truncated) {
        return false;
      }
      const remaining = MAX_VERIFIER_OUTPUT_BYTES - byteLength;
      if (chunk.byteLength <= remaining) {
        chunks.push(chunk);
        byteLength += chunk.byteLength;
        return false;
      }
      chunks.push(chunk.subarray(0, remaining));
      byteLength = MAX_VERIFIER_OUTPUT_BYTES;
      truncated = true;
      return true;
    },
    seal(): VerifierStreamCapture {
      const bytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return Object.freeze({ bytes, byteLength, sha256: sha256Hex(bytes), truncated });
    },
  });
}
