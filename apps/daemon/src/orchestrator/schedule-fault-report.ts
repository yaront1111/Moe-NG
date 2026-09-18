import type { DiagnosticEmitter } from "@moe/contracts";

import type { ScheduleFault } from "./durable-schedule.js";

/**
 * A durable-schedule refusal, on the diagnostics plane. The schedule keeps its notices free of
 * exceptions by contract (`refusals()` is read back by consumers), so the THROW travels only
 * here: a backup job, a release auto-decide or a health probe that died on its tick used to be
 * `SCHEDULE_CALLBACK_FAILED` and nothing more, once, in a notice nobody grepped.
 */
export const SCHEDULE_FAULT = "SCHEDULE_FAULT";

export function scheduleFaultReporter(emitter: DiagnosticEmitter): (fault: ScheduleFault) => void {
  return (fault: ScheduleFault): void => {
    const fields = { code: fault.code, id: fault.id };
    if (fault.thrown === null) {
      emitter.warn(SCHEDULE_FAULT, { fields });
      return;
    }
    emitter.error(SCHEDULE_FAULT, {
      fields: {
        ...fields,
        thrownCauses: fault.thrown.causes.join(" <- "),
        thrownCode: fault.thrown.code,
        thrownMessage: fault.thrown.message,
        thrownName: fault.thrown.name,
        thrownStack: fault.thrown.stack,
      },
    });
  };
}
