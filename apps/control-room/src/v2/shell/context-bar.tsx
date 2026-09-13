import type { JSX } from "react";

import { ARROW_LEFT } from "../glyphs.js";
import "../styles/cordum-context-bar.css";

/** The current product or destination, its return path, and an inspectable proof drawer. */
const PROOF_ICON = "M4 5.5h16v13H4z M15.5 5.5v13 M8 9h3 M8 12h3";

export interface ContextBarProps {
  /** Preformatted eyebrow, e.g. "PROJECT . MOE-NG". */
  readonly eyebrow: string;
  readonly title: string;
  readonly proofOpen: boolean;
  readonly onToggleProof: () => void;
  /** When present, a "<- <backLabel>" link renders before the eyebrow. */
  readonly onBack?: (() => void) | undefined;
  readonly backLabel?: string | undefined;
}

export function ContextBar({
  eyebrow,
  title,
  proofOpen,
  onToggleProof,
  onBack,
  backLabel = "Products",
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
