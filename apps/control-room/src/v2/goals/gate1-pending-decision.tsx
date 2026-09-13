import type { ProductContractRevisionV2 } from "@moe/core";
import type { JSX } from "react";

import { ActionButton } from "../components/primitives.js";
import { MIDDOT } from "../glyphs.js";
import type { Gate1ClarificationView, Gate1PendingView } from "./gate1-approval.js";

/**
 * THE DECISION on a pending V2 revision: the banner naming what is asked, the open
 * questions, then one decision row - the totals and Approve - all of it BEFORE the dossier
 * gate1-card.tsx mounts under it. Measured on the V1 card 2026-09-13, Approve sat below 278
 * statement rows; the V2 card had the control after its dossier too, and no totals row at
 * all, so a reviewer could not size the contract without opening its sections. Split out
 * of gate1-card.tsx the way gate1-v1-rosters.tsx was, to keep the card under 250 lines.
 */

/** The six requirement sections of the revision as one figure, beside its criteria. */
export function revisionTotals(
  revision: ProductContractRevisionV2,
): Readonly<{ criteria: number; requirements: number }> {
  const requirements = revision.functionalRequirements.length
    + revision.nonFunctionalRequirements.length
    + revision.securityPrivacyRequirements.length
    + revision.technologyRequirements.length
    + revision.uxAccessibilityRequirements.length
    + revision.deploymentRequirements.length;
  return { criteria: revision.criteria.length, requirements };
}

export interface Gate1PendingDecisionProps {
  readonly busy: boolean;
  readonly onAnswer: (clarification: Gate1ClarificationView, optionId: string) => void;
  readonly onApprove: (pending: Gate1PendingView) => void;
  readonly pending: Gate1PendingView;
}

export function Gate1PendingDecision(
  { busy, onAnswer, onApprove, pending }: Gate1PendingDecisionProps,
): JSX.Element {
  const totals = revisionTotals(pending.revision);
  return (
    <>
      <p className="cr2-approve-banner" data-reviewable="true" data-testid="cr.gate1.banner">
        {pending.approval === null
          ? pending.clarifications.length > 0
            ? "The planning agent needs a product decision before this contract can be"
              + " approved. Pick an answer below."
            : "The product decision is recorded. Approval remains withheld while the"
              + " daemon advances the contract fence."
          : "The planning agent proposed this Product Contract from your PRD. Approving it"
            + " records this revision as the daemon's current Gate 1 contract."}
      </p>
      {pending.clarifications.map((row) => (
        <section
          className="cr2-approve-block"
          data-testid={`cr.gate1.question.${row.clarificationId}`}
          key={row.clarificationId}
        >
          <h3 className="cr2-approve-heading">{row.question}</h3>
          {row.options.map((option) => (
            <ActionButton
              disabled={busy}
              key={option.optionId}
              onClick={(): void => { onAnswer(row, option.optionId); }}
              testId={`cr.gate1.answer.${row.clarificationId}.${option.optionId}`}
              variant="secondary"
            >
              {option.label}
            </ActionButton>
          ))}
        </section>
      ))}
      <div className="cr2-approve-decision" data-testid="cr.gate1.decision">
        <p className="cr2-approve-heading" data-testid="cr.gate1.totals">
          {`${String(totals.requirements)} requirements ${MIDDOT} `
            + `${String(totals.criteria)} acceptance criteria`}
        </p>
        {pending.approval === null ? null : (
          <ActionButton
            disabled={busy}
            onClick={(): void => { onApprove(pending); }}
            testId="cr.gate1.approve"
          >
            {busy ? "Approving..." : "Approve contract"}
          </ActionButton>
        )}
      </div>
    </>
  );
}
