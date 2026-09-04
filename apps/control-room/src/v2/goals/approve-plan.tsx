import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { OutcomeNote } from "../components/outcome-note.js";
import { ActionButton } from "../components/primitives.js";
import { ARROW_LEFT, MIDDOT } from "../glyphs.js";
import { readFailedSaid } from "../outcome-words.js";
import type {
  PlanningRunAcceptanceView,
  PlanningRunApprovalState,
  PlanningRunOutcome,
  PlanningRunPlanView,
} from "../../live/live-planning-run.js";
import { ApproveGate } from "./approve-plan-gate.js";
import type { PlanApprovalSurface } from "./approve-plan-gate.js";
import { PLAN_APPROVAL_LAYER } from "./plan-approval.js";
import type { ApprovalAuthorization, PlanApprovalOutcome } from "./plan-approval.js";

/**
 * The PLAN-REVIEW screen (UI-6): the run a human reads BEFORE approving, and the
 * one write that follows.
 *
 * APPROVAL IS AFFORDANCE-GATED, and the gate lives in `plan-approval.ts` rather
 * than here: this screen renders whatever verdict it is handed and dispatches only
 * a grant the daemon offered. It composes no authority of its own - no actor, no
 * truthClass, no record - because the daemon mints the human-review witness from
 * the authenticated principal, and a browser-authored one would be a fabrication.
 *
 * SUCCESS REFRESHES DURABLE STATE. An accepted write does not let this screen
 * decide what the run now IS: it re-reads the plan-review route and renders the
 * lifecycle the daemon reports. Nothing optimistic is shown, so the operator never
 * sees a state the ledger does not hold.
 *
 * A REFUSAL IS KEPT. The dispatch refusal stays on screen with the exact code and
 * the layer that answered, and does NOT trigger a re-read: durable state did not
 * move, so re-reading would only replace the reason with a fresh, unchanged plan.
 *
 * SEALED vs UNSEALED is an honest data state: a RUN whose bodies do not re-verify
 * comes back with a null plan (sealed:false) and is shown as "nothing to review",
 * not as an error. A REFUSED/ERROR outcome shows its code/layer plainly, never a
 * blank surface.
 */

/** No approval surface handed in means no frame has been read for this screen yet. */
const UNREAD_AUTHORIZATION: ApprovalAuthorization = Object.freeze({
  code: "APPROVAL_SURFACE_UNREAD" as const,
  layer: PLAN_APPROVAL_LAYER,
  status: "WITHHELD" as const,
});

export interface ApprovePlanProps {
  readonly runId: string;
  readonly title: string;
  readonly goalId: string;
  readonly onBack: () => void;
  readonly read: (runId: string) => Promise<PlanningRunOutcome>;
  /** The daemon's approval grant for this run plus the wire to spend it, when attached. */
  readonly approval?: PlanApprovalSurface | undefined;
}

type LoadState =
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

function OutcomeView({ outcome }: { readonly outcome: PlanningRunOutcome }): JSX.Element {
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
function AppliedLine({ state }: { readonly state: LoadState }): JSX.Element | null {
  if (state.phase !== "LOADED" || state.outcome.status !== "RUN") return null;
  return (
    <p className="cr2-approve-banner" data-testid="cr.approve.applied">
      {`Approved ${MIDDOT} the daemon now reports approval ${state.outcome.approval}, lifecycle ${state.outcome.lifecycle}`}
    </p>
  );
}

type DispatchRefusal = Extract<PlanApprovalOutcome, { ok: false }>;

export function ApprovePlan(
  { runId, title, goalId, onBack, read, approval }: ApprovePlanProps,
): JSX.Element {
  const [state, setState] = useState<LoadState>({ phase: "LOADING" });
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<DispatchRefusal | null>(null);
  // Bumped ONLY by an accepted write, so the durable re-read happens exactly when
  // the ledger moved. A refusal leaves it alone: nothing changed to re-read.
  const [applied, setApplied] = useState(0);
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
  }, [applied, read, runId]);

  const authorization = approval?.authorization ?? UNREAD_AUTHORIZATION;
  const onApprove = (): void => {
    if (approval === undefined || authorization.status !== "AUTHORIZED" || busy) return;
    setBusy(true);
    setRefusal(null);
    void approval.submit(authorization.grant).then((outcome) => {
      setBusy(false);
      // The daemon decides what the run now IS. On acceptance this only asks for a
      // fresh read; the new state is rendered from that answer, never from here.
      if (outcome.ok) setApplied((previous) => previous + 1);
      else setRefusal(outcome);
    }, () => {
      setBusy(false);
      setRefusal({ code: "APPROVAL_DISPATCH_FAILED", layer: PLAN_APPROVAL_LAYER, ok: false });
    });
  };

  return (
    <section className="cr2-approve" data-testid="cr.approve.screen">
      <p className="cr2-slot-kicker">{`PLAN REVIEW ${MIDDOT} ${goalId}`}</p>
      <h2 className="cr2-slot-title">{title}</h2>
      {state.phase === "LOADING" ? (
        <p className="cr2-slot-kicker" data-testid="cr.approve.loading">Reading the plan...</p>
      ) : (
        <OutcomeView outcome={state.outcome} />
      )}
      {applied === 0 ? null : <AppliedLine state={state} />}
      <ApproveGate
        authorization={authorization}
        busy={busy}
        onApprove={onApprove}
        refusal={refusal}
      />
      <ActionButton onClick={onBack} testId="cr.approve.back" variant="secondary">
        {`${ARROW_LEFT} Back to goals`}
      </ActionButton>
    </section>
  );
}
