import type {
  DocumentWorkCandidate,
  DocumentWorkProposal,
  DocumentWorkSourceBinding,
} from "@moe/contracts";
import { useState } from "react";
import type { JSX } from "react";

import { TruthChip } from "../kernel.js";
import type { ShellTruthPresentation } from "../kernel.js";
import { DossierHeader } from "./document-dossier-header.js";
import type { DocumentDossierReadyState } from "./document-dossier-state.js";

interface SourceView {
  readonly index: number;
  readonly source: DocumentWorkSourceBinding;
  readonly targetId: string;
}

interface ProvenanceView {
  readonly context: string;
  readonly shown: ShellTruthPresentation;
  readonly sourceBindings: readonly string[];
}

interface LocalView {
  readonly openSources: ReadonlySet<number>;
  readonly proposal: DocumentWorkProposal;
  readonly provenance: ProvenanceView | null;
}

function emptyLocal(proposal: DocumentWorkProposal): LocalView {
  return { openSources: new Set(), proposal, provenance: null };
}

function copyFor(origin: DocumentDossierReadyState["origin"]): {
  readonly boundary: string;
  readonly originLabel: string;
  readonly provenance: string;
} {
  return origin === "FIXTURE" ? {
    boundary: "No daemon attached; no task records were created.",
    originLabel: "Document intake · development fixture",
    provenance: "Fixture proposal · NOT_SUBMITTED · advisory only · authority NONE.",
  } : {
    boundary: "Daemon proposal remains advisory; no task records were created.",
    originLabel: "Document intake · daemon proposal",
    provenance: "Daemon proposal · NOT_SUBMITTED · advisory only · authority NONE.",
  };
}

function CandidateCard({
  candidate, candidateIndex, onOpenSource, onProvenance, sourceViews, truthClass,
}: {
  readonly candidate: DocumentWorkCandidate;
  readonly candidateIndex: number;
  readonly onOpenSource: (source: SourceView) => void;
  readonly onProvenance: (context: string, shown: ShellTruthPresentation,
    bindings: readonly string[]) => void;
  readonly sourceViews: readonly SourceView[];
  readonly truthClass: unknown;
}): JSX.Element {
  return (
    <article className="cr-dossier-candidate" data-authority="none"
      data-testid={`cr.preview.decomposition.task.${candidateIndex}`}>
      <header>
        <span>Candidate · not submitted</span>
        <TruthChip contextLabel={`Provenance for ${candidate.title}`}
          onProvenance={(shown) => { onProvenance(candidate.title, shown,
            sourceViews.map(({ source }) => `${source.sourceRef} · ${source.displayPath}`)); }}
          truthClass={truthClass} />
      </header>
      <h3>{candidate.title}</h3>
      <p className="cr-dossier-objective cr-dossier-token">{candidate.objective}</p>
      <nav aria-label={`Source bindings for ${candidate.title}`}>
        <span>Source bindings</span>
        {sourceViews.map((view, sourceIndex) => (
          <a aria-controls={view.targetId}
            data-testid={`cr.preview.decomposition.source.${candidateIndex}.${sourceIndex}`}
            href={`#${view.targetId}`} key={view.source.sourceRef}
            onClick={() => { onOpenSource(view); }}>
            <span>{view.source.displayPath}</span><code>{view.source.sourceRef}</code>
          </a>
        ))}
      </nav>
    </article>
  );
}

function ProposalMetadata({ proposal }: { readonly proposal: DocumentWorkProposal }): JSX.Element {
  return (
    <dl className="cr-dossier-metadata">
      {([
        ["project", "Project", proposal.projectId],
        ["schema", "Schema", proposal.schemaVersion],
        ["repository", "Repository hash", proposal.repositoryBaseHash],
        ["context", "Context manifest", proposal.contextManifestDigest],
      ] as const).map(([key, label, value]) => (
        <div data-testid={`cr.preview.dossier.meta.${key}`} key={key}>
          <dt>{label}</dt><dd><code className="cr-dossier-token" title={value}>{value}</code></dd>
        </div>
      ))}
    </dl>
  );
}

