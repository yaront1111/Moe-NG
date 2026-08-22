import type { CSSProperties, JSX } from "react";

import { sayWho } from "../truth-class.js";
import type { ProofPayload } from "../shell/proof-context.js";
import { useProof } from "../shell/proof-context.js";

/**
 * The Cordum truth chip: a class rendered as glyph + short label + colour at once,
 * so no single channel carries the meaning alone. Clicking it opens the proof
 * inspector on the claim the chip rides beside.
 *
 * Interactive by default (a button that reaches the receipt). The chip legend
 * renders the non-interactive variant - a plain span with the same triple
 * encoding, but no proof affordance, because a legend entry names a class rather
 * than a claim.
 *
 * Test-id grammar matches the shell audit: `cr.chip.<class>` names the chip, with
 * `cr.glyph` and `cr.shortlabel` inside it, so selecting `cr.chip.*` counts chips.
 */

export interface TruthChipProps {
  readonly truthClass?: unknown;
  /** Prefixes the aria label when several chips need distinct names. */
  readonly contextLabel?: string | undefined;
  /** The receipt this chip opens; omitted for a legend entry. */
  readonly proof?: ProofPayload | undefined;
  /** Overrides the context opener, for tests and isolated mounts. */
  readonly onOpenProof?: ((payload: ProofPayload | null) => void) | undefined;
  /** A legend entry: same encoding, no proof affordance. */
  readonly interactive?: boolean | undefined;
  readonly compact?: boolean | undefined;
}

function toneStyle(toneVar: string, borderStyle: string): CSSProperties {
  // Both are consumed by cordum-shell.css; kept as vars so the tone travels as a
  // token rather than a literal colour baked into the element. Cast because these
  // are CSS custom properties, not named CSSProperties keys.
  return { "--chip-fill": `var(${toneVar})`, "--chip-border": borderStyle } as CSSProperties;
}

export function TruthChip({
  truthClass,
  contextLabel,
  proof,
  onOpenProof,
  interactive = true,
  compact = false,
}: TruthChipProps): JSX.Element {
  const shown = sayWho(truthClass);
  const meaning = shown.provenanceNote === ""
    ? shown.name
    : `${shown.name} ${shown.provenanceNote}`;
  const base = `${shown.truthClass} ${meaning}`;
  const ariaLabel = contextLabel === undefined ? base : `${contextLabel}. ${base}`;
  const testId = `cr.chip.${shown.truthClass.toLowerCase()}`;
  const style = toneStyle(shown.toneVar, shown.borderStyle);
  const glyph = <span aria-hidden="true" data-testid="cr.glyph">{shown.glyph}</span>;
  const short = <span data-testid="cr.shortlabel">{shown.shortLabel}</span>;

  if (!interactive) {
    return (
      <span
        aria-label={ariaLabel}
        className="cr2-chip"
        data-border={shown.borderStyle}
        data-compact={compact ? "true" : undefined}
        data-origin={shown.origin}
        data-testid={testId}
        data-truth-class={shown.truthClass}
        style={style}
      >
        {glyph}
        {short}
      </span>
    );
  }

  const opener = onOpenProof;
  return (
    <ProofButton
      ariaLabel={`${ariaLabel} press Enter for provenance.`}
      compact={compact}
      onOpen={opener}
      payload={proof ?? {
        factId: `chip.${shown.truthClass.toLowerCase()}`,
        label: contextLabel ?? shown.name,
        value: shown.shortLabel,
        truthClass,
        note: shown.provenanceNote === "" ? undefined : shown.provenanceNote,
      }}
      style={style}
      testId={testId}
      truthClass={shown.truthClass}
      origin={shown.origin}
      borderStyle={shown.borderStyle}
    >
      {glyph}
      {short}
    </ProofButton>
  );
}

interface ProofButtonProps {
  readonly ariaLabel: string;
  readonly borderStyle: string;
  readonly children: JSX.Element[];
  readonly compact: boolean;
  readonly onOpen?: ((payload: ProofPayload | null) => void) | undefined;
  readonly origin: string;
  readonly payload: ProofPayload;
  readonly style: CSSProperties;
  readonly testId: string;
  readonly truthClass: string;
}

function ProofButton(props: ProofButtonProps): JSX.Element {
  const context = useProof();
  const open = props.onOpen ?? context.openProof;
  return (
    <button
      aria-label={props.ariaLabel}
      className="cr2-chip"
      data-border={props.borderStyle}
      data-compact={props.compact ? "true" : undefined}
      data-origin={props.origin}
      data-testid={props.testId}
      data-truth-class={props.truthClass}
      onClick={() => open(props.payload)}
      style={props.style}
      type="button"
    >
      {props.children}
    </button>
  );
}
