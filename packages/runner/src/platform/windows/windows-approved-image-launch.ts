import { CHANNEL_PAYLOAD_CAPS } from "./windows-frames.js";
import { unknownOutcome } from "./windows-process-contract.js";
import type { WindowsProcessUnknown } from "./windows-process-contract.js";

export const APPROVED_IMAGE_LAUNCH_OPCODE = 4;
/** The existing launch payload stays byte-for-byte unchanged after this strict digest prefix. */
export function prefixApprovedImageDigest(digest: unknown, launch: Uint8Array): Uint8Array | WindowsProcessUnknown {
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) return unknownOutcome(
    "PROCESS_BOUNDARY_EXECUTABLE_REJECTED", "WINDOWS_PROCESS_REQUEST", "the approved image digest is invalid");
  if (launch.byteLength + 66 > CHANNEL_PAYLOAD_CAPS.CONTROL) return unknownOutcome(
    "PROCESS_BOUNDARY_REQUEST_OVERSIZED", "WINDOWS_PROCESS_REQUEST", "the approved image request exceeds the control cap");
  const payload = new Uint8Array(launch.byteLength + 66);
  payload[0] = 64; payload.set(new TextEncoder().encode(digest), 2); payload.set(launch, 66);
  return payload;
}
