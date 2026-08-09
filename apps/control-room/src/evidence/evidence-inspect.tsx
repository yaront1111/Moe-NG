import type { JSX } from "react";

import { UNSTATED } from "../data/data-contract.js";
import { FactRow } from "../nodes/node-authority.js";
import type { ProvenanceHandler } from "../nodes/node-authority.js";
import { describeCursor, statedProvenance, statedValue } from "../timeline/timeline-contract.js";
import type { TimelineCursorState, TimelineProvenance } from "../timeline/timeline-contract.js";
import type {
  EvidenceArtifactDigest,
  EvidenceComparison,
  EvidenceRecipe,
  EvidenceReceiptRecord,
  EvidenceRejection,
  EvidenceSessionEntry,
} from "./evidence-contract.js";

/**
 * One receipt in full (spec §2.9), for INSPECTION only.
 *
 * Altering or upgrading evidence is out of scope, so this surface renders no rerun and no
 * mutate affordance and synthesizes none: an action may appear only because the daemon
 * stated one, and none is stated here. It sits alongside `evidence-j1.tsx`, which owns
 * the narrower J1 result view and is deliberately left untouched.
 *
 * Every value is printed exactly as supplied. Nothing is rounded, re-labelled, or
 * shortened — a truncated digest cannot be compared, and a fact that cannot be compared
 * is not evidence.
 */

export interface EvidenceInspectProps {
  readonly comparison: EvidenceComparison | null;
  readonly cursorState: TimelineCursorState;
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly receipt: EvidenceReceiptRecord;
  readonly rejection: EvidenceRejection | null;
  readonly sessionMessages: readonly EvidenceSessionEntry[];
}

type Cell = readonly [id: string, label: string, value: string | null];

/** One supplied-or-absent value. The provenance travels in the DOM beside the text. */
function StatedCell({ cell, prefix }: { readonly cell: Cell; readonly prefix: string }): JSX.Element {
  const [id, label, value] = cell;
  return (
    <div>
      <dt>{label}</dt>
      <dd data-provenance={statedProvenance(value)} data-testid={`${prefix}.${id}`}>
        {statedValue(value) ?? UNSTATED}
      </dd>
    </div>
  );
}

function CellList({ cells, prefix }: { readonly cells: readonly Cell[]; readonly prefix: string }): JSX.Element {
  return (
    <dl>
      {cells.map((cell) => (
        <StatedCell cell={cell} key={cell[0]} prefix={prefix} />
      ))}
    </dl>
  );
}

function runCells(receipt: EvidenceReceiptRecord): readonly Cell[] {
  const { output, run, tree } = receipt;
  return [
    ["started", "Started", run.startedAt],
    ["ended", "Ended", run.endedAt],
    ["exit", "Exit code", run.exitCode === null ? null : String(run.exitCode)],
    ["output-digest", "Output digest", output.digest],
    ["output-tail", "Output tail", output.tail],
    ["base-sha", "Base SHA", tree.baseSha],
    ["head-sha", "Head SHA", tree.headSha],
    ["dirty-digest", "Dirty-tree digest", tree.dirtyTreeDigest],
  ];
}

function provenanceCells(provenance: TimelineProvenance): readonly Cell[] {
  return [
    ["actor", "Actor", provenance.actor],
    ["session", "Session", provenance.sessionId],
    ["aggregate", "Aggregate", provenance.aggregateId],
    ["command", "Command", provenance.commandId],
    ["effect", "Effect", provenance.effectId],
    ["lease", "Lease epoch", provenance.leaseEpoch === null ? null : `#${String(provenance.leaseEpoch)}`],
    ["timestamp", "Timestamp", provenance.timestamp],
    ["link", "Typed link", provenance.typedLink?.ref ?? null],
  ];
}

function Recipe({ recipe }: { readonly recipe: EvidenceRecipe }): JSX.Element {
  return (
    <section data-testid="cr.evidence.recipe">
      <h3>Recipe</h3>
      <ol data-testid="cr.evidence.field.argv">
        {recipe.argv.map((word, index) => (
          <li data-testid={`cr.evidence.argv.${String(index)}`} key={`${String(index)}:${word}`}>
            {word}
          </li>
        ))}
      </ol>
      <CellList
        cells={[["cwd", "Working directory", recipe.cwd], ["env", "Env fingerprint", recipe.envFingerprint]]}
        prefix="cr.evidence.field"
      />
    </section>
  );
}

