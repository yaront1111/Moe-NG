import type { JSX, ReactNode } from "react";
import type { ProductArtifact as Artifact } from "@moe/control-room-model";
import type { GoalSourceOutcome } from "../../live/live-goal-source.js";
import type { DesignOutcome } from "../../live/live-design.js";
import { previewCaptureUrl } from "../../live/live-preview.js";
import type { PreviewReadOutcome } from "../../live/live-preview.js";
import type { ReleaseOutcome } from "../../live/live-release.js";
import { DesignCard } from "../goals/design-card.js";
import { productArtifactPayloadMatches } from "./product-artifact-identity.js";

interface Props {
  readonly artifact: Artifact | null;
  readonly source: GoalSourceOutcome | null;
  readonly design: DesignOutcome | null;
  readonly preview: PreviewReadOutcome | null;
  readonly release: ReleaseOutcome | null;
  readonly definition: ReactNode;
}

/** Generated apps open on their own origin. The operator session never enters an iframe. */
function safeLink(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.username === "" && url.password === "" ? url.href : null;
  } catch { return null; }
}

export function ProductArtifact({ artifact, source, design, preview, release, definition }: Props): JSX.Element {
  if (artifact === null || artifact.kind === "DEFINITION") return <div className="cr-product-definition">{definition}</div>;
  if (artifact.kind !== "BUILD" && !productArtifactPayloadMatches(artifact, { source, design, preview, release })
    || artifact.kind === "BUILD" && artifact.availability !== "PRESENT" && artifact.availability !== "STALE") {
    return <div className="cr-product-empty"><p className="cr-product-kind">{artifact.title}</p>
      <h2>This artifact cannot be read right now</h2><p>The available record does not establish this selected version&apos;s contents. Refresh or choose another artifact.</p>
    </div>;
  }
  if (artifact.kind === "SOURCE" && source?.status === "GOAL_SOURCE") return <article className="cr-product-source">
    <header><p className="cr-product-kind">Original PRD</p><h2>{source.displayPath}</h2>
      <p>The specification you gave Moe.</p></header>
    <pre>{source.text}</pre><details><summary>Source identity</summary><code>{source.contentSha256}</code></details>
  </article>;
  if (artifact.kind === "DESIGN" && design?.status === "DESIGN") return <div className="cr-product-design">
    <p className="cr-product-kind">Authored design</p><p>The build plan records which design version it uses.</p><DesignCard outcome={design} />
  </div>;
  if (artifact.kind === "PREVIEW" && preview?.status === "PREVIEW") {
    const record = preview.preview, url = safeLink(record.url);
    return <article className="cr-product-preview">
      <header><div><p className="cr-product-kind">Captured product preview</p><h2>Your product, taking shape</h2></div>
        {url === null ? null : <a className="cr2-btn" data-variant="primary" href={url} target="_blank" rel="noreferrer noopener">Open preview</a>}</header>
      <p className="cr-product-note">Preview record dated {record.decidedAt}. The preview link may need restarting; a capture does not establish current availability.</p>
      {record.screenshots.length === 0 ? <div className="cr-product-empty"><h3>No captured screens</h3><p>This preview has no saved images.</p></div>
        : record.screenshots.map((shot) => {
          const src = previewCaptureUrl(record, shot);
          return src === null ? null : <figure key={shot.path}><img alt={`Product capture: ${shot.journeyRef}`} src={src} /><figcaption>{shot.journeyRef}</figcaption></figure>;
        })}
      <details><summary>Version identity</summary><code>{record.sha}</code><p>{record.receiptId}</p></details>
    </article>;
  }
  if (artifact.kind === "RELEASE" && release?.status === "PRESENT" && release.evidence.receipt?.outcome === "RELEASED") {
    const receipt = release.evidence.receipt, url = safeLink(receipt.prUrl);
    return <article className="cr-product-delivery"><p className="cr-product-kind">Released source</p><h2>A version ready for delivery</h2>
      <p>The release record identifies the source version below. Environment deployment is recorded separately.</p>
      {url === null ? null : <a className="cr2-btn" data-variant="primary" href={url} target="_blank" rel="noreferrer noopener">Open pull request</a>}
      <details open><summary>Released version</summary><code>{receipt.sha}</code></details>
    </article>;
  }
  return <div className="cr-product-empty"><p className="cr-product-kind">{artifact.title}</p><h2>Implementation recorded</h2>
    <p>Open Readiness to inspect this version&apos;s applicable checks. A runnable preview is shown when one is recorded.</p>
    {artifact.sha === null ? null : <details><summary>Version identity</summary><code>{artifact.sha}</code></details>}
  </div>;
}
