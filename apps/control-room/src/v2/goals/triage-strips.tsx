import type { CSSProperties, JSX } from "react";

// The goals-surface layout corrections live in one sheet beside the card; the
// strip's width ceiling (goalshome-08) is in there, so the strips import it too.
import "./goal-card.css";
import type { TriageStrip, TriageTone } from "./goal-model.js";

/**
 * The triage strips across the top of the goals home: "what needs you now",
 * derived from the live surface (ready-with-no-claim, blocked, claimed) or, in
 * fixtures mode, the designed three. Each strip is a button; selecting one that
 * names a goal opens that goal's board.
 *
 * The live surface often yields ONE strip, which the designed `flex: 1 1 240px`
 * would stretch across the whole content width; `goal-card.css` caps it.
 */

const TONE_VAR: Readonly<Record<TriageTone, string>> = Object.freeze({
  info: "--cr-truth-human-deep",
  danger: "--cr-danger",
  agent: "--cr-truth-agent",
  accent: "--cr-accent-text",
  verified: "--cr-truth-verified",
});

export interface TriageStripsProps {
  readonly strips: readonly TriageStrip[];
  readonly onSelect: (strip: TriageStrip) => void;
}

export function TriageStrips({ strips, onSelect }: TriageStripsProps): JSX.Element | null {
  if (strips.length === 0) return null;
  return (
    <div className="cr2-triage" data-testid="cr.goals.triage">
      {strips.map((strip) => {
        const style = { "--triage-tone": `var(${TONE_VAR[strip.tone]})` } as CSSProperties;
        return (
          <button
            className="cr2-triage-card"
            data-testid={`cr.goals.triage.${strip.id}`}
            key={strip.id}
            onClick={() => onSelect(strip)}
            style={style}
            type="button"
          >
            <span className="cr2-triage-count">{strip.count}</span>
            <span className="cr2-triage-text">
              <span className="cr2-triage-label">{strip.label}</span>
              <span className="cr2-triage-sub">{strip.sub}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
