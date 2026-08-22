import type { CSSProperties, JSX, ReactNode } from "react";

import { sayWho } from "../truth-class.js";
import type { ProofPayload } from "../shell/proof-context.js";
import { TruthChip } from "./truth-chip.js";

/**
 * The small, reusable Cordum building blocks every later surface composes from.
 * Each paints only through tokens, and none of them invents a value: they render
 * exactly what a caller supplies, with the truth chip attached where a fact needs
 * its class.
 */

/* ------------------------------------------------------------------ StatusChip */

/**
 * A mono pill whose colour is a token, rendered as text-on-wash (not a filled
 * truth chip). Used for connection state, a goal's state, a nav badge, or a card
 * overlay. `toneVar` is a CSS custom-property NAME, so the colour stays a token.
 */
export interface StatusChipProps {
  readonly label: string;
  readonly toneVar?: string;
  readonly glyph?: string | undefined;
  readonly testId?: string | undefined;
  readonly title?: string | undefined;
}

export function StatusChip({
  label,
  toneVar = "--cr-ink-soft",
  glyph,
  testId,
  title,
}: StatusChipProps): JSX.Element {
  const style = { "--chip-tone": `var(${toneVar})` } as CSSProperties;
  return (
    <span className="cr2-statuschip" data-testid={testId} style={style} title={title}>
      {glyph === undefined ? null : <span aria-hidden="true">{glyph}</span>}
      <span>{label}</span>
    </span>
  );
}

/* ---------------------------------------------------------------- ActionButton */

export type ActionVariant = "primary" | "secondary" | "ghost";

export interface ActionButtonProps {
  readonly children: ReactNode;
  readonly onClick?: (() => void) | undefined;
  readonly disabled?: boolean | undefined;
  readonly variant?: ActionVariant;
  readonly title?: string | undefined;
  readonly ariaLabel?: string | undefined;
  readonly ariaPressed?: boolean | undefined;
  readonly testId?: string | undefined;
  readonly type?: "button" | "submit";
}

export function ActionButton({
  children,
  onClick,
  disabled = false,
  variant = "primary",
  title,
  ariaLabel,
  ariaPressed,
  testId,
  type = "button",
}: ActionButtonProps): JSX.Element {
  return (
    <button
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      className="cr2-btn"
      data-variant={variant}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      title={title}
      type={type}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------------ Card */

export interface CardProps {
  readonly children: ReactNode;
  readonly as?: "article" | "div" | "li";
  readonly interactive?: boolean | undefined;
  readonly tone?: "surface" | "wash";
  readonly testId?: string | undefined;
  readonly ariaLabel?: string | undefined;
  readonly tabIndex?: number | undefined;
}

export function Card({
  children,
  as = "div",
  interactive = false,
  tone = "surface",
  testId,
  ariaLabel,
  tabIndex,
}: CardProps): JSX.Element {
  const Tag = as;
  return (
    <Tag
      aria-label={ariaLabel}
      className="cr2-card"
      data-interactive={interactive ? "true" : undefined}
      data-testid={testId}
      data-tone={tone}
      tabIndex={tabIndex}
    >
      {children}
    </Tag>
  );
}

/* --------------------------------------------------------------------- FactRow */

/**
 * The one wrapper a fact claim renders through: a mono label, its value, and the
 * truth chip carrying the class the value was supplied with. The chip is a
 * structural child rather than a caller's responsibility, so a displayed fact
 * cannot lose its class. Grammar (`cr.fact.*` wrapper, `cr.label` / `cr.value`
 * inside) matches the shell's fact-has-a-chip audit.
 */
export interface FactRowProps {
  readonly factId: string;
  readonly label: string;
  readonly value: string;
  readonly truthClass?: unknown;
  readonly proof?: ProofPayload | undefined;
  readonly compact?: boolean | undefined;
}

export function FactRow({
  factId,
  label,
  value,
  truthClass,
  proof,
  compact = false,
}: FactRowProps): JSX.Element {
  const shown = sayWho(truthClass);
  const payload: ProofPayload = proof ?? {
    factId: `fact.${factId}`,
    label,
    value,
    truthClass,
    note: shown.provenanceNote === "" ? undefined : shown.provenanceNote,
  };
  return (
    <div className="cr2-factrow" data-compact={compact ? "true" : undefined} data-testid={`cr.fact.${factId}`}>
      <span className="cr2-factrow-label" data-testid="cr.label">{label}</span>
      <span className="cr2-factrow-value">
        <span data-testid="cr.value">{value}</span>
        <TruthChip compact={compact} contextLabel={label} proof={payload} truthClass={truthClass} />
      </span>
    </div>
  );
}
