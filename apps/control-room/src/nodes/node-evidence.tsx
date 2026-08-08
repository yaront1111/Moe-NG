import type { JSX } from "react";

import { FactList, NONE_SUPPLIED, Panel, readIdentity } from "./node-authority.js";
import type { ProvenanceHandler, SuppliedFact } from "./node-authority.js";

/** One receipt exactly as supplied; this module never reruns or re-scores it. */
export interface EvidenceReceipt {
  readonly provenanceRef: string | null;
  readonly receiptId: string;
  readonly recipe: SuppliedFact;
  readonly result: SuppliedFact;
}

export interface EvidenceArtifact {
  readonly artifactId: string;
  readonly artifactType: SuppliedFact;
  readonly digest: SuppliedFact;
  readonly provenanceRef: string | null;
}

export interface EvidenceFinding {
  readonly category: SuppliedFact;
  readonly detail: SuppliedFact;
  readonly findingId: string;
  readonly severity: SuppliedFact;
}

export interface EvidenceBlocker {
  readonly blockerId: string;
  readonly detail: SuppliedFact;
  readonly owner: SuppliedFact;
  readonly state: SuppliedFact;
}

export interface NodeEvidenceProps {
  readonly artifacts: readonly EvidenceArtifact[];
  readonly blockers: readonly EvidenceBlocker[];
  readonly findings: readonly EvidenceFinding[];
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly receipts: readonly EvidenceReceipt[];
}

function EmptyCollection(): JSX.Element {
  return <p>{NONE_SUPPLIED}</p>;
}

/**
 * An evidence link exists only when both the identity and the provenance that
 * would resolve it were supplied. A link built from a missing half would present
 * unreachable evidence as inspectable.
 */
function EvidenceLink(props: {
  readonly identity: string;
  readonly kind: "artifact" | "receipt";
  readonly provenanceRef: string | null;
}): JSX.Element | null {
  const { identity, kind, provenanceRef } = props;
  const resolvable =
    typeof identity === "string" && identity !== ""
    && typeof provenanceRef === "string" && provenanceRef !== "";
  if (!resolvable) {
    return null;
  }
  return (
    <a data-testid={`cr.evidence.link.${kind}.${identity}`} href={`#${provenanceRef}`}>
      {provenanceRef}
    </a>
  );
}

export function ReceiptList(props: {
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly receipts: readonly EvidenceReceipt[];
}): JSX.Element {
  const { onProvenance, receipts } = props;
  if (receipts.length === 0) {
    return <EmptyCollection />;
  }
  return (
    <div>
      {receipts.map((receipt) => {
        const shownId = readIdentity(receipt.receiptId);
        return (
          <article data-testid={`cr.inspector.receipt.${shownId}`} key={shownId}>
            <FactList
              onProvenance={onProvenance}
              rows={[
                [`receipt.${shownId}.result`, "Result", receipt.result],
                [`receipt.${shownId}.recipe`, "Recipe", receipt.recipe],
              ]}
            />
            <EvidenceLink
              identity={receipt.receiptId}
              kind="receipt"
              provenanceRef={receipt.provenanceRef}
            />
          </article>
        );
      })}
    </div>
  );
}

function ArtifactList(props: {
  readonly artifacts: readonly EvidenceArtifact[];
  readonly onProvenance?: ProvenanceHandler | undefined;
}): JSX.Element {
  const { artifacts, onProvenance } = props;
  if (artifacts.length === 0) {
    return <EmptyCollection />;
  }
  return (
    <div>
      {artifacts.map((artifact) => {
        const shownId = readIdentity(artifact.artifactId);
        return (
          <article data-testid={`cr.inspector.artifact.${shownId}`} key={shownId}>
            <FactList
              onProvenance={onProvenance}
              rows={[
                [`artifact.${shownId}.type`, "Artifact type", artifact.artifactType],
                [`artifact.${shownId}.digest`, "Digest", artifact.digest],
              ]}
            />
            <EvidenceLink
              identity={artifact.artifactId}
              kind="artifact"
              provenanceRef={artifact.provenanceRef}
            />
          </article>
        );
      })}
    </div>
  );
}

export function FindingList(props: {
  readonly findings: readonly EvidenceFinding[];
  readonly onProvenance?: ProvenanceHandler | undefined;
}): JSX.Element {
  const { findings, onProvenance } = props;
  if (findings.length === 0) {
    return <EmptyCollection />;
  }
  return (
    <div>
      {findings.map((finding) => {
        const shownId = readIdentity(finding.findingId);
        return (
          <article data-testid={`cr.inspector.finding.${shownId}`} key={shownId}>
            <FactList
              onProvenance={onProvenance}
              rows={[
                [`finding.${shownId}.category`, "Category", finding.category],
                [`finding.${shownId}.severity`, "Severity", finding.severity],
                [`finding.${shownId}.detail`, "Detail", finding.detail],
              ]}
            />
          </article>
        );
      })}
    </div>
  );
}

function BlockerList(props: {
  readonly blockers: readonly EvidenceBlocker[];
  readonly onProvenance?: ProvenanceHandler | undefined;
}): JSX.Element {
  const { blockers, onProvenance } = props;
  if (blockers.length === 0) {
    return <EmptyCollection />;
  }
  return (
    <div>
      {blockers.map((blocker) => {
        const shownId = readIdentity(blocker.blockerId);
        return (
          <article data-testid={`cr.inspector.blocker.${shownId}`} key={shownId}>
            <FactList
              onProvenance={onProvenance}
              rows={[
                [`blocker.${shownId}.owner`, "Owner", blocker.owner],
                [`blocker.${shownId}.state`, "State", blocker.state],
                [`blocker.${shownId}.detail`, "Detail", blocker.detail],
              ]}
            />
          </article>
        );
      })}
    </div>
  );
}

/**
 * Receipts, artifacts, findings, and blockers in the order the daemon supplied
 * them. The arrays are read, never sorted, filtered, ranked, or deduplicated, so
 * the operator sees the daemon's own ordering rather than this module's opinion
 * of which evidence matters most.
 */
export function NodeEvidence(props: NodeEvidenceProps): JSX.Element {
  const { artifacts, blockers, findings, onProvenance, receipts } = props;
  return (
    <div data-testid="cr.inspector.evidence">
      <Panel heading="Receipts" testId="cr.inspector.section.receipts">
        <ReceiptList onProvenance={onProvenance} receipts={receipts} />
      </Panel>
      <Panel heading="Artifacts" testId="cr.inspector.section.artifacts">
        <ArtifactList artifacts={artifacts} onProvenance={onProvenance} />
      </Panel>
      <Panel heading="Findings" testId="cr.inspector.section.findings">
        <FindingList findings={findings} onProvenance={onProvenance} />
      </Panel>
      <Panel heading="Blockers" testId="cr.inspector.section.blockers">
        <BlockerList blockers={blockers} onProvenance={onProvenance} />
      </Panel>
    </div>
  );
}
