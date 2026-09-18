import { useId } from "react";
import type { JSX } from "react";
import { ESCALATION_GUIDANCE_MAX_LENGTH, validEscalationGuidance } from "./escalation-port.js";

export function EscalationGuidanceInput({ disabled, onChange, supported, value }: {
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
  readonly supported: boolean;
  readonly value: string;
}): JSX.Element | null {
  const id = useId();
  if (!supported && value.length === 0) return null;
  return (
    <div className="cr2-needs-guidance">
      <label htmlFor={id}>Answers or instructions for the next attempt (optional)</label>
      <textarea id={id} aria-describedby={`${id}-note`} disabled={disabled || !supported}
        maxLength={ESCALATION_GUIDANCE_MAX_LENGTH} rows={4} style={{ width: "100%", boxSizing: "border-box" }}
        onChange={(event): void => onChange(event.currentTarget.value)} value={value} />
      <p className="cr2-needs-note" id={`${id}-note`}>
        Optional. Saved with your approval of one more attempt and sent to the worker word for word; leave it empty to retry as is. Approved requirements and checks still apply.
      </p>
      {!supported ? <p className="cr2-needs-note" role="status">
        This daemon does not support retry guidance. Refresh after updating Moe.
      </p> : value.length > 0 && !validEscalationGuidance(value) ? <p className="cr2-needs-note" role="status">
        Enter nonblank instructions of at most 4,000 characters.
      </p> : null}
    </div>
  );
}
