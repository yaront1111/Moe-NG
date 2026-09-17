import type { JSX } from "react";

/**
 * A refusal or failed read: the person's sentence first, the daemon's code behind
 * Details so a glance never has to decode CODE @ LAYER.
 */

export interface OutcomeNoteProps {
  readonly said: string;
  readonly code: string;
  readonly layer: string;
  readonly testId: string;
  readonly role?: "alert" | "status";
}

export function OutcomeNote({
  said, code, layer, testId, role = "status",
}: OutcomeNoteProps): JSX.Element {
  return (
    <div className="cr2-outcome" data-testid={testId} role={role}>
      <p className="cr2-outcome-said">{said}</p>
      <details className="cr2-outcome-details">
        <summary>Details</summary>
        <code>{`${code} @ ${layer}`}</code>
      </details>
    </div>
  );
}
