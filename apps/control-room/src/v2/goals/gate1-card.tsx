import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";

import { ActionButton } from "../components/primitives.js";
import { MIDDOT } from "../glyphs.js";
import type {
  Gate1ApprovalOutcome, Gate1ApprovalPort, Gate1ClarificationView, Gate1PendingView,
  Gate1ReadOutcome,
} from "./gate1-approval.js";
import { Gate1ContractDossier } from "./gate1-contract-dossier.js";

/**
 * The GATE 1 card (approve the Product Contract): rendered above the plan
 * screen for a source-bound goal while a committed revision awaits the human's
 * approval and after the daemon authenticates it as the recorded current Gate 1
 * revision. A plain goal with no contract projection never sees it.
 *
 * The card renders whatever the pending read answered and dispatches only the
 * daemon-minted approval it was handed. SUCCESS RE-READS: an accepted approval
 * asks the same goal-bound route again and renders the authenticated CURRENT
 * revision and slot. It makes no claim that a planning compiler is active.
 * A refusal stays on screen with the code and layer that answered.
 */

export interface Gate1CardProps {
  readonly goalId: string;
  readonly port: Gate1ApprovalPort;
  readonly read: (goalId: string) => Promise<Gate1ReadOutcome>;
}

type LoadState =
  | { readonly goalGeneration: number; readonly goalId: string; readonly phase: "LOADING" }
  | { readonly goalGeneration: number; readonly goalId: string;
    readonly outcome: Gate1ReadOutcome; readonly phase: "LOADED" };

type DispatchRefusal = Extract<Gate1ApprovalOutcome, { ok: false }>;
interface DispatchState {
  readonly approvedOnce: boolean;
  readonly busy: boolean;
  readonly goalGeneration: number;
  readonly goalId: string;
  readonly refusal: DispatchRefusal | null;
}

function idleDispatch(goalId: string, goalGeneration: number): DispatchState {
  return { approvedOnce: false, busy: false, goalGeneration, goalId, refusal: null };
}

