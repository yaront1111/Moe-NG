import type { JSX } from "react";

import { OutcomeNote } from "../components/outcome-note.js";

/**
 * A PARTIAL ENUMERATION, STATED AS ONE. The deployed set is assembled from one goal read per
 * goal in the catalog, and those reads RESOLVE their refusals rather than throwing. So a sweep
 * where some goals answered and some did not produces a list that is real but not whole, and
 * rendering it as whole is how an operator concludes an environment they cannot see is not
 * deployed. This note is what stands between those two readings.
 */

/**
 * The refusing read's OWN code and layer travel verbatim - the browser is not the layer that
 * refused and must not appear to be - beside the counts that say how much is missing.
 */
export interface EnvironmentsGap {
  readonly code: string;
  readonly goalsFailed: number;
  readonly goalsTotal: number;
  readonly layer: string;
}

/** The sentence for a partial enumeration. It never claims the list is all there is. */
export function gapSaid(gap: EnvironmentsGap): string {
  return `${String(gap.goalsFailed)} of ${String(gap.goalsTotal)} goals could not be read, so this `
    + "list is incomplete: an environment deployed from one of them would not appear here.";
}

/** Rendered as an alert, not a status: a silently partial list is what this exists to prevent. */
export function GapNote({ gap }: { readonly gap: EnvironmentsGap }): JSX.Element {
  return (
    <OutcomeNote
      code={gap.code}
      layer={gap.layer}
      role="alert"
      said={gapSaid(gap)}
      testId="cr.environments.incomplete"
    />
  );
}
