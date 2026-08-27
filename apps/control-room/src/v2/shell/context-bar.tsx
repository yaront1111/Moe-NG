import type { JSX } from "react";

import { StatusChip } from "../components/primitives.js";
import { ARROW_LEFT } from "../glyphs.js";
import "../styles/cordum-context-bar.css";
import { CARD_TREATMENTS } from "./shell-model.js";
import type { CardTreatment } from "./shell-model.js";

/**
 * The top context bar: the breadcrumb + screen title on the left, and on the
 * right the board card-treatment switch (Compact / Instrument / Ledger) and the
 * Proof button that toggles the receipt inspector.
 *
 * The treatment group is FROZEN and marked SOON. The shell holds the choice and
 * writes it to the root as `data-treatment`, but no surface in this build reads
 * that attribute, so pressing a pill would change nothing anywhere. An affordance
 * that cannot act is not offered as live: it wears the same SOON chip the nav
 * rail gives its unbuilt destinations. The pressed state still shows which
 * treatment the shell holds, so the group reports rather than pretends.
 */

const FROZEN_TITLE = "Not available in this build";

const PROOF_ICON = "M4 5.5h16v13H4z M15.5 5.5v13 M8 9h3 M8 12h3";

export interface ContextBarProps {
  /** Preformatted eyebrow, e.g. "PROJECT . MOE-NG". */
  readonly eyebrow: string;
  readonly title: string;
  readonly treatment: CardTreatment;
  readonly onTreatment: (treatment: CardTreatment) => void;
  readonly proofOpen: boolean;
  readonly onToggleProof: () => void;
  /** When present, a "<- <backLabel>" link renders before the eyebrow. */
  readonly onBack?: (() => void) | undefined;
  readonly backLabel?: string | undefined;
}

export function ContextBar({
  eyebrow,
  title,
  treatment,
  onTreatment,
  proofOpen,
  onToggleProof,
  onBack,
  backLabel = "GOALS",
}: ContextBarProps): JSX.Element {
  return (
    <header className="cr2-contextbar" data-testid="cr.shell.contextbar">
      <div className="cr2-context-lead">
        <div className="cr2-eyebrow" data-testid="cr.shell.context.eyebrow">
          {onBack === undefined ? null : (
            <button className="cr2-crumb-back" onClick={onBack} type="button">
              <span aria-hidden="true">{ARROW_LEFT}</span> {backLabel}
            </button>
          )}
          <span>{eyebrow}</span>
        </div>
        <strong className="cr2-context-title" data-testid="cr.shell.context.title">{title}</strong>
      </div>

      <div className="cr2-context-controls">
        <div className="cr2-treatment">
          <span className="cr2-treatment-label">CARDS</span>
          <StatusChip
            label="SOON"
            testId="cr.shell.treatment.unavailable"
            title="No board surface reads the card treatment yet, so these do nothing."
            toneVar="--cr-ink-soft"
          />
          <div aria-label="Board card treatment" className="cr2-pillgroup" role="group">
            {CARD_TREATMENTS.map((option) => {
              const active = option === treatment;
              return (
                <button
                  aria-disabled="true"
                  aria-label={`${option} card treatment - not available yet`}
                  aria-pressed={active}
                  className="cr2-pill"
                  data-active={active ? "true" : undefined}
                  data-testid={`cr.shell.treatment.${option.toLowerCase()}`}
                  disabled
                  key={option}
                  onClick={() => onTreatment(option)}
                  title={FROZEN_TITLE}
                  type="button"
                >
                  {option}
                </button>
              );
            })}
          </div>
        </div>

        <button
          aria-pressed={proofOpen}
          className="cr2-proof-toggle"
          data-active={proofOpen ? "true" : undefined}
          data-testid="cr.shell.proof.toggle"
          onClick={onToggleProof}
          title="Proof inspector - provenance for any claim"
          type="button"
        >
          <svg aria-hidden="true" className="cr2-proof-icon" fill="none" viewBox="0 0 24 24">
            <path
              d={PROOF_ICON}
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.6}
            />
          </svg>
          <span>Proof</span>
        </button>
      </div>
    </header>
  );
}
