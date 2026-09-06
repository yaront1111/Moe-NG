import { useState } from "react";
import type { JSX } from "react";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { ReleaseCriterionView, ReleaseEvidenceView } from "../../live/live-release.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { ActionButton } from "../components/primitives.js";
import { MIDDOT } from "../glyphs.js";
import { writeFailedSaid } from "../outcome-words.js";
import type { OfferOutcome } from "../approvals/offer-wire.js";
import type { ReleasePort } from "./release-port.js";

/**
 * THE RELEASE CARD on an opened goal: Gate 3 asks a person whether the evidence is strong
 * enough to expose this work to users, so the card exists to make that answer INFORMED.
 *
 * THE UNKNOWN COUNT IS NEVER FOLDED INTO COVERED. A criterion whose citation could not be
 * re-measured carries gaps; it is NOT covered and it is NOT simply missing. A summary that
 * printed one number would let an operator approve a release believing evidence that was
 * never measured -- the worst thing this screen could do. Covered and UNKNOWN are counted
 * from the same rows, printed side by side, and every gap is listed underneath with the
 * criterion it belongs to and the reason the daemon gave.
 *
 * With no offer and no receipt the card renders NOTHING at all. The daemon withholds
 * `release.decide` until a commit has landed, and a control that dispatches into a refusal
 * is worse than an honest explanation.
 */

export interface GoalReleaseProps {
  /** The daemon evidence read, or null while it has not answered for this goal. */
  readonly evidence: ReleaseEvidenceView | null;
  readonly frame: SurfaceFrame | null;
  readonly goalId: string;
  readonly port: ReleasePort | null;
}

/** The daemon's release.decide offer for this goal, matched by kind AND target, from the
 *  surface it stated. The target is the release aggregate the daemon mints beside the goal
 *  (`releaseDossierAggregateId`), and `release-decide-command.ts` refuses any other. */
export function releaseOffer(
  frame: SurfaceFrame | null, goalId: string,
): Record<string, unknown> | null {
  if (frame === null || frame.outcome !== "SURFACE") return null;
  const offer = frame.offers.find((row) =>
    row["commandKind"] === "release.decide" && row["targetAggregateId"] === `release:${goalId}`);
  return offer ?? null;
}

export interface EvidenceSummary {
  readonly covered: number;
  readonly total: number;
  readonly unknown: number;
}

/** ONE derivation of both numbers, from the rows themselves. Covered plus unknown is always
 *  the total: a criterion is covered when it carries no gap, and UNKNOWN when it carries any. */
export function evidenceSummary(criteria: readonly ReleaseCriterionView[]): EvidenceSummary {
  const covered = criteria.filter((row) => row.gaps.length === 0).length;
  return { covered, total: criteria.length, unknown: criteria.length - covered };
}

function receiptLine(evidence: ReleaseEvidenceView | null): string | null {
  const receipt = evidence?.receipt ?? null;
  if (receipt === null) return null;
  const anchor = `${MIDDOT} dossier ${receipt.dossierSha256.slice(0, 12)} ${MIDDOT} receipt ${receipt.receiptId.slice(0, 12)}`;
  return receipt.outcome === "RELEASED"
    ? `Released at ${receipt.sha.slice(0, 10)} ${anchor}`
    : `Release refused at ${receipt.sha.slice(0, 10)} ${anchor}`;
}

function previewLine(evidence: ReleaseEvidenceView | null): string {
  const preview = evidence?.preview ?? null;
  if (preview === null) return "No preview decision was recorded for this goal.";
  return `Preview ${preview.outcome} on ${preview.decidedAt}`;
}