function Artifacts({ artifacts }: { readonly artifacts: readonly EvidenceArtifactDigest[] }): JSX.Element {
  return (
    <section data-testid="cr.evidence.artifacts">
      <h3>Artifacts</h3>
      {artifacts.map((artifact) => (
        <article data-testid={`cr.evidence.artifact.${artifact.artifactId}`} key={artifact.artifactId}>
          <span>{artifact.artifactId}</span>
          <span data-provenance={statedProvenance(artifact.digest)} data-testid="cr.evidence.digest">
            {statedValue(artifact.digest) ?? UNSTATED}
          </span>
        </article>
      ))}
    </section>
  );
}

function Comparison({ comparison }: { readonly comparison: EvidenceComparison | null }): JSX.Element {
  if (comparison === null) {
    return <p data-testid="cr.evidence.compare">No comparison supplied.</p>;
  }
  return (
    <p data-testid="cr.evidence.compare">
      {`Against ${comparison.againstReceiptId}: ${comparison.statedOutcome ?? UNSTATED}`}
    </p>
  );
}

function Rejection({ rejection }: { readonly rejection: EvidenceRejection | null }): JSX.Element | null {
  if (rejection === null) return null;
  return (
    <p data-testid="cr.evidence.rejection">
      {`${rejection.reasonCode ?? UNSTATED} refused by ${rejection.refusedLayer ?? UNSTATED}: `
        + `${rejection.detail ?? UNSTATED}`}
    </p>
  );
}

/**
 * Typed session messages, kept visible and kept inert. The receipt's own `advisoryOnly`
 * and `authority: "NONE"` are rendered rather than assumed, so an operator can see that
 * the message carries no authority instead of having to trust that it does not.
 */
function Sessions({ entries }: { readonly entries: readonly EvidenceSessionEntry[] }): JSX.Element {
  if (entries.length === 0) {
    return <p data-testid="cr.evidence.sessions">No session messages recorded.</p>;
  }
  return (
    <section data-testid="cr.evidence.sessions">
      {entries.map((entry, index) => (
        <article data-testid={`cr.evidence.session.${String(index)}`} key={`${String(index)}:${entry.message.text}`}>
          <span data-testid="cr.evidence.session.kind">{entry.receipt.kind}</span>
          <span data-testid="cr.evidence.session.text">{entry.message.text}</span>
          <span data-testid="cr.evidence.session.authority">{entry.receipt.authority}</span>
          <span data-testid="cr.evidence.session.advisory">
            {entry.receipt.advisoryOnly ? "advisory only" : UNSTATED}
          </span>
        </article>
      ))}
    </section>
  );
}

export function EvidenceInspect(props: EvidenceInspectProps): JSX.Element {
  const { comparison, cursorState, onProvenance, receipt, rejection, sessionMessages } = props;
  return (
    <section aria-label="Evidence receipt" data-testid="cr.evidence.inspect">
      <div data-testid="cr.evidence.receipt">
        <FactRow
          fact={{ truthClass: receipt.truthClass, value: receipt.output.tail }}
          factId={`evidence.${receipt.receiptId}.result`}
          label="Receipt result"
          onProvenance={onProvenance}
        />
        <CellList cells={runCells(receipt)} prefix="cr.evidence.field" />
      </div>
      <Recipe recipe={receipt.recipe} />
      <Artifacts artifacts={receipt.artifacts} />
      <section data-testid="cr.evidence.provenance">
        <h3>Provenance</h3>
        <CellList cells={provenanceCells(receipt.provenance)} prefix="cr.evidence.provenance" />
      </section>
      <p data-testid="cr.evidence.cursor">{describeCursor(cursorState)}</p>
      <Comparison comparison={comparison} />
      <Rejection rejection={rejection} />
      <Sessions entries={sessionMessages} />
    </section>
  );
}
