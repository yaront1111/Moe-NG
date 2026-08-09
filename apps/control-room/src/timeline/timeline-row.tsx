import { useState } from "react";
import type { JSX, KeyboardEvent } from "react";

import { UNSTATED } from "../data/data-contract.js";
import { FactRow } from "../nodes/node-authority.js";
import type { ProvenanceHandler } from "../nodes/node-authority.js";
import { PROVENANCE_SHORTCUT_KEY } from "../shell/provenance-panel.js";
import {
  TIMELINE_ROW_KINDS,
  refuseTimeline,
  statedProvenance,
  statedValue,
} from "./timeline-contract.js";
import type {
  TimelineProvenance,
  TimelineRejectedRow,
  TimelineRestartGapRow,
  TimelineRow,
  TimelineRowKind,
} from "./timeline-contract.js";

/**
 * One timeline row.
 *
 * Truth presentation is not reimplemented here: the row's claim goes through
 * `FactRow` -> `Fact` -> `TruthChip` -> `describeTruthClass`, so the chip is a structural
 * child and the row cannot render a claim without its class. Nothing here sorts, ranks,
 * or compares rows, which is what deriving evidence strength would look like.
 *
 * Every state is carried by TEXT as well as by the chip's glyph and tone, so no meaning
 * depends on colour or icon alone.
 */

/** Row state as words. The chip supplies glyph and tone; this supplies the reading. */
const KIND_TEXT: Record<TimelineRowKind, string> = {
  EVENT: "EVENT",
  REJECTED: "REJECTED",
  RESTART_GAP: "RESTART GAP",
};

type ProvenanceCell = readonly [field: string, label: string, value: string | null];

/**
 * An absent lease epoch renders UNKNOWN rather than §3.2's "not a leased mutation".
 * The daemon omits the field both when the mutation was not leased and when it simply
 * did not state one, and this surface cannot tell those apart — so it says so.
 */
function provenanceCells(provenance: TimelineProvenance): readonly ProvenanceCell[] {
  const { typedLink } = provenance;
  return [
    ["actor", "Actor", provenance.actor],
    ["session", "Session", provenance.sessionId],
    ["aggregate", "Aggregate", provenance.aggregateId],
    ["command", "Command", provenance.commandId],
    ["effect", "Effect", provenance.effectId],
    ["lease", "Lease epoch", provenance.leaseEpoch === null ? null : `#${String(provenance.leaseEpoch)}`],
    ["timestamp", "Timestamp", provenance.timestamp],
    ["link", typedLink === null ? "Typed link" : typedLink.label, typedLink?.ref ?? null],
  ];
}

function ProvenanceDrill(props: {
  readonly open: boolean;
  readonly provenance: TimelineProvenance;
  readonly sequence: number;
  readonly setOpen: (open: boolean) => void;
}): JSX.Element {
  const { open, provenance, sequence, setOpen } = props;
  return (
    <details
      data-testid={`cr.timeline.provenance.${String(sequence)}`}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
      open={open}
    >
      <summary>Provenance</summary>
      <dl>
        {provenanceCells(provenance).map(([field, label, value]) => (
          <div key={field}>
            <dt>{label}</dt>
            <dd
              data-provenance={statedProvenance(value)}
              data-testid={`cr.timeline.provenance.${String(sequence)}.${field}`}
            >
              {statedValue(value) ?? UNSTATED}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** §8.2's explain affordance, carrying the daemon's own reason code beside it. */
function RejectionDetail({ row }: { readonly row: TimelineRejectedRow }): JSX.Element {
  const sequence = String(row.sequence);
  return (
    <div>
      <span data-testid={`cr.timeline.reason.${sequence}`}>{row.reasonCode ?? UNSTATED}</span>
      <details data-testid={`cr.timeline.explain.${sequence}`}>
        <summary>explain</summary>
        <p>{row.explain ?? UNSTATED}</p>
      </details>
    </div>
  );
}

/** §13-D3: what the daemon said about the gap. The missing span is never re-derived. */
function GapDetail({ row }: { readonly row: TimelineRestartGapRow }): JSX.Element {
  const lastGood = row.lastGoodSequence === null ? UNSTATED : `#${String(row.lastGoodSequence)}`;
  return (
    <p data-testid={`cr.timeline.gap.${String(row.sequence)}`}>
      {`${row.gapOutcome} — last good event ${lastGood}. ${row.statedCause ?? UNSTATED}`}
    </p>
  );
}

/**
 * A row is linkable only when the daemon named the event the link would resolve to.
 * A blank id is not a name: it would produce `#timeline/`, presenting unreachable
 * evidence as reachable, which is what `node-evidence.EvidenceLink` also refuses.
 */
function JumpLink({ eventId }: { readonly eventId: string | null }): JSX.Element | null {
  const target = statedValue(eventId);
  if (target === null) return null;
  return (
    <a data-testid="cr.timeline.jump" href={`#timeline/${target}`}>
      Open in timeline
    </a>
  );
}

function UnsupportedRow({ row }: { readonly row: TimelineRow }): JSX.Element {
  const refusal = refuseTimeline(
    "TIMELINE_ROW_KIND_UNSUPPORTED",
    "RENDER",
    `row #${String(row.sequence)} carries kind ${String(row.kind)}`,
  );
  return (
    <li data-testid={`cr.timeline.row.${String(row.sequence)}`} tabIndex={0}>
      {`${refusal.code} (${refusal.layer} layer). ${refusal.detail}`}
    </li>
  );
}

export interface TimelineRowItemProps {
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly row: TimelineRow;
}

/**
 * Renders one row in the position the walker produced it. The `p` shortcut opens the
 * drill-down only while a chip holds focus, mirroring `FactWithProvenance`'s own guard so
 * a literal "p" typed into a later control cannot trigger it.
 */
export function TimelineRowItem({ onProvenance, row }: TimelineRowItemProps): JSX.Element {
  const [open, setOpen] = useState(false);
  if (!TIMELINE_ROW_KINDS.includes(row.kind)) {
    return <UnsupportedRow row={row} />;
  }
  const sequence = String(row.sequence);
  const rowKey = row.kind === "RESTART_GAP" ? "restart" : sequence;
  const shortcut = (event: KeyboardEvent<HTMLLIElement>): void => {
    if (event.key !== PROVENANCE_SHORTCUT_KEY) return;
    const { target } = event;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest("[data-testid^='cr.chip.']") === null) return;
    event.preventDefault();
    setOpen(true);
  };
  return (
    <li data-testid={`cr.timeline.row.${rowKey}`} onKeyDown={shortcut} tabIndex={0}>
      <span data-testid={`cr.timeline.kind.${rowKey}`}>{KIND_TEXT[row.kind]}</span>
      <span data-testid={`cr.timeline.type.${sequence}`}>{row.eventType ?? UNSTATED}</span>
      <FactRow
        fact={{ truthClass: row.truthClass, value: row.summary }}
        factId={`timeline.${sequence}.summary`}
        label={`#${sequence}`}
        onProvenance={onProvenance}
      />
      {row.kind === "REJECTED" ? <RejectionDetail row={row} /> : null}
      {row.kind === "RESTART_GAP" ? <GapDetail row={row} /> : null}
      <JumpLink eventId={row.provenance.eventId} />
      <ProvenanceDrill
        open={open}
        provenance={row.provenance}
        sequence={row.sequence}
        setOpen={setOpen}
      />
    </li>
  );
}
