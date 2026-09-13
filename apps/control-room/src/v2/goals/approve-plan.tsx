import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import { ActionButton } from "../components/primitives.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { ARROW_LEFT, MIDDOT } from "../glyphs.js";
import { AppliedLine, OutcomeView } from "./approve-plan-body.js";
import type { ApprovePlanLoadState } from "./approve-plan-body.js";
import type { PlanningRunOutcome } from "../../live/live-planning-run.js";
import { ApproveGate } from "./approve-plan-gate.js";
import type { PlanApprovalSurface } from "./approve-plan-gate.js";
import { PLAN_APPROVAL_LAYER } from "./plan-approval.js";
import type { ApprovalAuthorization, PlanApprovalOutcome } from "./plan-approval.js";
import { planReviewObservationKey } from "./plan-review-observation.js";

/**
 * The PLAN-REVIEW screen (UI-6): the run a human reads BEFORE deciding, and the one
 * write that follows. The run BODY it renders lives in approve-plan-body.tsx; this
 * module owns only the read, the decision and the state the two leave behind.
 *
 * APPROVE AND REJECT ARE ONE WRITE. Both spend the SAME `approval.decide_intent`
 * grant the daemon offered for this run and differ only in the payload's `decision`
 * and the operator-authored `decisionReason`, so a reject is not a second wire and
 * cannot reach a run the daemon did not offer. The busy/refusal/re-read machinery
 * below is therefore shared verbatim: one dispatcher, two callers.
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
 */

/** No approval surface handed in means no frame has been read for this screen yet. */
const UNREAD_AUTHORIZATION: ApprovalAuthorization = Object.freeze({
  code: "APPROVAL_SURFACE_UNREAD" as const,
  layer: PLAN_APPROVAL_LAYER,
  status: "WITHHELD" as const,
});

type PlanPresence = "ABSENT" | "PRESENT" | "UNKNOWN";

/** GoalCreated reserves a run id before compilation. Only this reader's exact
 * unknown-run refusal proves absence; failed body verification or another refusal
 * establishes no such fact. Presence controls visibility, never dispatch authority. */
function planPresence(state: ApprovePlanLoadState): PlanPresence {
  if (state.phase !== "LOADED") return "UNKNOWN";
  const { outcome } = state;
  if (outcome.status === "RUN") return outcome.plan === null ? "UNKNOWN" : "PRESENT";
  return outcome.status === "REFUSED" && outcome.code === "PLANNING_RUN_READ_RUN_UNKNOWN"
    && outcome.layer === "PLANNING_RUN_READ" ? "ABSENT" : "UNKNOWN";
}

function NoPlanYet(): JSX.Element {
  return <p className="cr2-slot-body" data-testid="cr.approve.no-plan">
    The plan appears here once the contract is approved and compiled.
  </p>;
}

export interface ApprovePlanProps {
  readonly runId: string;
  readonly title: string;
  readonly goalId: string;
  readonly onBack: () => void;
  readonly read: (runId: string) => Promise<PlanningRunOutcome>;
  /** The daemon's approval grant for this run plus the wire to spend it, when attached. */
  readonly approval?: PlanApprovalSurface | undefined;
  /** Explicit refresh retries reads without replacing the decision component. */
  readonly readRevision?: number;
}

type DispatchRefusal = Extract<PlanApprovalOutcome, { ok: false }>;

/** A new run or authenticated read/write port gets independent review and dispatch state. */
export function ApprovePlan(props: ApprovePlanProps): JSX.Element {
  const serial = useRef(0);
  const scopeKey = useMemo(() => { serial.current += 1; return serial.current; },
    [props.goalId, props.runId, props.read, props.approval?.submit]);
  return <ApprovePlanReview {...props} key={scopeKey} />;
}

