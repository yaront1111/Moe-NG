import { useState } from "react";
import type { JSX } from "react";

import { TruthChip } from "../kernel.js";
import type { ShellTruthPresentation } from "../kernel.js";
import type {
  DocumentDossierCandidate,
  DocumentDossierReadyState,
  DocumentDossierSource,
  DocumentDossierState,
} from "./document-dossier-state.js";

const DOSSIER_SOURCES_FRAGMENT = "cr-preview-source-index";

function DossierHeader({ heading, origin, revision }: {
  readonly heading: string;
  readonly origin: string;
  readonly revision: string;
}): JSX.Element {
  return (
    <header className="cr-dossier-header">
      <div><span>{origin}</span><h2 id="cr-dossier-title">{heading}</h2></div>
      <code>{revision}</code>
    </header>
  );
}

function CandidateSource({ candidate, onOpen, source }: {
  readonly candidate: DocumentDossierCandidate;
  readonly onOpen: (sourceId: string) => void;
  readonly source: DocumentDossierSource;
}): JSX.Element {
  return (
    <a data-testid={`cr.preview.decomposition.source.${source.id}-${candidate.id}`}
      href={`#${DOSSIER_SOURCES_FRAGMENT}`} onClick={() => { onOpen(source.id); }}>
      {source.label}
    </a>
  );
}

function sourcesFor(
  candidate: DocumentDossierCandidate,
  sourcesById: ReadonlyMap<string, DocumentDossierSource>,
): readonly DocumentDossierSource[] {
  return candidate.sourceIds.map((sourceId) => {
    const source = sourcesById.get(sourceId);
    if (source === undefined) {
      throw new Error(`CONTROL_ROOM_DOSSIER_SOURCE_MISSING:${candidate.id}:${sourceId}`);
    }
    return source;
  });
}

