import { useMemo, useState } from "react";
import type { JSX } from "react";

import type { ProvenanceHandler } from "../nodes/node-authority.js";
import { TIMELINE_FILTER_FIELDS, describeCursor } from "./timeline-contract.js";
import type {
  TimelineCursorState,
  TimelineFilterField,
  TimelineRefused,
  TimelineRow,
  TimelineTruncation,
} from "./timeline-contract.js";
import { walkTimeline } from "./timeline-page.js";
import type { TimelinePageSource, TimelineRowFilter } from "./timeline-page.js";
import { TimelineRowItem } from "./timeline-row.js";

/**
 * The forensic timeline (spec §2.4, §4.5).
 *
 * Rows render in the order the walker produced them. This surface never sorts, ranks,
 * deduplicates, or upgrades a row, and "causal" here means displaying the causal links
 * the daemon STATED — aggregate, command id, effect, lease epoch — never inferring
 * causality from ordering.
 *
 * FILTERS ROUTE THROUGH THE WALKER, not through the renderer. A filter applied at render
 * time would let the cursor advance past rows that were never displayed, reintroducing
 * DoD 3's silent gap one layer down. Restart gaps are exempt from every filter inside the
 * walker, so narrowing to one node can never erase the evidence of a restart.
 */

export interface TimelineFilterOptions {
  readonly actor: readonly string[];
  readonly node: readonly string[];
  readonly type: readonly string[];
}

export interface TimelineListProps {
  readonly cursorState: TimelineCursorState;
  readonly filterOptions: TimelineFilterOptions;
  readonly maxRows: number;
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly source: TimelinePageSource;
  readonly startCursor: number | null;
}

type FilterSelection = Record<TimelineFilterField, string>;

const NO_SELECTION: FilterSelection = Object.freeze({ actor: "", node: "", type: "" });

const FILTER_LABELS: Record<TimelineFilterField, string> = {
  actor: "actor",
  node: "node",
  type: "type",
};

/** Each axis reads one daemon-stated field. No axis is computed from another. */
function fieldValue(row: TimelineRow, field: TimelineFilterField): string | null {
  if (field === "actor") return row.provenance.actor;
  if (field === "node") return row.provenance.aggregateId;
  return row.eventType;
}

function buildFilter(selection: FilterSelection): TimelineRowFilter | null {
  const active = TIMELINE_FILTER_FIELDS.filter((field) => selection[field] !== "");
  if (active.length === 0) return null;
  return (row: TimelineRow): boolean =>
    active.every((field) => fieldValue(row, field) === selection[field]);
}

function FilterControls(props: {
  readonly onChange: (field: TimelineFilterField, value: string) => void;
  readonly options: TimelineFilterOptions;
  readonly selection: FilterSelection;
}): JSX.Element {
  const { onChange, options, selection } = props;
  return (
    <div>
      {TIMELINE_FILTER_FIELDS.map((field) => (
        <label key={field}>
          {FILTER_LABELS[field]}
          <select
            data-testid={`cr.timeline.filter.${field}`}
            onChange={(event) => {
              onChange(field, event.currentTarget.value);
            }}
            value={selection[field]}
          >
            <option value="">all</option>
            {options[field].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}

/**
 * A refused walk renders as a refusal, never as an empty list. An empty list reads as
 * "nothing happened", which is the most misleading thing a forensic surface can say.
 */
function RefusalNotice({ refusal }: { readonly refusal: TimelineRefused }): JSX.Element {
  return (
    <p data-testid="cr.timeline.refusal">
      {`Timeline refused: ${refusal.code} (${refusal.layer} layer). ${refusal.detail}`}
    </p>
  );
}

function TruncationNotice({ truncation }: { readonly truncation: TimelineTruncation }): JSX.Element {
  return (
    <p data-testid="cr.timeline.truncation">
      {`${truncation.code}: showing ${String(truncation.limit)} rows; `
        + `the walk stopped before #${String(truncation.droppedFromSequence)}.`}
    </p>
  );
}

export function TimelineList(props: TimelineListProps): JSX.Element {
  const { cursorState, filterOptions, maxRows, onProvenance, source, startCursor } = props;
  const [selection, setSelection] = useState<FilterSelection>(NO_SELECTION);
  const walk = useMemo(
    () => walkTimeline({ filter: buildFilter(selection), maxRows, source, startCursor }),
    [maxRows, selection, source, startCursor],
  );
  return (
    <section aria-label="Timeline" data-testid="cr.timeline.list">
      <FilterControls
        onChange={(field, value) => {
          setSelection((current) => ({ ...current, [field]: value }));
        }}
        options={filterOptions}
        selection={selection}
      />
      {walk.outcome === "REFUSED" ? <RefusalNotice refusal={walk} /> : (
        <ol>
          {walk.rows.map((row) => (
            <TimelineRowItem key={`${row.kind}:${String(row.sequence)}`} onProvenance={onProvenance} row={row} />
          ))}
        </ol>
      )}
      {walk.outcome === "WALKED" && walk.truncation !== null
        ? <TruncationNotice truncation={walk.truncation} />
        : null}
      <p data-testid="cr.timeline.cursor">{describeCursor(cursorState)}</p>
    </section>
  );
}
