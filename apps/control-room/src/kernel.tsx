import { describeTruthClass } from "@moe/control-room-model";
import type {
  TruthClass,
  TruthPresentationDescriptor,
} from "@moe/control-room-model";
import type { CSSProperties, JSX } from "react";

import { CONTROL_ROOM_FIXTURES } from "./fixtures.js";
import type { FixtureSurface } from "./fixtures.js";

export { describeTruthClass };
export type { TruthClass, TruthPresentationDescriptor };

/** How the payload supplied the class, decided before anything is rendered. */
export type TruthPresentationOrigin = "PRESENT" | "ABSENT" | "INVALID";

/** A payload that omits the class entirely; never defaulted upward. */
export const TRUTH_ABSENT_PROVENANCE = "class missing from payload";

/** A payload that supplied a class the daemon contract does not define. */
export const TRUTH_INVALID_PROVENANCE =
  "TRUTH_CLASS_INVALID: class present but not a daemon-supplied supported value";

export interface ShellTruthPresentation {
  readonly descriptor: TruthPresentationDescriptor;
  readonly origin: TruthPresentationOrigin;
  readonly provenanceNote: string;
}

function unknownDescriptor(): TruthPresentationDescriptor {
  const result = describeTruthClass("UNKNOWN");
  if (!result.ok) {
    throw new Error("control-room-model no longer describes the UNKNOWN truth class");
  }
  return result.descriptor;
}

const UNKNOWN_DESCRIPTOR = unknownDescriptor();

function presentation(
  descriptor: TruthPresentationDescriptor,
  origin: TruthPresentationOrigin,
  provenanceNote: string,
): ShellTruthPresentation {
  return Object.freeze({ descriptor, origin, provenanceNote });
}

/**
 * Adapts one payload-supplied truth class to the presentation kernel.
 *
 * The kernel answers a closed question — is this token one of the five supported
 * values — and this wrapper adds the one distinction the kernel deliberately does
 * not make: an ABSENT class and a malformed PRESENT class both render UNKNOWN, but
 * they carry different provenance notes so the two failures never look alike. The
 * truth mapping itself is never reimplemented here.
 */
export function presentTruthClass(input: unknown): ShellTruthPresentation {
  if (input === undefined || input === null) {
    return presentation(UNKNOWN_DESCRIPTOR, "ABSENT", TRUTH_ABSENT_PROVENANCE);
  }
  const result = describeTruthClass(input);
  if (!result.ok) {
    return presentation(UNKNOWN_DESCRIPTOR, "INVALID", TRUTH_INVALID_PROVENANCE);
  }
  return presentation(result.descriptor, "PRESENT", "");
}

export interface TruthChipProps {
  readonly onProvenance?: ((shown: ShellTruthPresentation) => void) | undefined;
  readonly truthClass?: unknown;
}

const CHIP_BASE: CSSProperties = {
  alignItems: "center",
  borderWidth: "1px",
  display: "inline-flex",
  gap: "0.25rem",
  minHeight: "24px",
  minWidth: "24px",
};

function chipStyle(descriptor: TruthPresentationDescriptor): CSSProperties {
  return { ...CHIP_BASE, borderStyle: descriptor.borderStyle };
}

/**
 * Triple-encodes one truth class as text, icon, and colour at once, so no single
 * channel carries the meaning alone. The button element supplies the keyboard and
 * pointer provenance affordance and the minimum hit target.
 *
 * As with `cr.fact.`, the `cr.chip.` prefix names the chip itself and nothing inside
 * it, so selecting `cr.chip.*` counts chips exactly. The inner parts are `cr.glyph`
 * and `cr.shortlabel`, which also avoids colliding with the wrapper's `cr.label`.
 */
export function TruthChip({ onProvenance, truthClass }: TruthChipProps): JSX.Element {
  const shown = presentTruthClass(truthClass);
  const { descriptor } = shown;
  const ariaLabel =
    shown.provenanceNote === ""
      ? descriptor.ariaLabel
      : `${descriptor.ariaLabel} ${shown.provenanceNote}`;
  return (
    <button
      aria-label={ariaLabel}
      data-border={descriptor.borderStyle}
      data-origin={shown.origin}
      data-provenance-note={shown.provenanceNote}
      data-testid={descriptor.chipTestId}
      data-tone={descriptor.semanticTone}
      data-truth-class={descriptor.truthClass}
      onClick={() => onProvenance?.(shown)}
      style={chipStyle(descriptor)}
      type="button"
    >
      <span aria-hidden="true" data-testid="cr.glyph">
        {descriptor.glyph}
      </span>
      <span data-testid="cr.shortlabel">{descriptor.shortLabel}</span>
    </button>
  );
}

export interface FactProps {
  readonly factId: string;
  readonly label: string;
  readonly onProvenance?: ((shown: ShellTruthPresentation) => void) | undefined;
  readonly truthClass?: unknown;
  readonly value: string;
}

/**
 * The only wrapper a fact claim may render through. A chip is a structural child
 * rather than a caller's responsibility, so a displayed fact cannot lose its class.
 *
 * The `cr.fact.` test-id prefix is reserved for the wrapper alone. Inner parts use
 * `cr.label` and `cr.value` so that selecting `cr.fact.*` counts fact claims exactly,
 * which is what the "every fact wrapper has a chip descendant" audit depends on.
 */
export function Fact({
  factId,
  label,
  onProvenance,
  truthClass,
  value,
}: FactProps): JSX.Element {
  return (
    <div data-testid={`cr.fact.${factId}`}>
      <span data-testid="cr.label">{label}</span>
      <span data-testid="cr.value">{value}</span>
      <TruthChip onProvenance={onProvenance} truthClass={truthClass} />
    </div>
  );
}

function SurfacePanel({ surface }: { readonly surface: FixtureSurface }): JSX.Element {
  return (
    <section data-testid={`cr.surface.${surface.surfaceId}`}>
      <h2>{surface.title}</h2>
      {surface.facts.map((fact) => (
        <Fact
          factId={fact.factId}
          key={fact.factId}
          label={fact.label}
          truthClass={fact.truthClass}
          value={fact.value}
        />
      ))}
    </section>
  );
}

/**
 * Placeholder application root: it proves the scaffold mounts and that the fact
 * wrapper invariant holds over real fixture data. The shell frame task replaces
 * this body; nothing here renders an action or constructs a command.
 */
export function ControlRoomScaffold(): JSX.Element {
  return (
    <main data-testid="cr.shell.root">
      <h1>Moe control room</h1>
      {CONTROL_ROOM_FIXTURES.surfaces.map((surface) => (
        <SurfacePanel key={surface.surfaceId} surface={surface} />
      ))}
    </main>
  );
}