export function Gate1Card({ goalId, port, read }: Gate1CardProps): JSX.Element | null {
  const goalIdentity = useRef({ generation: 0, goalId, port, read });
  if (goalIdentity.current.goalId !== goalId || goalIdentity.current.port !== port
    || goalIdentity.current.read !== read) {
    goalIdentity.current = {
      generation: goalIdentity.current.generation + 1, goalId, port, read,
    };
  }
  const goalGeneration = goalIdentity.current.generation;
  const [state, setState] = useState<LoadState>({ goalGeneration, goalId, phase: "LOADING" });
  const [dispatch, setDispatch] = useState<DispatchState>(
    () => idleDispatch(goalId, goalGeneration),
  );
  const [applied, setApplied] = useState(0);
  const generation = useRef(0);
  const headingId = useId();

  const shownState: LoadState = state.goalGeneration === goalGeneration
    ? state : { goalGeneration, goalId, phase: "LOADING" };
  const shownDispatch = dispatch.goalGeneration === goalGeneration
    ? dispatch : idleDispatch(goalId, goalGeneration);
  const { approvedOnce, busy, refusal } = shownDispatch;

  useEffect(() => {
    const run = generation.current + 1;
    generation.current = run;
    setState({ goalGeneration, goalId, phase: "LOADING" });
    void Promise.resolve().then(() => read(goalId)).then((outcome) => {
      if (generation.current === run && goalIdentity.current.generation === goalGeneration) {
        setState({ goalGeneration, goalId, outcome, phase: "LOADED" });
      }
    }, () => {
      if (generation.current === run && goalIdentity.current.generation === goalGeneration) {
        setState({
          goalGeneration,
          goalId,
          outcome: { code: "GATE1_READ_FAILED", layer: "CONTROL_ROOM_GATE1", status: "ERROR" },
          phase: "LOADED",
        });
      }
    });
    return (): void => { generation.current += 1; };
  }, [applied, goalGeneration, goalId, read]);

  const onAnswer = useCallback((
    clarification: Gate1ClarificationView, optionId: string,
  ) => {
    if (busy) return;
    const dispatchGoal = goalId;
    const run = generation.current;
    setDispatch({ approvedOnce, busy: true, goalGeneration, goalId: dispatchGoal, refusal: null });
    void Promise.resolve().then(() => port.answer(clarification, optionId)).then((outcome) => {
      if (goalIdentity.current.generation !== goalGeneration || generation.current !== run) return;
      // An accepted answer re-reads: the daemon decides whether the fence lifted.
      if (outcome.ok) {
        setDispatch({ approvedOnce, busy: false, goalGeneration, goalId: dispatchGoal, refusal: null });
        setApplied((previous) => previous + 1);
      } else {
        setDispatch({ approvedOnce, busy: false, goalGeneration, goalId: dispatchGoal, refusal: outcome });
      }
    }, () => {
      if (goalIdentity.current.generation !== goalGeneration || generation.current !== run) return;
      setDispatch({
        approvedOnce,
        busy: false,
        goalGeneration,
        goalId: dispatchGoal,
        refusal: { code: "GATE1_DISPATCH_FAILED", layer: "CONTROL_ROOM_GATE1", ok: false },
      });
    });
  }, [approvedOnce, busy, goalGeneration, goalId, port]);

  const onApprove = useCallback((pending: Gate1PendingView) => {
    if (busy) return;
    const dispatchGoal = goalId;
    const run = generation.current;
    setDispatch({ approvedOnce, busy: true, goalGeneration, goalId: dispatchGoal, refusal: null });
    void Promise.resolve().then(() => port.submit(pending)).then((outcome) => {
      if (goalIdentity.current.generation !== goalGeneration || generation.current !== run) return;
      if (outcome.ok) {
        setDispatch({
          approvedOnce: true, busy: false, goalGeneration, goalId: dispatchGoal, refusal: null,
        });
        setApplied((previous) => previous + 1);
      } else {
        setDispatch({ approvedOnce, busy: false, goalGeneration, goalId: dispatchGoal, refusal: outcome });
      }
    }, () => {
      if (goalIdentity.current.generation !== goalGeneration || generation.current !== run) return;
      setDispatch({
        approvedOnce,
        busy: false,
        goalGeneration,
        goalId: dispatchGoal,
        refusal: { code: "GATE1_DISPATCH_FAILED", layer: "CONTROL_ROOM_GATE1", ok: false },
      });
    });
  }, [approvedOnce, busy, goalGeneration, goalId, port]);

  if (shownState.phase === "LOADED" && shownState.outcome.status === "NONE" && !approvedOnce) {
    // Nothing pending and nothing just approved: a plain goal shows no card.
    return null;
  }

  return (
    <section
      aria-busy={shownState.phase === "LOADING" || busy}
      aria-labelledby={headingId}
      className="cr2-approve"
      data-testid="cr.gate1.card"
    >
      <h2 className="cr2-slot-kicker" id={headingId}>
        {`PRODUCT CONTRACT ${MIDDOT} GATE 1 ${MIDDOT} ${goalId}`}
      </h2>
      {shownState.phase === "LOADING" ? (
        <p className="cr2-slot-kicker" data-testid="cr.gate1.loading" role="status">
          Reading the contract...
        </p>
      ) : shownState.outcome.status === "PENDING" ? (
        <>
          <p className="cr2-approve-banner" data-reviewable="true" data-testid="cr.gate1.banner">
            {shownState.outcome.approval === null
              ? shownState.outcome.clarifications.length > 0
                ? "The planning agent needs a product decision before this contract can be"
                  + " approved. Pick an answer below."
                : "The product decision is recorded. Approval remains withheld while the"
                  + " daemon advances the contract fence."
              : "The planning agent proposed this Product Contract from your PRD. Approving it"
                + " records this revision as the daemon's current Gate 1 contract."}
          </p>
          <Gate1ContractDossier revision={shownState.outcome.revision} />
          {shownState.outcome.clarifications.map((row) => (
            <section
              className="cr2-approve-block"
              data-testid={`cr.gate1.question.${row.clarificationId}`}
              key={row.clarificationId}
            >
              <h3 className="cr2-approve-heading">{`QUESTION ${MIDDOT} ${row.question}`}</h3>
              {row.options.map((option) => (
                <ActionButton
                  disabled={busy}
                  key={option.optionId}
                  onClick={(): void => {
                    if (shownState.outcome.status === "PENDING") {
                      onAnswer(row, option.optionId);
                    }
                  }}
                  testId={`cr.gate1.answer.${row.clarificationId}.${option.optionId}`}
                  variant="secondary"
                >
                  {option.label}
                </ActionButton>
              ))}
            </section>
          ))}
          {shownState.outcome.approval === null ? null : (
            <ActionButton
              disabled={busy}
              onClick={(): void => {
                if (shownState.outcome.status === "PENDING") onApprove(shownState.outcome);
              }}
              testId="cr.gate1.approve"
            >
              {busy ? "Approving..." : "Approve contract"}
            </ActionButton>
          )}
        </>
      ) : shownState.outcome.status === "CURRENT" ? (
        <>
          <p className="cr2-approve-banner" data-testid="cr.gate1.current" role="status">
            {`Contract approved ${MIDDOT} this revision was reported current at the last read.`}
          </p>
          <Gate1ContractDossier revision={shownState.outcome.revision} />
          <section className="cr2-approve-block" data-testid="cr.gate1.current-slot">
            <h3 className="cr2-approve-heading">CURRENT SLOT PROVENANCE</h3>
            <dl className="cr2-approve-hashes">
              <dt>project</dt>
              <dd className="cr2-approve-mono">{shownState.outcome.slot.projectId}</dd>
              <dt>generation</dt>
              <dd className="cr2-approve-mono">{shownState.outcome.slot.generation}</dd>
              <dt>slot digest</dt>
              <dd className="cr2-approve-mono">{shownState.outcome.slot.slotDigest}</dd>
              <dt>current revision</dt>
              <dd className="cr2-approve-mono">
                {shownState.outcome.slot.currentRevision.revisionId}
              </dd>
              <dt>history revisions</dt>
              <dd className="cr2-approve-mono">
                {shownState.outcome.slot.revisionHistory.length}
              </dd>
            </dl>
          </section>
          <ActionButton
            onClick={(): void => { setApplied((previous) => previous + 1); }}
            testId="cr.gate1.refresh-current"
            variant="secondary"
          >
            Refresh current status
          </ActionButton>
        </>
      ) : shownState.outcome.status === "NONE" ? (
        <p className="cr2-approve-banner" data-testid="cr.gate1.approved" role="status">
          {`Contract approval accepted ${MIDDOT} no current contract projection was returned.`}
        </p>
      ) : (
        <p className="cr2-approve-refusal" data-testid="cr.gate1.refusal" role="alert">
          {`${shownState.outcome.status} ${MIDDOT} ${shownState.outcome.code} ${MIDDOT} ${shownState.outcome.layer}`}
        </p>
      )}
      {refusal === null ? null : (
        <p className="cr2-approve-refusal" data-testid="cr.gate1.dispatchrefusal" role="alert">
          {`REFUSED ${MIDDOT} ${refusal.code} ${MIDDOT} ${refusal.layer}`}
        </p>
      )}
    </section>
  );
}
