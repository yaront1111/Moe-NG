import { useEffect, useState } from "react";
import type { JSX } from "react";

import { readDesign } from "../../live/live-design.js";
import type { DesignOutcome, DesignRevisionView } from "../../live/live-design.js";
import { OutcomeNote } from "../components/outcome-note.js";

function TextList({ items }: { readonly items: readonly string[] }): JSX.Element {
  return items.length === 0 ? <p>None recorded.</p>
    : <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul>;
}

/** Five stored sections, plus the decisions still open. Text only, never executable markup. */
function DesignBody({ revision }: { readonly revision: DesignRevisionView }): JSX.Element {
  return (
    <div data-testid="cr.design.body">
      <section>
        <h4 className="cr2-approve-heading">Screens and journeys</h4>
        {revision.screens.length === 0 ? <p>None recorded.</p> : revision.screens.map((journey, index) => (
          <div key={index}><h5>{journey.journey}</h5>
            {journey.screens.map((screen, index) => <div key={index}><p>{screen.screen}</p><TextList items={screen.states} /></div>)}
          </div>
        ))}
      </section>
      <section>
        <h4 className="cr2-approve-heading">Data model</h4>
        {revision.dataModel.length === 0 ? <p>None recorded.</p> : revision.dataModel.map((entity, index) => (
          <div key={index}><h5>{entity.entity}</h5>
            <p>Fields</p><TextList items={entity.fields} />
            <p>Relations</p><TextList items={entity.relations} />
          </div>
        ))}
      </section>
      <section>
        <h4 className="cr2-approve-heading">API surface</h4>
        {revision.apiSurface.length === 0 ? <p>None recorded.</p> : revision.apiSurface.map((route, index) => (
          <div key={index}><p className="cr2-approve-mono">{route.route}</p><pre className="cr2-prd-text">{route.payload}</pre></div>
        ))}
      </section>
      <section><h4 className="cr2-approve-heading">Components</h4><TextList items={revision.componentList} /></section>
      <section>
        <h4 className="cr2-approve-heading">Non-functional decisions</h4>
        <dl><dt>Authentication</dt><dd>{revision.nonFunctional.auth}</dd>
          <dt>Accessibility</dt><dd>{revision.nonFunctional.accessibility}</dd>
          <dt>Performance</dt><dd>{revision.nonFunctional.performance}</dd></dl>
      </section>
      <section><h4 className="cr2-approve-heading">Open decisions</h4><TextList items={revision.openDecisions} /></section>
    </div>
  );
}

function DesignAnswer({ outcome }: { readonly outcome: DesignOutcome | null }): JSX.Element {
  if (outcome === null) return <p className="cr2-slot-kicker" data-testid="cr.design.loading">Reading the design...</p>;
  if (outcome.status !== "DESIGN") {
    return outcome.status === "REFUSED" && outcome.code === "DESIGN_REVISION_ABSENT" && outcome.layer === "LEDGER"
      ? <p className="cr2-needs-note" data-testid="cr.design.none">This goal has no design yet.</p>
      : <OutcomeNote code={outcome.code} layer={outcome.layer} said="The design could not be read right now." testId="cr.design.refusal" />;
  }
  const revision = outcome.record.revision;
  return (
    <>
      <p className="cr2-slot-kicker" data-testid="cr.design.version">{`Version ${String(outcome.record.version)}`}</p>
      {"skipped" in revision
        ? <p className="cr2-needs-note" data-testid="cr.design.none">{`The design step was skipped. ${revision.reason}`}</p>
        : <DesignBody revision={revision} />}
    </>
  );
}

export function DesignCard({ outcome }: { readonly outcome: DesignOutcome | null }): JSX.Element {
  return <section className="cr2-ops-panel" data-testid="cr.design.card" aria-label="Design">
    <h3 className="cr2-approve-heading">Design</h3><DesignAnswer outcome={outcome} />
  </section>;
}

interface LiveDesignProps {
  readonly goalRef: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly read?: ((goalRef: string) => Promise<DesignOutcome>) | undefined;
}

/** Read on mount/subject change; an old goal or session cannot publish a late answer. */
export function LiveDesign(props: LiveDesignProps): JSX.Element {
  const { goalRef, headers, read } = props;
  const [answer, setAnswer] = useState<{ readonly subject: LiveDesignProps; readonly outcome: DesignOutcome } | null>(null);
  useEffect(() => {
    let live = true;
    const publish = (outcome: DesignOutcome): void => { if (live) setAnswer({ subject: { goalRef, headers, read }, outcome }); };
    void Promise.resolve().then(() => read === undefined ? readDesign(headers, goalRef) : read(goalRef)).then(
      publish,
      () => publish({ code: "DESIGN_READ_FAILED", layer: "CONTROL_ROOM_GOALS", status: "ERROR" }),
    );
    return (): void => { live = false; };
  }, [goalRef, headers, read]);
  const current = answer !== null && answer.subject.goalRef === goalRef
    && answer.subject.headers === headers && answer.subject.read === read;
  return <DesignCard outcome={current ? answer.outcome : null} />;
}
