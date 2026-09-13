import type { JSX } from "react";
import type { BoardRoute } from "../../shell/shell-routes.js";
import type { ProductQuery } from "../product-query.js";
import type { ProductArtifact as Artifact } from "@moe/control-room-model";
import { ProductArtifact } from "../product-artifact.js";
import { ProductWorkspace } from "../product-workspace.js";
import { productArtifacts } from "../product-model-artifacts.js";
import { createFixtureProductModel, exampleDesign, exampleRelease, EXAMPLE_SOURCE } from "./fixture-product-data.js";
import "./fixture-product-workspace.css";

export interface FixtureProductWorkspaceProps {
  readonly route: BoardRoute;
  readonly query: ProductQuery;
  readonly update: (query: ProductQuery, replace?: boolean) => void;
}

const scenarios = [
  { label: "Requirements and design", artifactId: "example:source", inspector: null },
  { label: "Failed check", artifactId: "example:build:failed", inspector: "readiness" },
  { label: "Corrected candidate", artifactId: "example:build:corrected", inspector: "readiness" },
  { label: "Scope change", artifactId: "example:scope", inspector: "requirements" },
] as const;

export function FixtureProductWorkspace({ route, query, update }: FixtureProductWorkspaceProps): JSX.Element {
  const model = createFixtureProductModel(route.goalId, query.artifactId);
  // Example query aliases remain readable; the shared canvas receives identities derived from its actual payloads.
  const concreteArtifacts = model.selection.artifact === null ? [] : productArtifacts({ scope: model.selection.artifact.scope,
    goalRef: route.goalId, planningRunRef: null, source: EXAMPLE_SOURCE, design: exampleDesign(route.goalId),
    preview: null, release: exampleRelease(route.goalId), coverage: null, criteria: null }, null, null);
  const proposed = model.selection.artifact?.id === "example:scope";
  const definition = <article><p className="cr-product-kind">{proposed ? "Proposed scope change" : "Approved definition"}</p>
    <h2>{proposed ? "Add payments to appointments" : "A clear appointment request, from customer to shop"}</h2>
    <p>Customers describe their repair and request a date. The shop reviews the request and confirms a suitable time.</p>
    <p>{proposed ? "Online payments would add payment collection and confirmation. This proposal does not change the approved appointment release."
      : "Online payment is excluded. The selected date must remain unchanged, including near midnight."}</p>
  </article>;
  const renderArtifact = (artifact: Artifact | null): JSX.Element => artifact?.kind === "BUILD"
    ? <article><p className="cr-product-kind">Recorded implementation output</p>
      <h2>{artifact.title}</h2><p>This is an example of the product&apos;s response text. It is not a running preview.</p>
      <pre className="cr-example-output">{artifact.id === "example:build:failed"
        ? "Requested date: 14 September\nStored date: 13 September\nCheck result: the date changed near midnight"
        : "Requested date: 14 September\nStored date: 14 September\nRequest received. The shop will email you to confirm a time."}</pre>
      <p>Inspect Readiness to follow the exact candidate&apos;s checks.</p></article>
    : <ProductArtifact artifact={concreteArtifacts.find((item) => item.kind === artifact?.kind) ?? artifact} source={EXAMPLE_SOURCE} design={exampleDesign(route.goalId)}
      preview={null} release={exampleRelease(route.goalId)} definition={definition} />;
  return <>
    <div className="cr-example-scenarios" role="group" aria-label="Example product scenarios">
      <span>Explore the example</span>{scenarios.map((scenario) => <button type="button" key={scenario.artifactId}
        aria-pressed={model.selection.selectedId === scenario.artifactId}
        onClick={() => update({ goalId: route.goalId, artifactId: scenario.artifactId, inspector: scenario.inspector })}>
        {scenario.label}</button>)}
    </div>
    <ProductWorkspace fixture title={route.title} model={model} inspector={query.inspector}
      onInspect={(inspector) => update({ ...query, inspector })}
      onSelect={(artifactId) => update({ ...query, artifactId })}
      onRefresh={() => update({ ...query }, true)} renderArtifact={renderArtifact}
      records={{ Definition: definition,
        "Build plan": <section><h3>Appointment product work</h3><ol><li>Receive repair requests</li>
          <li>Keep local calendar dates intact</li><li>Let the shop confirm an appointment</li></ol></section>,
        Checks: <section><h3>A correction with a recorded result</h3><p>The first candidate changed a date near midnight.
          Its corrected successor preserves that date. Select either candidate to inspect its own results.</p>
          <p>No captured preview is available in this example. No screen image or current runtime availability is asserted.</p></section>,
        Delivery: <section><h3>The appointment release stays available</h3><p>The released source is the corrected appointment candidate.
          It excludes payments. The proposed payment scope has no inherited approval or release.</p>
          <p>No environment deployment is recorded.</p></section>,
        "Technical detail": <section><h3>Example identity</h3><p>All records on this page are local fixtures.</p>
          <dl><dt>Product subject</dt><dd>{route.goalId}</dd><dt>Artifact</dt><dd>{model.selection.selectedId}</dd></dl></section>,
      }} />
  </>;
}