export function ReadyDossier({ idBase, state, titleId }: {
  readonly idBase: string;
  readonly state: DocumentDossierReadyState;
  readonly titleId: string;
}): JSX.Element {
  const { proposal } = state;
  const copy = copyFor(state.origin);
  const [local, setLocal] = useState<LocalView>(() => emptyLocal(proposal));
  const shownLocal = local.proposal === proposal ? local : emptyLocal(proposal);
  const sourceViews: readonly SourceView[] = proposal.sources.map((source, index) => ({
    index, source, targetId: `${idBase}-source-${index}`,
  }));
  const sourcesByRef = new Map(sourceViews.map((view) => [view.source.sourceRef, view]));
  const updateLocal = (update: (current: LocalView) => LocalView): void => {
    setLocal((current) => update(current.proposal === proposal ? current : emptyLocal(proposal)));
  };
  const setSourceOpen = (source: SourceView, open: boolean): void => {
    updateLocal((current) => {
      if (current.openSources.has(source.index) === open) return current;
      const next = new Set(current.openSources);
      if (open) next.add(source.index); else next.delete(source.index);
      return { ...current, openSources: next };
    });
  };
  const showProvenance = (context: string, shown: ShellTruthPresentation,
    sourceBindings: readonly string[]): void => {
    updateLocal((current) => ({ ...current, provenance: { context, shown, sourceBindings } }));
  };
  const candidateCount = proposal.candidates.length;
  return (
    <>
      <DossierHeader heading="Document work proposal" origin={copy.originLabel}
        revision={proposal.schemaVersion} titleId={titleId} />
      <ProposalMetadata proposal={proposal} />
      <div className="cr-dossier-body">
        <section aria-labelledby={`${idBase}-candidates-title`}
          className="cr-dossier-decomposition" data-testid="cr.preview.decomposition">
          <header><div><span>Work candidates / automatic decomposition</span>
            <strong id={`${idBase}-candidates-title`}>{candidateCount} document-derived {
              candidateCount === 1 ? "candidate" : "candidates"} · not submitted</strong></div>
            <TruthChip contextLabel="Provenance for automatic decomposition"
              onProvenance={(shown) => { showProvenance("Automatic decomposition", shown,
                sourceViews.map(({ source }) => `${source.sourceRef} · ${source.displayPath}`)); }}
              truthClass={proposal.truthClass} /></header>
          <div className="cr-dossier-quality" data-testid="cr.preview.decomposition.quality">
            <span>NOT_SUBMITTED · advisory only · authority NONE</span>
            <span>Proposal truth</span>
            <TruthChip contextLabel="Provenance for proposal truth"
              onProvenance={(shown) => { showProvenance("Proposal truth", shown, []); }}
              truthClass={proposal.truthClass} />
          </div>
          {shownLocal.provenance === null ? null : (
            <aside className="cr-dossier-provenance"
              data-testid="cr.preview.dossier.provenance" role="status">
              <strong>{shownLocal.provenance.context}</strong>
              <span>{shownLocal.provenance.shown.descriptor.truthClass}</span>
              <p>{shownLocal.provenance.shown.descriptor.meaning}</p>
              <dl><div><dt>Truth input origin</dt>
                <dd data-testid="cr.preview.dossier.truth-origin">
                  {shownLocal.provenance.shown.origin}</dd></div>
                <div><dt>Truth provenance note</dt>
                  <dd data-testid="cr.preview.dossier.truth-note">
                    {shownLocal.provenance.shown.provenanceNote}</dd></div></dl>
              <p className="cr-dossier-provenance-sources">Source bindings: {
                shownLocal.provenance.sourceBindings.length === 0 ? "none supplied"
                  : shownLocal.provenance.sourceBindings.join(" · ")}</p>
              <small>{copy.provenance}</small>
            </aside>
          )}
          <p className="cr-dossier-boundary">{copy.boundary}</p>
          <div className="cr-dossier-candidates">
            {proposal.candidates.map((candidate, candidateIndex) => (
              <CandidateCard candidate={candidate} candidateIndex={candidateIndex}
                key={candidate.candidateRef} onOpenSource={(view) => { setSourceOpen(view, true); }}
                onProvenance={showProvenance} sourceViews={candidate.sourceRefs
                  .map((sourceRef) => sourcesByRef.get(sourceRef))
                  .filter((view): view is SourceView => view !== undefined)}
                truthClass={proposal.truthClass} />
            ))}
          </div>
        </section>
        <section aria-labelledby={`${idBase}-sources-title`} className="cr-dossier-sources">
          <header><span>Source material / lineage</span>
            <strong id={`${idBase}-sources-title`}>{sourceViews.length} {
              sourceViews.length === 1 ? "document" : "documents"} indexed</strong></header>
          <ol className="cr-dossier-source-list">
            {sourceViews.map((view) => (
              <li data-testid={`cr.preview.dossier.source.${view.index}`} key={view.source.sourceRef}>
                <details id={view.targetId}
                  onToggle={(event) => { setSourceOpen(view, event.currentTarget.open); }}
                  open={shownLocal.openSources.has(view.index)}>
                  <summary><span>{view.source.displayPath}</span>
                    <code className="cr-dossier-token">{view.source.sourceRef}</code></summary>
                  <dl className="cr-dossier-source-evidence">
                    <div><dt>Content SHA-256</dt><dd><code className="cr-dossier-token">
                      {view.source.contentSha256}</code></dd></div>
                    <div><dt>Byte length</dt><dd>{view.source.byteLength} bytes</dd></div>
                  </dl>
                </details>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}
