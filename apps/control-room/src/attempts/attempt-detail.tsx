import type { JSX } from "react";

import { FactList, NONE_SUPPLIED, Panel, readIdentity } from "../nodes/node-authority.js";
import type { ProvenanceHandler, SuppliedFact } from "../nodes/node-authority.js";
import { ReceiptList } from "../nodes/node-evidence.js";
import type { EvidenceReceipt } from "../nodes/node-evidence.js";

/** The exact disclosure label the spec pins for attempt narrative. */
export const TRANSCRIPT_DISCLOSURE_LABEL = "💬 AGENT_REPORTED — narrative, not evidence";

/** Identity fixed when the attempt started; carry never rewrites these. */
export interface AttemptSourceFacts {
  readonly attemptNumber: SuppliedFact;
  readonly inputBindingHash: SuppliedFact;
  readonly outcome: SuppliedFact;
  readonly startedRevision: SuppliedFact;
}

/** Fencing that applies now, which may belong to a later graph revision. */
export interface AttemptBindingFacts {
  readonly bindingVersion: SuppliedFact;
  readonly graphEpoch: SuppliedFact;
  readonly leaseEpoch: SuppliedFact;
}

export interface AttemptJournalEntry {
  readonly entryId: string;
  readonly summary: SuppliedFact;
}

export interface AttemptRecoveryFacts {
  readonly reason: SuppliedFact;
  readonly state: SuppliedFact;
}

export interface AttemptDetailProps {
  readonly attemptId: string;
  readonly currentBinding: AttemptBindingFacts;
  readonly journal: readonly AttemptJournalEntry[];
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly receipts: readonly EvidenceReceipt[];
  readonly recovery: AttemptRecoveryFacts;
  readonly source: AttemptSourceFacts;
  /** Agent narrative. Rendered as prose only; no fact is ever derived from it. */
  readonly transcript: readonly string[];
}

function JournalList(props: {
  readonly entries: readonly AttemptJournalEntry[];
  readonly onProvenance?: ProvenanceHandler | undefined;
}): JSX.Element {
  const { entries, onProvenance } = props;
  if (entries.length === 0) {
    return <p>{NONE_SUPPLIED}</p>;
  }
  return (
    <div>
      {entries.map((entry, index) => {
        const shownId = readIdentity(entry.entryId);
        return (
          <article data-testid={`cr.inspector.journal.${shownId}`} key={`${String(index)}:${shownId}`}>
            <FactList
              onProvenance={onProvenance}
              rows={[[`journal.${shownId}.summary`, "Dead-end journal", entry.summary]]}
            />
          </article>
        );
      })}
    </div>
  );
}

/**
 * The attempt's own narrative, quarantined behind a native disclosure.
 *
 * It is collapsed by default and never rendered inside an evidence region, so a
 * persuasive worker report cannot be read as proof of anything. The disclosure
 * carries no fact wrapper and no chip: narrative is not a claim this surface
 * classifies, and the label states its class in full.
 */
function TranscriptDisclosure(props: {
  readonly attemptId: string;
  readonly lines: readonly string[];
}): JSX.Element | null {
  const { attemptId, lines } = props;
  if (lines.length === 0) {
    return null;
  }
  return (
    <details data-testid={`cr.inspector.transcript.${readIdentity(attemptId)}`}>
      <summary>{TRANSCRIPT_DISCLOSURE_LABEL}</summary>
      {lines.map((line, index) => (
        <p key={`${String(index)}:${line}`}>{line}</p>
      ))}
    </details>
  );
}

/**
 * One attempt's operational history.
 *
 * The attempt's immutable source identity and the binding that fences it now are
 * displayed as separate facts, because a carried attempt keeps the former while
 * receiving the latter. Nothing here decides whether the attempt succeeded.
 */
export function AttemptDetail(props: AttemptDetailProps): JSX.Element {
  const {
    attemptId, currentBinding, journal, onProvenance, receipts, recovery, source, transcript,
  } = props;
  return (
    <div data-testid={`cr.attemptdetail.${readIdentity(attemptId)}`}>
      <Panel heading="Attempt" testId="cr.attemptdetail.section.identity">
        <FactList
          onProvenance={onProvenance}
          rows={[
            ["attempt.number", "Attempt", source.attemptNumber],
            ["attempt.outcome", "Outcome", source.outcome],
            ["attempt.startedrevision", "Started revision", source.startedRevision],
            ["attempt.inputbindinghash", "Input binding hash", source.inputBindingHash],
          ]}
        />
      </Panel>
      <Panel heading="Current binding" testId="cr.attemptdetail.section.binding">
        <FactList
          onProvenance={onProvenance}
          rows={[
            ["attempt.binding.graphepoch", "Graph epoch", currentBinding.graphEpoch],
            ["attempt.binding.leaseepoch", "Lease epoch", currentBinding.leaseEpoch],
            ["attempt.binding.version", "Binding version", currentBinding.bindingVersion],
          ]}
        />
      </Panel>
      <Panel heading="Receipts" testId="cr.attemptdetail.section.receipts">
        <ReceiptList onProvenance={onProvenance} receipts={receipts} />
      </Panel>
      <Panel heading="Journal" testId="cr.attemptdetail.section.journal">
        <JournalList entries={journal} onProvenance={onProvenance} />
      </Panel>
      <Panel heading="Recovery" testId="cr.attemptdetail.section.recovery">
        <FactList
          onProvenance={onProvenance}
          rows={[
            ["attempt.recovery.state", "Recovery state", recovery.state],
            ["attempt.recovery.reason", "Recovery reason", recovery.reason],
          ]}
        />
      </Panel>
      <TranscriptDisclosure attemptId={attemptId} lines={transcript} />
    </div>
  );
}
