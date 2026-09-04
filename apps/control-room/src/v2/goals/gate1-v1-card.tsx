import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { ActionButton } from "../components/primitives.js";
import { MIDDOT } from "../glyphs.js";
import type {
  Gate1ApprovalOutcomeV1, Gate1ApprovalPortV1, Gate1ClarificationViewV1, Gate1PendingViewV1,
  Gate1ReadOutcomeV1,
} from "./gate1-v1-approval.js";
import { refusalWords } from "../components/refusal-words.js";

/**
 * The GATE 1 card on the V1 plane (approve the Product Contract): rendered above the plan
 * screen for a source-bound goal while a committed revision awaits the human's
 * approval, absent otherwise — a plain goal never sees it.
 *
 * The card renders whatever the pending read answered and dispatches only the
 * daemon-minted approval it was handed. SUCCESS RE-READS: an accepted approval
 * asks the route again and renders the answer (normally NONE — the card
 * retires itself and the offer ladder flips the goal to the dispatcher).
 * A refusal stays on screen with the code and layer that answered.
 */

export interface Gate1CardV1Props {
  readonly goalId: string;
  readonly port: Gate1ApprovalPortV1;
  readonly read: (goalId: string) => Promise<Gate1ReadOutcomeV1>;
}

type LoadState =
  | { readonly phase: "LOADING" }
  | { readonly outcome: Gate1ReadOutcomeV1; readonly phase: "LOADED" };

type DispatchRefusal = Extract<Gate1ApprovalOutcomeV1, { ok: false }>;

function PendingBody({ pending }: { readonly pending: Gate1PendingViewV1 }): JSX.Element {
  return (
    <div className="cr2-approve-body" data-testid="cr.gate1.pending">
      <section className="cr2-approve-block" data-testid="cr.gate1.requirements">
        <h3 className="cr2-approve-heading">
          {`REQUIREMENTS ${MIDDOT} ${pending.requirements.length}`}
        </h3>
        <ul className="cr2-approve-obligations">
          {pending.requirements.map((requirement) => (
            <li
              className="cr2-approve-obligation"
              data-testid={`cr.gate1.requirement.${requirement.requirementId}`}
              key={requirement.requirementId}
            >
              <span className="cr2-approve-mono">{requirement.requirementId}</span>
              <span className="cr2-approve-step-body">{requirement.statement}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="cr2-approve-block" data-testid="cr.gate1.criteria">
        <h3 className="cr2-approve-heading">
          {`ACCEPTANCE CRITERIA ${MIDDOT} ${pending.criteria.length}`}
        </h3>
        <ul className="cr2-approve-obligations">
          {pending.criteria.map((criterion) => (
            <li
              className="cr2-approve-obligation"
              data-testid={`cr.gate1.criterion.${criterion.criterionId}`}
              key={criterion.criterionId}
            >
              <span className="cr2-approve-mono">{criterion.criterionId}</span>
              <span className="cr2-approve-step-body">{criterion.statement}</span>
            </li>
          ))}
        </ul>
      </section>
      <details className="cr2-approve-inspect" data-testid="cr.gate1.inspect">
        <summary className="cr2-approve-inspect-summary">Inspect revision</summary>
        <dl className="cr2-approve-hashes">
          <dt>contractId</dt>
          <dd className="cr2-approve-mono">{pending.contractId}</dd>
          <dt>revisionId</dt>
          <dd className="cr2-approve-mono">{pending.revisionId}</dd>
          <dt>revisionDigest</dt>
          <dd className="cr2-approve-mono">{pending.revisionDigest}</dd>
        </dl>
      </details>
    </div>
  );
}

export function Gate1CardV1({ goalId, port, read }: Gate1CardV1Props): JSX.Element | null {
  const [state, setState] = useState<LoadState>({ phase: "LOADING" });
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<DispatchRefusal | null>(null);
  const [approvedOnce, setApprovedOnce] = useState(false);
  const [applied, setApplied] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const run = generation.current + 1;
    generation.current = run;
    setState({ phase: "LOADING" });
    void read(goalId).then((outcome) => {
      if (generation.current === run) setState({ outcome, phase: "LOADED" });
    });
    return (): void => { generation.current += 1; };
  }, [applied, goalId, read]);

  const onAnswer = useCallback((
    clarification: Gate1ClarificationViewV1, optionId: string, contractId: string,
  ) => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    void port.answer(clarification, optionId, contractId).then((outcome) => {
      setBusy(false);
      // An accepted answer re-reads: the daemon decides whether the fence lifted.
      if (outcome.ok) setApplied((previous) => previous + 1);
      else setRefusal(outcome);
    }, () => {
      setBusy(false);
      setRefusal({ code: "GATE1_DISPATCH_FAILED", layer: "CONTROL_ROOM_GATE1", ok: false });
    });
  }, [busy, port]);

  const onApprove = useCallback((pending: Gate1PendingViewV1) => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    void port.submit(pending).then((outcome) => {
      setBusy(false);
      if (outcome.ok) {
        setApprovedOnce(true);
        setApplied((previous) => previous + 1);
      } else {
        setRefusal(outcome);
      }
    }, () => {
      setBusy(false);
      setRefusal({ code: "GATE1_DISPATCH_FAILED", layer: "CONTROL_ROOM_GATE1", ok: false });
    });
  }, [busy, port]);

  if (state.phase === "LOADED" && state.outcome.status === "NONE" && !approvedOnce) {
    // Nothing pending and nothing just approved: a plain goal shows no card.
    return null;
  }

  return (
    <section className="cr2-approve" data-testid="cr.gate1.card">
      <p className="cr2-slot-kicker">{`PRODUCT CONTRACT ${MIDDOT} GATE 1 ${MIDDOT} ${goalId}`}</p>
      {state.phase === "LOADING" ? (
        <p className="cr2-slot-kicker" data-testid="cr.gate1.loading">Reading the contract...</p>
      ) : state.outcome.status === "PENDING" ? (
        <>
          <p className="cr2-approve-banner" data-reviewable="true" data-testid="cr.gate1.banner">
            {state.outcome.approval === null
              ? "The planning agent needs a product decision before this contract can be"
                + " approved. Pick an answer below."
              : "The planning agent proposed this Product Contract from your PRD. Approving it"
                + " lets the daemon compile the plan."}
          </p>
          <PendingBody pending={state.outcome} />
          {state.outcome.clarifications.filter((row) => !row.answered).map((row) => (
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
                    if (state.outcome.status === "PENDING") {
                      onAnswer(row, option.optionId, state.outcome.contractId);
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
          {state.outcome.approval === null ? null : (
            <ActionButton
              disabled={busy}
              onClick={(): void => {
                if (state.outcome.status === "PENDING") onApprove(state.outcome);
              }}
              testId="cr.gate1.approve"
            >
              {busy ? "Approving..." : "Approve contract"}
            </ActionButton>
          )}
        </>
      ) : state.outcome.status === "NONE" ? (
        <p className="cr2-approve-banner" data-testid="cr.gate1.approved">
          {`Contract approved ${MIDDOT} the daemon now compiles the plan from it.`}
        </p>
      ) : (
        <p className="cr2-approve-refusal" data-testid="cr.gate1.refusal">
          {refusalWords(state.outcome)}
        </p>
      )}
      {refusal === null ? null : (
        <p className="cr2-approve-refusal" data-testid="cr.gate1.dispatchrefusal">
          {refusalWords(refusal)}
        </p>
      )}
    </section>
  );
}
