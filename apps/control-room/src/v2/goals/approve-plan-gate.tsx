import type { JSX } from "react";

import { OutcomeNote } from "../components/outcome-note.js";
import { ActionButton } from "../components/primitives.js";
import { writeFailedSaid } from "../outcome-words.js";
import type {
  ApprovalAuthorization, ApprovalGrant, PlanApprovalOutcome,
} from "./plan-approval.js";

/**
 * The Approve control: the one write on the plan-review screen, and the operator's
 * view of why it is or is not available.
 *
 * DISABLED, NEVER INERT. When the daemon has not granted this run's approval the
 * button is rendered `disabled` AND the withheld code is named beside its layer. An
 * inert control that silently swallows the click satisfies "clicking does not
 * approve" while telling the operator nothing about what is missing, which is the
 * failure this component exists to avoid.
 *
 * A REFUSAL IS KEPT, NOT CLEARED. `code MIDDOT layer` is the operator's only handle
 * on what to do next - which authority answered, and what it said - so a refused
 * dispatch leaves the reason on screen rather than resetting to a generic error or
 * a blank control.
 */

export interface PlanApprovalSurface {
  /** The daemon's current word on whether this run may be approved. */
  readonly authorization: ApprovalAuthorization;
  readonly submit: (grant: ApprovalGrant) => Promise<PlanApprovalOutcome>;
}

export interface ApproveGateProps {
  readonly authorization: ApprovalAuthorization;
  readonly busy: boolean;
  readonly onApprove: () => void;
  /** The refusal the last dispatch carried back, kept visible until the next one. */
  readonly refusal: Extract<PlanApprovalOutcome, { ok: false }> | null;
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

export function ApproveGate({ authorization, busy, onApprove, refusal }: ApproveGateProps): JSX.Element {
  const granted = authorization.status === "AUTHORIZED";
  return (
    <div className="cr2-approve-gate">
      <ActionButton
        disabled={!granted || busy}
        onClick={granted ? onApprove : undefined}
        testId="cr.approve.button"
        variant="primary"
      >
        Approve plan
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
