import type { DiagnosticEmitter } from "@moe/contracts";

import type { CommandStoreFault, CommandStoreFaultObserver } from "./daemon-command-decision-port.js";

/** A commit that failed on the durable store: 503 to the caller, this record to the operator. */
export const COMMAND_STORE_FAULT = "COMMAND_STORE_FAULT";

/**
 * Turns the decision port's store-fault observer into one `error` record. Flattened into
 * fields, as the MCP reporters do: the fault carries the throw already described, and the
 * decision key names the command, the principal and the project so the record can be joined
 * to the refusal frame the caller received.
 */
export function commandStoreFaultReporter(emitter: DiagnosticEmitter): CommandStoreFaultObserver {
  return (fault: CommandStoreFault): void => {
    emitter.error(COMMAND_STORE_FAULT, {
      correlation: fault.key.commandId,
      fields: {
        code: fault.code,
        commandId: fault.key.commandId,
        detail: fault.detail,
        principalId: fault.key.principalId,
        projectId: fault.key.projectId,
        thrownCauses: fault.thrown.causes.join(" <- "),
        thrownCode: fault.thrown.code,
        thrownMessage: fault.thrown.message,
        thrownName: fault.thrown.name,
        thrownStack: fault.thrown.stack,
      },
    });
  };
}
