import { useId } from "react";
import type { JSX } from "react";

import { DossierHeader } from "./document-dossier-header.js";
import { ReadyDossier } from "./document-dossier-ready.js";
import type { DocumentDossierState } from "./document-dossier-state.js";

function LoadingDossier({ titleId }: { readonly titleId: string }): JSX.Element {
  return (
    <>
      <DossierHeader heading="Project dossier" origin="Document intake" revision="read pending"
        titleId={titleId} />
      <div className="cr-dossier-state" role="status">
        <span aria-hidden="true">↳</span>
        <div><strong>Reading project documents</strong>
          <p>Source lineage and proposed work will appear after the document pass answers.</p></div>
      </div>
    </>
  );
}

function ErrorDossier({ code, layer, titleId }: {
  readonly code: string;
  readonly layer: string;
  readonly titleId: string;
}): JSX.Element {
  return (
    <>
      <DossierHeader heading="Project dossier unavailable"
        origin="Document intake · read refused" revision="no result" titleId={titleId} />
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
  const reactId = useId();
  const idBase = `cr-dossier-${reactId.replace(/[^a-zA-Z0-9_-]/gu, "")}`;
  const titleId = `${idBase}-title`;
  const advisoryOnly = state.status === "READY"
    ? state.proposal.advisoryOnly : state.advisoryOnly;
  const authority = state.status === "READY" ? state.proposal.authority : state.authority;
  return (
    <section aria-labelledby={titleId} className="cr-dossier"
      data-advisory-only={String(advisoryOnly)} data-authority={authority.toLowerCase()}
      data-state={state.status} data-testid="cr.preview.dossier">
      {state.status === "LOADING" ? <LoadingDossier titleId={titleId} />
        : state.status === "ERROR"
          ? <ErrorDossier code={state.code} layer={state.layer} titleId={titleId} />
          : <ReadyDossier idBase={idBase} key={`${state.origin}:${state.dossierIdentity}`}
              state={state} titleId={titleId} />}
    </section>
  );
}
