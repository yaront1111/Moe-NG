import type { JSX } from "react";

export function DossierHeader({ heading, origin, revision, titleId }: {
  readonly heading: string;
  readonly origin: string;
  readonly revision: string;
  readonly titleId: string;
}): JSX.Element {
  return (
    <header className="cr-dossier-header">
      <div><span>{origin}</span><h2 id={titleId}>{heading}</h2></div>
      <code className="cr-dossier-token">{revision}</code>
    </header>
  );
}
