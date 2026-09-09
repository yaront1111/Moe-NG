import { useState } from "react";
import type { JSX } from "react";

import type { LiveEventRow } from "../../live/live-event-feed.js";
import type { GraphGetOutcome } from "../../live/live-graph-get.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { MIDDOT } from "../glyphs.js";
import { readFailedSaid } from "../outcome-words.js";

/**
 * FORENSIC raw reads behind a toggle that starts OFF. Renders decoded frames,
 * never prose summaries: a served read is reachable when its frame is on this
 * panel. Graph frames are GraphGetOutcome from mapGraphGetAnswer; event rows
 * are LiveEventRow from the production event-page shaper. A refusal renders
 * its code verbatim through OutcomeNote.
 */

export type AdvancedEvents =
  | { readonly status: "EVENTS"; readonly rows: readonly LiveEventRow[] }
  | { readonly status: "REFUSED"; readonly code: string; readonly layer: string }
  | { readonly status: "ERROR"; readonly code: string; readonly layer: string };

export interface AdvancedViewProps {
  readonly events?: AdvancedEvents | null;
  readonly graph?: GraphGetOutcome | null;
}

function Refusal({ code, layer, testId, what }: {
  readonly code: string; readonly layer: string; readonly testId: string; readonly what: string;
}): JSX.Element {
  return <OutcomeNote code={code} layer={layer} said={readFailedSaid(what)} testId={testId} />;
}

function GraphFrame({ graph }: { readonly graph: GraphGetOutcome }): JSX.Element {
  if (graph.status !== "GRAPH") {
    return <Refusal code={graph.code} layer={graph.layer} testId="cr.advanced.graph.refusal" what="active graph" />;
  }
  const nodeKeys = graph.snapshot.nodes.map((node) => node.nodeKey).join(", ");
  return (
    <article className="cr2-ops-card" data-testid="cr.advanced.graph.frame">
      <p className="cr2-slot-kicker">Active graph</p>
      <dl className="cr2-ops-facts">
        <div className="cr2-ops-fact">
          <dt className="cr2-ops-fact-label">graphContentHash</dt>
          <dd
            className="cr2-ops-fact-value cr2-approve-mono"
            data-testid="cr.advanced.graph.hash"
            style={{ overflowWrap: "anywhere" }}
          >
            {graph.graphContentHash}
          </dd>
        </div>
        <div className="cr2-ops-fact">
          <dt className="cr2-ops-fact-label">revisionId</dt>
          <dd className="cr2-ops-fact-value cr2-approve-mono" data-testid="cr.advanced.graph.revision">
            {graph.revisionId}
          </dd>
        </div>
        <div className="cr2-ops-fact">
          <dt className="cr2-ops-fact-label">graphEpoch</dt>
          <dd className="cr2-ops-fact-value" data-testid="cr.advanced.graph.epoch">{String(graph.graphEpoch)}</dd>
        </div>
        <div className="cr2-ops-fact">
          <dt className="cr2-ops-fact-label">nodes</dt>
          <dd className="cr2-ops-fact-value cr2-approve-mono" data-testid="cr.advanced.graph.nodes">{nodeKeys}</dd>
        </div>
      </dl>
    </article>
  );
}

function EventFrame({ row }: { readonly row: LiveEventRow }): JSX.Element {
  return (
    <article className="cr2-ops-card" data-testid={`cr.advanced.events.frame.${row.eventId}`}>
      <p className="cr2-slot-kicker">{row.eventType}</p>
      <dl className="cr2-ops-facts">
        <div className="cr2-ops-fact">
          <dt className="cr2-ops-fact-label">eventId</dt>
          <dd className="cr2-ops-fact-value cr2-approve-mono">{row.eventId}</dd>
        </div>
        <div className="cr2-ops-fact">
          <dt className="cr2-ops-fact-label">aggregateId</dt>
          <dd className="cr2-ops-fact-value cr2-approve-mono">{row.aggregateId}</dd>
        </div>
        <div className="cr2-ops-fact">
          <dt className="cr2-ops-fact-label">committedAt</dt>
          <dd className="cr2-ops-fact-value cr2-approve-mono">{row.committedAt}</dd>
        </div>
        <div className="cr2-ops-fact">
          <dt className="cr2-ops-fact-label">position</dt>
          <dd className="cr2-ops-fact-value cr2-approve-mono">{row.position}</dd>
        </div>
      </dl>
    </article>
  );
}

function EventsBlock({ events }: { readonly events: AdvancedEvents | null | undefined }): JSX.Element {
  if (events === null || events === undefined) {
    return <p className="cr2-slot-kicker" data-testid="cr.advanced.events.pending">Reading event frames...</p>;
  }
  if (events.status !== "EVENTS") {
    return <Refusal code={events.code} layer={events.layer} testId="cr.advanced.events.refusal" what="event frames" />;
  }
  if (events.rows.length === 0) {
    return <p className="cr2-needs-note" data-testid="cr.advanced.events.empty">No event frames yet.</p>;
  }
  return (
    <div data-testid="cr.advanced.events.list">
      {events.rows.map((row) => <EventFrame key={row.eventId} row={row} />)}
    </div>
  );
}

export function AdvancedView({ events, graph }: AdvancedViewProps): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="cr.advanced.root">
      <button
        aria-controls="cr-advanced-panel"
        aria-expanded={open}
        className="cr2-btn"
        data-testid="cr.advanced.toggle"
        data-variant="ghost"
        onClick={() => { setOpen((current) => !current); }}
        title="The bytes the daemon sent, as frames"
        type="button"
      >
        {open ? "Hide advanced" : "Show advanced"}
      </button>
      {open ? (
        <section className="cr2-ops" data-testid="cr.advanced.panel" id="cr-advanced-panel">
          <p className="cr2-needs-note">
            {`What the daemon sent ${MIDDOT} hashes and event ids, not a summary.`}
          </p>
          {graph === null || graph === undefined
            ? <p className="cr2-slot-kicker" data-testid="cr.advanced.graph.pending">Reading the active graph...</p>
            : <GraphFrame graph={graph} />}
          <p className="cr2-slot-kicker">Event frames</p>
          <EventsBlock events={events} />
        </section>
      ) : null}
    </div>
  );
}
