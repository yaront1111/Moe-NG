import type { JSX } from "react";

import { OutcomeNote } from "../components/outcome-note.js";
import { MIDDOT } from "../glyphs.js";
import { readFailedSaid } from "../outcome-words.js";
import type {
  PlanningRunAcceptanceView,
  PlanningRunApprovalState,
  PlanningRunOutcome,
  PlanningRunPlanView,
} from "../../live/live-planning-run.js";

/**
 * THE PLAN A HUMAN READS, before the decision that follows it. Every export here is
 * a pure render of one daemon answer; none of them dispatch, and none of them decide
 * whether the run may be approved. That separation is why this module can be read on
 * its own: the write path lives in approve-plan.tsx and the grant in plan-approval.ts.
 *
 * SEALED vs UNSEALED is an honest data state: a RUN whose bodies do not re-verify
 * comes back with a null plan (sealed:false) and is shown as "nothing to review",
 * not as an error. A REFUSED/ERROR outcome shows its code/layer plainly, never a
 * blank surface.
 */

export type ApprovePlanLoadState =
  | { readonly phase: "LOADING" }
  | { readonly phase: "LOADED"; readonly outcome: PlanningRunOutcome };

function PlanSection({ plan }: { readonly plan: PlanningRunPlanView }): JSX.Element {
  return (
    <section className="cr2-approve-block" data-testid="cr.approve.plan">
      <h3 className="cr2-approve-heading">{`PLAN ${MIDDOT} ${plan.steps.length} steps`}</h3>
      <ol className="cr2-approve-steps">
        {plan.steps.map((step) => (
          <li className="cr2-approve-step" data-testid={`cr.approve.step.${step.stepId}`} key={step.stepId}>
            <span className="cr2-approve-step-head">
              <span className="cr2-approve-mono">{step.stepId}</span>
              <span className="cr2-approve-kind">{step.kind}</span>
            </span>
            <span className="cr2-approve-step-body">{step.description}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function AcceptanceSection(
  { acceptance }: { readonly acceptance: PlanningRunAcceptanceView },
): JSX.Element {
  return (
    <section className="cr2-approve-block" data-testid="cr.approve.acceptance">
      <h3 className="cr2-approve-heading">
        {`ACCEPTANCE ${MIDDOT} ${acceptance.obligations.length} obligations`}
      </h3>
      <ul className="cr2-approve-obligations">
        {acceptance.obligations.map((obligation) => (
          <li
            className="cr2-approve-obligation"
            data-testid={`cr.approve.obligation.${obligation.criterionId}`}
            key={obligation.criterionId}
          >
            <span className="cr2-approve-mono">{obligation.criterionId}</span>
            <span className="cr2-approve-step-body">{obligation.statement}</span>
            {obligation.evidenceRequirements.length === 0 ? null : (
              <span className="cr2-approve-evidence" data-testid="cr.approve.evidence">
                {`Evidence: ${obligation.evidenceRequirements.map((e) => e.kind).join(", ")}`}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function bannerText(
  reviewable: boolean, approval: PlanningRunApprovalState, lifecycle: string,
): string {
  if (reviewable) return "Ready for your approval";
  // A decided run really does stay in PLAN_REVIEW; "still planning" would be the wrong truth.
  if (approval === "BOUND") {
    return `Approved - the decision is bound to this run; execution proceeds (run lifecycle ${lifecycle})`;
  }
  if (approval === "UNREADABLE") {
    return `Approval state unreadable - not offered for approval, lifecycle ${lifecycle}`;
  }
  return `Still planning - not ready to approve yet, lifecycle ${lifecycle}`;
}

function ReviewableBanner(
  { reviewable, lifecycle, approval }: {
    readonly reviewable: boolean; readonly lifecycle: string;
    readonly approval: PlanningRunApprovalState;
  },
): JSX.Element {
  return (
    <p
      className="cr2-approve-banner"
      data-approval={approval}
      data-reviewable={reviewable ? "true" : "false"}
      data-testid="cr.approve.banner"
    >
      {bannerText(reviewable, approval, lifecycle)}
    </p>
  );
}

/** The RUN body: a sealed plan + acceptance to review, or the honest not-sealed empty. */
function RunView(
  { outcome }: {
    readonly outcome: Extract<PlanningRunOutcome, { status: "RUN" }>;
  },
): JSX.Element {
  if (!outcome.sealed || outcome.plan === null) {
    return (
      <div className="cr2-approve-empty" data-testid="cr.approve.empty">
        <ReviewableBanner approval={outcome.approval} lifecycle={outcome.lifecycle} reviewable={outcome.reviewable} />
        <p className="cr2-slot-body">The plan is not sealed yet; nothing to review.</p>
      </div>
    );
  }
  return (
    <div className="cr2-approve-body">
      <ReviewableBanner approval={outcome.approval} lifecycle={outcome.lifecycle} reviewable={outcome.reviewable} />
      <PlanSection plan={outcome.plan} />
      {outcome.acceptance === null ? null : <AcceptanceSection acceptance={outcome.acceptance} />}
      <details className="cr2-approve-inspect" data-testid="cr.approve.inspect">
        <summary className="cr2-approve-inspect-summary">Inspect hashes</summary>
        <dl className="cr2-approve-hashes">
          <dt>submissionHash</dt>
          <dd className="cr2-approve-mono">{outcome.submissionHash}</dd>
          <dt>planHash</dt>
          <dd className="cr2-approve-mono">{outcome.plan.planHash}</dd>
        </dl>
      </details>
    </div>
  );
}

export function OutcomeView({ outcome }: { readonly outcome: PlanningRunOutcome }): JSX.Element {
  if (outcome.status === "RUN") return <RunView outcome={outcome} />;
  // REFUSED and ERROR both name their code and layer plainly, never a blank.
  return (
    <OutcomeNote
      code={outcome.code}
      layer={outcome.layer}
      said={readFailedSaid("plan")}
      testId="cr.approve.refusal"
    />
  );
}

/** The durable lifecycle a completed approval left behind, read back from the daemon. */
export function AppliedLine({ state }: { readonly state: ApprovePlanLoadState }): JSX.Element | null {
  if (state.phase !== "LOADED" || state.outcome.status !== "RUN") return null;
  return (
    <p className="cr2-approve-banner" data-testid="cr.approve.applied">
      {`Approved ${MIDDOT} the daemon now reports approval ${state.outcome.approval}, lifecycle ${state.outcome.lifecycle}`}
    </p>
  );
}
