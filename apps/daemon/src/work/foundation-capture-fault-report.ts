import type { DiagnosticEmitter, DiagnosticThrown } from "@moe/contracts";

/**
 * The capture producer THREW under a Foundation attempt's settlement. The settlement answered
 * UNPROVEN — correct: a throw is no observation — and until this record that was the whole
 * story: the seat's attempt ended `WORK_CANCEL` with the tree left in place, and nothing said
 * that the capture itself, not the provider run, had died.
 */
export const FOUNDATION_CAPTURE_THREW = "FOUNDATION_CAPTURE_THREW";

export type FoundationCaptureFaultObserver = (thrown: DiagnosticThrown) => void;

export function foundationCaptureFaultReporter(emitter: DiagnosticEmitter): FoundationCaptureFaultObserver {
  return (thrown: DiagnosticThrown): void => {
    emitter.error(FOUNDATION_CAPTURE_THREW, {
      fields: {
        thrownCauses: thrown.causes.join(" <- "),
        thrownCode: thrown.code,
        thrownMessage: thrown.message,
        thrownName: thrown.name,
        thrownStack: thrown.stack,
      },
    });
  };
}
