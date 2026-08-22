import {
  BROKER_EXIT_CODES,
  descriptorReasonFromExit,
} from "./windows-process-broker-contract.js";
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

/**
 * The broker exited and fd1 carried NO terminal frame, so its exit code is the
 * only evidence left. It is read here and nowhere else: a frame that did arrive
 * outranks the code, because `main.rs` exits a descriptor code AFTER a COMPLETED
 * frame when its own close fails on an otherwise READY run.
 *
 * `EXIT_UNOBSERVED` is trusted only once a started frame named the run, since
 * an unobserved end presupposes a start. A descriptor refusal exits before fd1
 * could carry anything, so it is trusted only with NO identity; its Win32 code
 * did not cross the pipe and is zero here. Every other code, and every signal,
 * is "the broker exited" and nothing finer.
 */
export function exitWithoutFrame(
  code: number | null,
  signal: string | null,
  identity: WindowsProcessIdentity | null,
): WindowsProcessUnknown {
  if (code === BROKER_EXIT_CODES.EXIT_UNOBSERVED && identity !== null) {
    return transportFailure(
      "PROCESS_BOUNDARY_EXIT_UNOBSERVED",
      "the broker could not observe the provider's exit exactly (exit 21)",
      identity,
    );
  }
  const reason = descriptorReasonFromExit(code);
  if (reason !== null && identity === null) {
    return unknownOutcome(
      "PROCESS_BOUNDARY_BROKER_REFUSED",
      "BROKER_DESCRIPTOR",
      "the broker refused its descriptor block before fd1 could carry a frame",
      { identity: null, brokerReason: { layer: "BROKER_DESCRIPTOR", reason, code: 0 } },
    );
  }
  return transportFailure(
    "PROCESS_BOUNDARY_BROKER_EXITED",
    `the broker exited without a terminal status frame (exit ${code ?? "none"}, signal ${signal ?? "none"})`,
    identity,
  );
}