function ApprovePlanReview(
  { runId, title, goalId, onBack, read, approval, readRevision = 0 }: ApprovePlanProps,
): JSX.Element {
  const authorization = approval?.authorization ?? UNREAD_AUTHORIZATION;
  const observationKey = JSON.stringify([planReviewObservationKey(authorization, runId), readRevision]);
  const [loaded, setLoaded] = useState<{ key: string | null; state: ApprovePlanLoadState }>({ key: observationKey, state: { phase: "LOADING" } });
  const state: ApprovePlanLoadState = loaded.key === observationKey ? loaded.state : { phase: "LOADING" };
  const setState = useCallback((next: ApprovePlanLoadState) => setLoaded({ key: observationKey, state: next }), [observationKey]);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<DispatchRefusal | null>(null);
  // Bumped ONLY by an accepted write, so the durable re-read happens exactly when
  // the ledger moved. A refusal leaves it alone: nothing changed to re-read.
  const [applied, setApplied] = useState(0);
  // Latest-wins: a runId change (or a slow read that resolves after unmount) must
  // not overwrite a newer read. The generation ref is the only writer gate.
  const generation = useRef(0);
  const mounted = useRef(false);
  const pending = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const run = generation.current + 1;
    generation.current = run;
    setState({ phase: "LOADING" });
    void Promise.resolve().then(() => read(runId)).then((outcome) => {
      if (generation.current !== run) return;
      setState({ outcome: outcome.status === "RUN" && outcome.runId !== runId
        ? { status: "ERROR", code: "PLAN_REVIEW_BODY_SUBJECT_MISMATCH", layer: "CONTROL_ROOM_PLAN_REVIEW" }
        : outcome, phase: "LOADED" });
    }, () => {
      if (generation.current === run) setState({ outcome: {
        status: "ERROR", code: "PLAN_REVIEW_READ_FAILED", layer: "CONTROL_ROOM_PLAN_REVIEW",
      }, phase: "LOADED" });
    });
    return (): void => { generation.current += 1; };
  }, [applied, read, runId, setState]);

  const reviewReady = state.phase === "LOADED" && state.outcome.status === "RUN"
    && state.outcome.runId === runId && state.outcome.sealed && state.outcome.reviewable
    && state.outcome.plan !== null && state.outcome.acceptance !== null && state.outcome.approval === "ABSENT"
    && authorization.status === "AUTHORIZED" && authorization.grant.runId === runId
    && authorization.grant.affordance["targetAggregateId"] === runId;
  const presence = planPresence(state);
  // An offer or an observed plan explains a decision; a pending write and its
  // refusal keep the same mounted reason field even if the offer disappears.
  const showDecision = approval?.sentBack === true || authorization.status === "AUTHORIZED"
    || presence === "PRESENT" || busy || refusal !== null;
  const decide = (decisionReason: string | null): void => {
    if (approval === undefined || authorization.status !== "AUTHORIZED" || !reviewReady || pending.current) return;
    pending.current = true;
    setBusy(true);
    setRefusal(null);
    void Promise.resolve().then(() => mounted.current ? approval.submit(authorization.grant, decisionReason) : null).then((outcome) => {
      if (!mounted.current || outcome === null) return;
      pending.current = false;
      setBusy(false);
      // The daemon decides what the run now IS. On acceptance this only asks for a
      // fresh read; the new state is rendered from that answer, never from here.
      if (outcome.ok) {
        setState({ phase: "LOADING" });
        setApplied((previous) => previous + 1);
      }
      else setRefusal(outcome);
    }, () => {
      if (!mounted.current) return;
      pending.current = false;
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
      ) : !showDecision && presence === "ABSENT" ? (
        <NoPlanYet />
      ) : (
        <OutcomeView outcome={state.outcome} />
      )}
      {applied === 0 ? null : <AppliedLine state={state} />}
      {authorization.status === "AUTHORIZED" && !reviewReady && approval?.sentBack !== true ? <OutcomeNote
        code="PLAN_REVIEW_BODY_UNAVAILABLE" layer="CONTROL_ROOM_PLAN_REVIEW"
        said="A decision is available when this plan's complete, reviewable version is loaded."
        testId="cr.approve.review-unavailable" /> : null}
      {/* KEYED ON THE RUN so the gate's reason box cannot outlive the run it was typed
          for. Without this, rejecting run A and then being offered its successor B would
          return the controls with A's reason still in the box and Reject already enabled -
          one stray click away from sending B back for a reason nobody wrote about it. */}
      {showDecision ? <ApproveGate
        authorization={authorization}
        busy={busy || !reviewReady}
        key={runId}
        onApprove={(): void => { decide(null); }}
        onReject={(decisionReason): void => { decide(decisionReason); }}
        refusal={refusal}
        sentBack={approval?.sentBack ?? false}
      /> : null}
      <ActionButton onClick={onBack} testId="cr.approve.back" variant="secondary">
        {`${ARROW_LEFT} Back to goals`}
      </ActionButton>
    </section>
  );
}
