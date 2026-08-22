import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { ActionButton } from "../components/primitives.js";
import { ARROW_LEFT, MIDDOT } from "../glyphs.js";
import type {
  PlanningRunAcceptanceView,
  PlanningRunOutcome,
  PlanningRunPlanView,
} from "../../live/live-planning-run.js";

/**
 * The PLAN-REVIEW screen (UI-6): the run a human reads BEFORE approving. It READS
 * the daemon's plan-review route and RENDERS it; it authors nothing.
 *
 * The Approve control is deliberately PRESENT BUT DISABLED. Approving today would
 * post the client-authored fixture record DEV_PAYLOADS["approval.decide"] (a
 * fabricated actor and hashes) - which violates this product's core principle that
 * the daemon is the only author of state and the standing "no fabricated state"
 * ruling. So this module imports nothing that dispatches, and the disabled button
 * carries an honest note naming the backend gap rather than pretending to approve.
 *
 * SEALED vs UNSEALED is an honest data state: a RUN whose bodies do not re-verify
 * comes back with a null plan (sealed:false) and is shown as "nothing to review",
 * not as an error. A REFUSED/ERROR outcome shows its code/layer plainly, never a
 * blank surface.
 */

export interface ApprovePlanProps {
  readonly runId: string;
  readonly title: string;
  readonly goalId: string;
  readonly onBack: () => void;
  readonly read: (runId: string) => Promise<PlanningRunOutcome>;
}

type LoadState =
  | { readonly phase: "LOADING" }
  | { readonly phase: "LOADED"; readonly outcome: PlanningRunOutcome };

/** The disabled Approve control and its honesty note - rendered in every state. */
function ApproveGate(): JSX.Element {
  return (
    <div className="cr2-approve-gate">
      <ActionButton disabled testId="cr.approve.button" variant="primary">
        Approve plan
      </ActionButton>
      <p className="cr2-approve-note" data-testid="cr.approve.note">
        Approving from the control room needs the daemon-authored approval record
        (backend gap); it is not wired here so no fabricated decision is posted.
      </p>
    </div>
  );
}

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

function ReviewableBanner(
  { reviewable, lifecycle }: { readonly reviewable: boolean; readonly lifecycle: string },
): JSX.Element {
  return (
    <p className="cr2-approve-banner" data-reviewable={reviewable ? "true" : "false"} data-testid="cr.approve.banner">
      {reviewable
        ? "Ready for your approval"
        : `Still planning - not ready to approve yet, lifecycle ${lifecycle}`}
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
        <ReviewableBanner lifecycle={outcome.lifecycle} reviewable={outcome.reviewable} />
        <p className="cr2-slot-body">The plan is not sealed yet; nothing to review.</p>
      </div>
    );
  }
  return (
    <div className="cr2-approve-body">
      <ReviewableBanner lifecycle={outcome.lifecycle} reviewable={outcome.reviewable} />
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

function OutcomeView({ outcome }: { readonly outcome: PlanningRunOutcome }): JSX.Element {
  if (outcome.status === "RUN") return <RunView outcome={outcome} />;
  // REFUSED and ERROR both name their code and layer plainly, never a blank.
  return (
    <p className="cr2-approve-refusal" data-testid="cr.approve.refusal">
      {`${outcome.status} ${MIDDOT} ${outcome.code} ${MIDDOT} ${outcome.layer}`}
    </p>
  );
}

export function ApprovePlan({ runId, title, goalId, onBack, read }: ApprovePlanProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ phase: "LOADING" });
  // Latest-wins: a runId change (or a slow read that resolves after unmount) must
  // not overwrite a newer read. The generation ref is the only writer gate.
  const generation = useRef(0);

  useEffect(() => {
    const run = generation.current + 1;
    generation.current = run;
    setState({ phase: "LOADING" });
    void read(runId).then((outcome) => {
      if (generation.current === run) setState({ outcome, phase: "LOADED" });
    });
    return (): void => { generation.current += 1; };
  }, [read, runId]);

  return (
    <section className="cr2-approve" data-testid="cr.approve.screen">
      <p className="cr2-slot-kicker">{`PLAN REVIEW ${MIDDOT} ${goalId}`}</p>
      <h2 className="cr2-slot-title">{title}</h2>
      {state.phase === "LOADING" ? (
        <p className="cr2-slot-kicker" data-testid="cr.approve.loading">Reading the plan...</p>
      ) : (
        <OutcomeView outcome={state.outcome} />
      )}
      <ApproveGate />
      <ActionButton onClick={onBack} testId="cr.approve.back" variant="secondary">
        {`${ARROW_LEFT} Back to goals`}
      </ActionButton>
    </section>
  );
}