export function GoalRelease({ evidence, frame, goalId, port }: GoalReleaseProps): JSX.Element | null {
  const [base, setBase] = useState("main");
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<OfferOutcome | null>(null);
  const offer = releaseOffer(frame, goalId);
  const receipt = evidence?.receipt ?? null;
  // No offer and no receipt: there is no decision to take and none was taken. Nothing renders.
  if (offer === null && receipt === null) return null;
  const criteria = evidence?.criteria ?? [];
  const summary = evidenceSummary(criteria);
  const gaps = criteria.flatMap((row) => row.gaps);
  const sha = evidence?.sha ?? null;
  const trimmed = base.trim();
  const canApprove = offer !== null && port !== null && !busy && sha !== null && trimmed !== "";
  const decide = (): void => {
    if (offer === null || port === null || sha === null) return;
    setBusy(true);
    setArmed(false);
    void port.submit(offer, { base: trimmed, decision: "APPROVE", goalId, sha }).then((outcome) => {
      setAnswer(outcome);
      setBusy(false);
    }, () => {
      setAnswer({ code: "RELEASE_DISPATCH_FAILED", layer: "CONTROL_ROOM_RELEASE", ok: false });
      setBusy(false);
    });
  };
  return (
    <section className="cr2-ops-panel" data-testid="cr.release.root">
      <h3 className="cr2-approve-heading">{`RELEASE ${MIDDOT} YOUR DECISION`}</h3>
      <p className="cr2-needs-detail" data-testid="cr.release.covered">
        {`Criteria covered ${String(summary.covered)} of ${String(summary.total)}`}
      </p>
      {summary.unknown === 0 ? null : (
        <p className="cr2-needs-detail" data-testid="cr.release.unknown">
          {`UNKNOWN ${String(summary.unknown)} of ${String(summary.total)}`
            + ` ${MIDDOT} evidence for these criteria could not be re-measured.`
            + " Approving releases them unverified."}
        </p>
      )}
      {evidence !== null && !evidence.ancestryMeasured ? (
        <p className="cr2-needs-detail" data-testid="cr.release.unmeasured">
          No workspace re-measured the landings, so every landing below reads UNKNOWN for that
          reason rather than because the work is missing.
        </p>
      ) : null}
      <p className="cr2-needs-detail" data-testid="cr.release.sha">
        {sha === null
          ? "Nothing is published yet, so there is no sha to release."
          : `Evidence measured at ${sha.slice(0, 10)}`}
      </p>
      {criteria.length === 0 ? null : (
        <ul className="cr2-approve-obligations" data-testid="cr.release.criteria">
          {criteria.map((row) => (
            <li className="cr2-coverage-section" key={row.criterionId}>
              <span className="cr2-approve-step-body">{`${row.criterionId} ${MIDDOT} ${row.title}`}</span>
              <span className="cr2-approve-mono">
                {`receipt ${row.receiptSha} ${MIDDOT} landing ${row.landing} ${MIDDOT} exit ${row.exitCode}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {gaps.length === 0 ? null : (
        <ul className="cr2-approve-obligations" data-testid="cr.release.gaps">
          {gaps.map((gap) => (
            <li className="cr2-coverage-section" key={`${gap.criterionId}:${gap.code}`}>
              <span className="cr2-approve-mono">{`${gap.criterionId} ${MIDDOT} ${gap.code}`}</span>
              <span className="cr2-approve-step-body">{gap.detail}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="cr2-needs-detail" data-testid="cr.release.preview">{previewLine(evidence)}</p>
      {receipt === null ? null : (
        <p className="cr2-needs-detail" data-testid="cr.release.receipt">{receiptLine(evidence)}</p>
      )}
      {receipt?.prUrl == null ? null : (
        <a className="cr2-link" data-testid="cr.release.link" href={receipt.prUrl} rel="noreferrer" target="_blank">
          {receipt.prUrl}
        </a>
      )}
      {receipt?.refusalCode == null ? null : (
        <p className="cr2-approve-mono" data-testid="cr.release.refusal-code">{receipt.refusalCode}</p>
      )}
      {offer === null ? null : (
        <div className="cr2-needs-action">
          <label className="cr2-field-label" htmlFor={`cr-release-base-${goalId}`}>Pull request base branch</label>
          <input
            className="cr2-input"
            data-testid="cr.release.base"
            disabled={busy}
            id={`cr-release-base-${goalId}`}
            onChange={(event): void => { setBase(event.target.value); setArmed(false); }}
            value={base}
          />
          <ActionButton
            ariaLabel="Approve this release and open its pull request"
            disabled={!canApprove}
            onClick={(): void => { if (!armed) { setArmed(true); setAnswer(null); return; } decide(); }}
            testId="cr.release.button"
          >
            {busy ? "Recording your decision..."
              : armed
                ? `Confirm: release ${String(summary.covered)} covered, ${String(summary.unknown)} UNKNOWN`
                : "Approve the release"}
          </ActionButton>
          {armed && !busy ? (
            <ActionButton onClick={(): void => setArmed(false)} testId="cr.release.cancel" variant="secondary">
              Not yet
            </ActionButton>
          ) : null}
        </div>
      )}
      {answer === null ? null : answer.ok ? (
        <p aria-live="polite" className="cr2-needs-note" data-testid="cr.release.answer" role="status">
          Recorded. The pull request link appears here once the daemon has opened it.
        </p>
      ) : (
        <>
          <OutcomeNote code={answer.code} layer={answer.layer} said={writeFailedSaid()} testId="cr.release.answer" />
          {answer.detail === undefined ? null : (
            <p className="cr2-approve-mono" data-testid="cr.release.answer-detail">{answer.detail}</p>
          )}
        </>
      )}
    </section>
  );
}
