import { useState } from "react";
import type { JSX } from "react";

import { TruthChip } from "../kernel.js";
import type { ShellTruthPresentation } from "../kernel.js";
import {
  PREVIEW_DOCUMENT_SOURCES, PREVIEW_WORK_CANDIDATES,
} from "./document-preview-data.js";
import type { PreviewDocumentSource, PreviewWorkCandidate } from "./document-preview-data.js";

const SOURCES_BY_ID = new Map(PREVIEW_DOCUMENT_SOURCES.map((source) => [source.id, source]));

function CandidateSource({ candidate, onOpen, source }: {
  readonly candidate: PreviewWorkCandidate;
  readonly onOpen: (sourceId: string) => void;
  readonly source: PreviewDocumentSource;
}): JSX.Element {
  return (
    <a data-testid={`cr.preview.decomposition.source.${source.id}-${candidate.id}`}
      href={`#cr-preview-source-${source.id}`} onClick={() => { onOpen(source.id); }}>
      {source.label}
    </a>
  );
}

function sourcesFor(candidate: PreviewWorkCandidate): readonly PreviewDocumentSource[] {
  return candidate.sourceIds.map((sourceId) => {
    const source = SOURCES_BY_ID.get(sourceId);
    if (source === undefined) {
      throw new Error(`CONTROL_ROOM_PREVIEW_SOURCE_MISSING:${candidate.id}:${sourceId}`);
    }
    return source;
  });
}

function CandidateCard({ candidate, onOpenSource, onProvenance }: {
  readonly candidate: PreviewWorkCandidate;
  readonly onOpenSource: (sourceId: string) => void;
  readonly onProvenance: (
    context: string, shown: ShellTruthPresentation, sourceLabels: readonly string[],
  ) => void;
}): JSX.Element {
  const sources = sourcesFor(candidate);
  return (
    <article className="cr-dossier-candidate" data-authority="none"
      data-testid={`cr.preview.decomposition.task.${candidate.id}`}>
      <header>
        <span>Candidate · not submitted</span>
        <TruthChip contextLabel={`Provenance for ${candidate.title}`}
          onProvenance={(shown) => {
            onProvenance(candidate.title, shown, sources.map((source) => source.label));
          }}
          truthClass="AGENT_REPORTED" />
      </header>
      <h3>{candidate.title}</h3>
      <dl>
        <div><dt>Role</dt><dd>{candidate.role}</dd></div>
        <div><dt>Owner</dt><dd>Unassigned</dd></div>
        <div><dt>Progress</dt><dd>Not started</dd></div>
      </dl>
      <nav aria-label={`Sources for ${candidate.title}`}>
        <span>Derived from</span>
        {sources.map((source) => (
          <CandidateSource candidate={candidate} key={source.id} onOpen={onOpenSource}
            source={source} />
        ))}
      </nav>
    </article>
  );
}

export function DocumentDossier(): JSX.Element {
  const [openSources, setOpenSources] = useState<ReadonlySet<string>>(() => new Set());
  const [provenance, setProvenance] = useState<{
    readonly context: string;
    readonly shown: ShellTruthPresentation;
    readonly sourceLabels: readonly string[];
  } | null>(null);
  const showProvenance = (
    context: string, shown: ShellTruthPresentation, sourceLabels: readonly string[] = [],
  ): void => {
    setProvenance({ context, shown, sourceLabels });
  };
  const setSourceOpen = (sourceId: string, open: boolean): void => {
    setOpenSources((current) => {
      if (current.has(sourceId) === open) return current;
      const next = new Set(current);
      if (open) next.add(sourceId);
      else next.delete(sourceId);
      return next;
    });
  };
  return (
    <section aria-labelledby="cr-dossier-title" className="cr-dossier"
      data-authority="none" data-testid="cr.preview.dossier">
      <header className="cr-dossier-header">
        <div>
          <span>Document intake · development fixture</span>
          <h2 id="cr-dossier-title">Stale-port recovery dossier</h2>
        </div>
        <code>sample/docs@7f3a</code>
      </header>
      <div className="cr-dossier-body">
        <section aria-labelledby="cr-dossier-candidates-title"
          className="cr-dossier-decomposition" data-testid="cr.preview.decomposition">
          <header>
            <div>
              <span>Work candidates / automatic decomposition</span>
              <strong id="cr-dossier-candidates-title">
                3 sample work candidates · not submitted
              </strong>
            </div>
            <TruthChip contextLabel="Provenance for automatic decomposition"
              onProvenance={(shown) => {
                showProvenance("Automatic decomposition", shown,
                  PREVIEW_DOCUMENT_SOURCES.map((source) => source.label));
              }}
              truthClass="AGENT_REPORTED" />
          </header>
          <div className="cr-dossier-quality" data-testid="cr.preview.decomposition.quality">
            <span>Admission not requested</span>
            <span>Plan quality</span>
            <TruthChip contextLabel="Provenance for plan quality"
              onProvenance={(shown) => { showProvenance("Plan quality", shown); }}
              truthClass="UNKNOWN" />
          </div>
          {provenance === null ? null : (
            <aside className="cr-dossier-provenance"
              data-testid="cr.preview.dossier.provenance" role="status">
              <strong>{provenance.context}</strong>
              <span>{provenance.shown.descriptor.truthClass}</span>
              <p>{provenance.shown.descriptor.meaning}</p>
              <p className="cr-dossier-provenance-sources">
                Source references: {provenance.sourceLabels.length === 0
                  ? "none supplied"
                  : provenance.sourceLabels.join(" · ")}
              </p>
              <small>
                Preview fixture only; no daemon event, actor, session, or receipt exists.
              </small>
            </aside>
          )}
          <p className="cr-dossier-boundary">
            No daemon attached; no task records were created.
          </p>
          <div className="cr-dossier-candidates">
            {PREVIEW_WORK_CANDIDATES.map((candidate) => (
              <CandidateCard candidate={candidate} key={candidate.id}
                onOpenSource={(sourceId) => { setSourceOpen(sourceId, true); }}
                onProvenance={showProvenance} />
            ))}
          </div>
        </section>
        <section aria-labelledby="cr-dossier-sources-title" className="cr-dossier-sources">
          <header>
            <span>Source material / lineage</span>
            <strong id="cr-dossier-sources-title">3 documents indexed</strong>
          </header>
          <ol className="cr-dossier-source-list">
            {PREVIEW_DOCUMENT_SOURCES.map((source) => (
              <li data-testid={`cr.preview.dossier.source.${source.id}`}
                id={`cr-preview-source-${source.id}`} key={source.id}>
                <details onToggle={(event) => {
                  setSourceOpen(source.id, event.currentTarget.open);
                }} open={openSources.has(source.id)}>
                  <summary><span>{source.label}</span><code>{source.path}</code></summary>
                  <p>{source.excerpt}</p>
                </details>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </section>
  );
}
