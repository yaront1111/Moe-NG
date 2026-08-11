import {
  unknownOutcome,
  type WindowsProcessCode,
  type WindowsProcessIdentity,
  type WindowsProcessUnknown,
} from "./windows-process-contract.js";

/** A transport-layer UNKNOWN that preserves any identity already observed. */
export function transportFailure(
  code: WindowsProcessCode,
  message: string,
  identity: WindowsProcessIdentity | null,
): WindowsProcessUnknown {
  return unknownOutcome(code, "WINDOWS_PROCESS_TRANSPORT", message, { identity });
}
