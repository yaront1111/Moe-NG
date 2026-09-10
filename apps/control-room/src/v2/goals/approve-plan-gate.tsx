import { useState } from "react";
import type { JSX } from "react";

import { OutcomeNote } from "../components/outcome-note.js";
import { ActionButton } from "../components/primitives.js";
import { writeFailedSaid } from "../outcome-words.js";
import type {
  ApprovalAuthorization, ApprovalGrant, PlanApprovalOutcome,
} from "./plan-approval.js";

/**
 * The two decisions on the plan-review screen - approve it, or send it back - and
 * the operator's view of why they are or are not available.
 *
 * DISABLED, NEVER INERT. When the daemon has not granted this run's decision both
 * controls are rendered `disabled` AND the withheld code is named beside its layer.
 * An inert control that silently swallows the click satisfies "clicking does not
 * approve" while telling the operator nothing about what is missing, which is the
 * failure this component exists to avoid.
 *
 * A REASON IS REQUIRED TO REJECT, and this browser refuses an empty one BEFORE
 * spending the grant. That is not a duplicate of the daemon's own
 * APPROVAL_REJECT_REASON_REQUIRED fence: the daemon fences the WRITE, this fences
 * the CLICK, so an operator who has typed nothing is told so without burning a
 * round trip and without the reject appearing to have been sent. Whitespace is not
 * a reason - a reason made only of spaces reaches the successor's mission as a
 * blank instruction, which is worse than no reject at all.
 *
 * THE REASON IS NEVER RE-WORDED. It travels to the port exactly as typed; the
 * daemon fences it into the successor's compiler mission, so a trim or a summary
 * here would silently rewrite what the next planner is told.
 *
 * A REFUSAL IS KEPT, NOT CLEARED. `code MIDDOT layer` is the operator's only handle
 * on what to do next - which authority answered, and what it said - so a refused
 * dispatch leaves the reason on screen rather than resetting to a generic error or
 * a blank control.
 */

export interface PlanApprovalSurface {
  /** The daemon's current word on whether this run may be approved. */
  readonly authorization: ApprovalAuthorization;
  /**
   * The plan was sent back and the daemon has not offered the successor for approval
   * yet. Derived from the frame by `planSentBack`; this component never infers it.
   */
  readonly sentBack?: boolean | undefined;
  readonly submit: (
    grant: ApprovalGrant, decisionReason: string | null,
  ) => Promise<PlanApprovalOutcome>;
}

export interface ApproveGateProps {
  readonly authorization: ApprovalAuthorization;
  readonly busy: boolean;
  readonly onApprove: () => void;
  /** Called with the operator's reason VERBATIM; never called with an empty one. */
  readonly onReject: (decisionReason: string) => void;
  /** The refusal the last dispatch carried back, kept visible until the next one. */
  readonly refusal: Extract<PlanApprovalOutcome, { ok: false }> | null;
  /** True while the daemon is replanning a plan this operator sent back. */
  readonly sentBack?: boolean | undefined;
}

function WithheldReason({ authorization }: {
  readonly authorization: Extract<ApprovalAuthorization, { status: "WITHHELD" }>;
}): JSX.Element {
  return (
    <OutcomeNote
      code={authorization.code}
      layer={authorization.layer}
      said="Approval is not offered for this run yet."
      testId="cr.approve.reason"
    />
  );
}

/**
 * WAITING FOR THE RE-PLAN. While the successor is being compiled there is no decision
 * to make, so the controls are not rendered at all rather than rendered disabled: a
 * disabled Approve beside "Plan sent back" reads as a decision the operator is being
 * refused, when in fact none is being asked of them yet. A dispatch refusal from the
 * reject that got them here stays visible underneath.
 */
function SentBackNote(): JSX.Element {
  return (
    <p className="cr2-approve-banner" data-testid="cr.approve.sent-back">
      Plan sent back - waiting for a new plan
    </p>
  );
}

export function ApproveGate(
  { authorization, busy, onApprove, onReject, refusal, sentBack }: ApproveGateProps,
): JSX.Element {
  const [reason, setReason] = useState("");
  const granted = authorization.status === "AUTHORIZED";
  // Trimmed ONLY to decide whether a reason was given. What is sent is `reason` itself.
  const canReject = granted && !busy && reason.trim() !== "";
  if (sentBack === true) {
    return (
      <div className="cr2-approve-gate">
        <SentBackNote />
        {refusal === null ? null : (
          <OutcomeNote
            code={refusal.code}
            layer={refusal.layer}
            said={writeFailedSaid()}
            testId="cr.approve.dispatch-refusal"
          />
        )}
      </div>
    );
  }
  return (
    <div className="cr2-approve-gate">
      <label className="cr2-approve-reason-field">
        Why are you sending this plan back?
        <input
          className="cr2-approve-reason-input"
          data-testid="cr.approve.reason.input"
          disabled={!granted || busy}
          maxLength={2000}
          onChange={(event): void => { setReason(event.target.value); }}
          type="text"
          value={reason}
        />
      </label>
      <ActionButton
        disabled={!granted || busy}
        onClick={granted ? onApprove : undefined}
        testId="cr.approve.button"
        variant="primary"
      >
        Approve plan
      </ActionButton>
      <ActionButton
        disabled={!canReject}
        onClick={canReject ? (): void => { onReject(reason); } : undefined}
        testId="cr.approve.reject"
        variant="secondary"
      >
        Send the plan back
      </ActionButton>
      {authorization.status === "WITHHELD"
        ? <WithheldReason authorization={authorization} />
        : null}
      {refusal === null ? null : (
        <OutcomeNote
          code={refusal.code}
          layer={refusal.layer}
          said={writeFailedSaid()}
          testId="cr.approve.dispatch-refusal"
        />
      )}
    </div>
  );
}
