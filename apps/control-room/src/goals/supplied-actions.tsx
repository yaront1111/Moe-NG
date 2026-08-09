import type { NextAllowedCommand, RuntimeCommandKind } from "@moe/contracts";
import type { JSX } from "react";

import { actionTestId, useGating } from "../shell/frame.js";

/**
 * The one mutation control every canonical surface renders through.
 *
 * A control exists only because the daemon returned a `NextAllowedCommand` whose
 * `targetAggregateId` is exactly this entity. There is no widening: no phase, no
 * lifecycle table, and no audience heuristic can add an affordance the daemon did not
 * return, and `NextAllowedCommand` carries no audience field to classify by.
 *
 * Enablement is the supplied `actionsEnabled` verbatim. An absent command is absent —
 * the contract carries no reason field, so a rendered "disabled because…" would be
 * invented copy (§8.1 requires absence instead). Activation hands the caller the exact
 * frozen object the daemon supplied; this component constructs no envelope and reaches
 * no transport.
 */
export type SuppliedActionHandler = (command: NextAllowedCommand) => void;

export interface SuppliedActionsProps {
  /** Optional narrowing the caller asked for; it never widens the supplied set. */
  readonly commandKind?: RuntimeCommandKind | undefined;
  readonly onActivate?: SuppliedActionHandler | undefined;
  readonly targetAggregateId: string;
  readonly testId: string;
}

function matches(
  command: NextAllowedCommand,
  targetAggregateId: string,
  commandKind: RuntimeCommandKind | undefined,
): boolean {
  if (command.targetAggregateId !== targetAggregateId) return false;
  return commandKind === undefined || command.commandKind === commandKind;
}

export function SuppliedActions(props: SuppliedActionsProps): JSX.Element {
  const { commandKind, onActivate, targetAggregateId, testId } = props;
  const { actionsEnabled, commands } = useGating();
  const shown = commands.filter((command) => matches(command, targetAggregateId, commandKind));
  return (
    <div data-testid={testId}>
      {shown.map((command) => (
        <button
          aria-label={`${command.commandKind}: ${command.targetAggregateId}`}
          data-command-id={command.commandId}
          data-command-kind={command.commandKind}
          data-command-target={command.targetAggregateId}
          data-testid={actionTestId(command)}
          disabled={!actionsEnabled}
          key={command.commandId}
          onClick={() => {
            onActivate?.(command);
          }}
          type="button"
        >
          {command.commandKind}
        </button>
      ))}
    </div>
  );
}