function CandidateCard({ candidate, onOpenSource, onProvenance, sourcesById }: {
  readonly candidate: DocumentDossierCandidate;
  readonly onOpenSource: (sourceId: string) => void;
  readonly onProvenance: (
    context: string, shown: ShellTruthPresentation, sourceLabels: readonly string[],
  ) => void;
  readonly sourcesById: ReadonlyMap<string, DocumentDossierSource>;
}): JSX.Element {
  const sources = sourcesFor(candidate, sourcesById);
  return (
    <article className="cr-dossier-candidate" data-authority="none"
      data-testid={`cr.preview.decomposition.task.${candidate.id}`}>
      <header>
        <span>Candidate · not submitted</span>
        <TruthChip contextLabel={`Provenance for ${candidate.title}`}
          onProvenance={(shown) => {
            onProvenance(candidate.title, shown, sources.map((source) => source.label));
          }}
          truthClass={candidate.truthClass} />
      </header>
      <h3>{candidate.title}</h3>
      <dl>
        {candidate.role === undefined ? null : <div><dt>Role</dt><dd>{candidate.role}</dd></div>}
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

function ReadyDossier({ state }: { readonly state: DocumentDossierReadyState }): JSX.Element {
  const [openSources, setOpenSources] = useState<ReadonlySet<string>>(() => new Set());
  const [provenance, setProvenance] = useState<{
    readonly context: string;
    readonly shown: ShellTruthPresentation;
    readonly sourceLabels: readonly string[];
  } | null>(null);
  const sourcesById = new Map(state.sources.map((source) => [source.id, source]));
  const showProvenance = (
    context: string, shown: ShellTruthPresentation, sourceLabels: readonly string[] = [],
  ): void => { setProvenance({ context, shown, sourceLabels }); };
  const setSourceOpen = (sourceId: string, open: boolean): void => {
    setOpenSources((current) => {
      if (current.has(sourceId) === open) return current;
      const next = new Set(current);
      if (open) next.add(sourceId); else next.delete(sourceId);
      return next;
    });
  };
  return (
    <>
      <DossierHeader heading={state.heading} origin={state.originLabel}
        revision={state.revisionLabel} />
      <div className="cr-dossier-body">
        <section aria-labelledby="cr-dossier-candidates-title"
          className="cr-dossier-decomposition" data-testid="cr.preview.decomposition">
          <header>
            <div>
              <span>Work candidates / automatic decomposition</span>
              <strong id="cr-dossier-candidates-title">{state.candidateSummaryLabel}</strong>
            </div>
            <TruthChip contextLabel="Provenance for automatic decomposition"
              onProvenance={(shown) => {
                showProvenance("Automatic decomposition", shown,
                  state.sources.map((source) => source.label));
              }} truthClass={state.decompositionTruthClass} />
          </header>
          <div className="cr-dossier-quality" data-testid="cr.preview.decomposition.quality">
            <span>{state.admissionLabel}</span><span>Plan quality</span>
            <TruthChip contextLabel="Provenance for plan quality"
              onProvenance={(shown) => { showProvenance("Plan quality", shown); }}
              truthClass={state.planQualityTruthClass} />
          </div>
          {provenance === null ? null : (
            <aside className="cr-dossier-provenance"
              data-testid="cr.preview.dossier.provenance" role="status">
              <strong>{provenance.context}</strong>
              <span>{provenance.shown.descriptor.truthClass}</span>
              <p>{provenance.shown.descriptor.meaning}</p>
              <p className="cr-dossier-provenance-sources">
                Source references: {provenance.sourceLabels.length === 0
                  ? "none supplied" : provenance.sourceLabels.join(" · ")}
              </p>
              <small>{state.provenanceNote}</small>
            </aside>
          )}
          <p className="cr-dossier-boundary">{state.boundaryText}</p>
          <div className="cr-dossier-candidates">
            {state.candidates.map((candidate) => (
              <CandidateCard candidate={candidate} key={candidate.id}
                onOpenSource={(sourceId) => { setSourceOpen(sourceId, true); }}
                onProvenance={showProvenance} sourcesById={sourcesById} />
            ))}
          </div>
        </section>
        <section aria-labelledby="cr-dossier-sources-title" className="cr-dossier-sources"
          id={DOSSIER_SOURCES_FRAGMENT}>
          <header>
            <span>Source material / lineage</span>
            <strong id="cr-dossier-sources-title">
              {state.sources.length} {state.sources.length === 1 ? "document" : "documents"} indexed
            </strong>
          </header>
          <ol className="cr-dossier-source-list">
            {state.sources.map((source) => (
              <li data-testid={`cr.preview.dossier.source.${source.id}`} key={source.id}>
                <details onToggle={(event) => { setSourceOpen(source.id, event.currentTarget.open); }}
                  open={openSources.has(source.id)}>
                  <summary><span>{source.label}</span><code>{source.path}</code></summary>
                  {source.excerpt === undefined ? null : <p>{source.excerpt}</p>}
                </details>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}

function LoadingDossier(): JSX.Element {
  return (
    <>
      <DossierHeader heading="Project dossier" origin="Document intake" revision="read pending" />
      <div className="cr-dossier-state" role="status">
        <span aria-hidden="true">↳</span>
        <div><strong>Reading project documents</strong>
          <p>Source lineage and proposed work will appear after the document pass answers.</p></div>
      </div>
    </>
  );
}

function ErrorDossier({ code, layer }: { readonly code: string; readonly layer: string }): JSX.Element {
  return (
    <>
      <DossierHeader heading="Project dossier unavailable"
        origin="Document intake · read refused" revision="no result" />
      <div className="cr-dossier-state cr-dossier-state--error" role="alert">
        <span aria-hidden="true">◇</span>
        <div><strong>Document proposal read did not complete.</strong>
          <p><code>{layer}</code> · <code>{code}</code></p></div>
      </div>
    </>
  );
}

export interface DocumentDossierProps {
  readonly state: DocumentDossierState;
}

export function DocumentDossier({ state }: DocumentDossierProps): JSX.Element {
  return (
    <section aria-labelledby="cr-dossier-title" className="cr-dossier"
      data-advisory-only={String(state.advisoryOnly)}
      data-authority={state.authority.toLowerCase()}
      data-state={state.status} data-testid="cr.preview.dossier">
      {state.status === "LOADING" ? <LoadingDossier /> : state.status === "ERROR"
        ? <ErrorDossier code={state.code} layer={state.layer} />
        : <ReadyDossier key={state.dossierIdentity} state={state} />}
    </section>
  );
}
