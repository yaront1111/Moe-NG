import { useEffect, useId, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import type { ProductArtifact as Artifact } from "@moe/control-room-model";
import type { ProductWorkspaceModel } from "./product-model-adapter.js";
import type { ProductInspector } from "./product-query.js";
import { ProductRequirements } from "./product-requirements.js";
import "./product-workspace.css";

export interface ProductWorkspaceProps {
  readonly title: string;
  readonly model: ProductWorkspaceModel;
  readonly inspector: ProductInspector | null;
  readonly onInspect: (inspector: ProductInspector | null) => void;
  readonly onSelect: (artifactId: string) => void;
  readonly onRefresh: () => void;
  readonly renderArtifact: (artifact: Artifact | null) => ReactNode;
  readonly records: Readonly<Record<"Definition" | "Build plan" | "Checks" | "Delivery" | "Technical detail", ReactNode>>;
  readonly fixture?: boolean;
  readonly observationNote?: string | null;
  /** Session and viewed/current version identity; navigation within this scope preserves pending actions. */
  readonly recordScopeKey?: string;
  /** Unavailable current scope keeps visited records mounted, inert and disabled for reconciliation. */
  readonly recordBlocked?: ReactNode;
}

export function ProductWorkspace(props: ProductWorkspaceProps): JSX.Element {
  const { model, title, inspector, onInspect, onSelect, onRefresh, renderArtifact, records } = props;
  const [record, setRecord] = useState<keyof typeof records>("Build plan");
  const artifact = model.selection.artifact;
  const recordScopeKey = props.recordScopeKey ?? JSON.stringify([artifact?.scope, model.selection.selectedId]);
  const [visited, setVisited] = useState<{ key: string; tabs: readonly (keyof typeof records)[] }>({ key: recordScopeKey, tabs: [] });
  const retained = visited.key === recordScopeKey ? visited.tabs : [];
  const blocked = props.recordBlocked != null;
  const panels = !blocked && inspector === "record" && !retained.includes(record) ? [...retained, record] : retained;
  useEffect(() => {
    setVisited((previous) => {
      const tabs = previous.key === recordScopeKey ? previous.tabs : [];
      if (!blocked && inspector === "record" && !tabs.includes(record)) return { key: recordScopeKey, tabs: [...tabs, record] };
      return previous.key === recordScopeKey ? previous : { key: recordScopeKey, tabs };
    });
  }, [recordScopeKey, inspector, record, blocked]);
  const id = useId();
  const inspectorRef = useRef<HTMLElement>(null);
  const buttons = useRef<Partial<Record<ProductInspector, HTMLButtonElement | null>>>({});
  const previous = useRef<ProductInspector | null>(inspector);
  useEffect(() => {
    if (inspector !== null) inspectorRef.current?.focus();
    else if (previous.current !== null) buttons.current[previous.current]?.focus();
    previous.current = inspector;
  }, [inspector]);
  return <section className="cr-product-workspace" data-testid="cr.product.workspace" aria-label={`${title} product workspace`}>
    {props.fixture ? <p className="cr-product-fixture">Example product. These states demonstrate the experience and do not dispatch work.</p> : null}
    {props.observationNote ? <p className="cr-product-note" role="status">{props.observationNote}</p> : null}
    <div className="cr-product-toolbar">
      <button className="cr-product-current" type="button" aria-pressed={inspector === null} onClick={() => onInspect(null)}>Product</button>
      <div className="cr-product-inspect-buttons">
        {(["requirements", "readiness", "record"] as const).map((item) => <button type="button" key={item}
          ref={(element) => { buttons.current[item] = element; }}
          aria-expanded={inspector === item} aria-controls={`${id}-inspector`}
          onClick={() => onInspect(inspector === item ? null : item)}>
          {item === "requirements" ? "Requirements" : item === "readiness" ? "Readiness" : "Production record"}
        </button>)}
      </div>
    </div>
    <div className="cr-product-versionbar">
      <label>Viewing <select aria-label="Viewed product artifact" value={model.selection.selectedId ?? ""}
        onChange={(event) => onSelect(event.target.value)}>
        {model.artifacts.length === 0 ? <option value="">Product definition</option> : null}
        {model.selection.status === "UNAVAILABLE" && !model.artifacts.some((row) => row.id === model.selection.selectedId)
          ? <option value={model.selection.selectedId ?? ""}>Previously selected version (unavailable)</option> : null}
        {model.artifacts.map((row) => <option value={row.id} key={row.id}>{row.title}</option>)}
      </select></label>
      <span>{model.deliveryNote}</span>
      <button type="button" onClick={onRefresh} aria-label="Refresh product status">Refresh</button>
    </div>
    <div className="cr-product-layout" data-inspector={inspector === null ? "closed" : "open"}>
      <section className="cr-product-canvas" aria-label="Product artifact">
        {model.selection.status === "UNAVAILABLE" ? <div className="cr-product-empty" role="status">
          <h2>This version cannot be read right now</h2><p>Your selection is preserved. Refresh, or choose a different recorded artifact.</p>
        </div> : renderArtifact(artifact)}
      </section>
      <aside hidden={inspector === null} inert={inspector === null} className="cr-product-inspector" id={`${id}-inspector`} ref={inspectorRef} tabIndex={-1}
        aria-label={inspector === "record" ? "Production record" : inspector === "requirements" ? "Requirements" : "Readiness"}
        onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onInspect(null); } }}>
        <button className="cr-product-close" type="button" onClick={() => onInspect(null)} aria-label="Close product inspector">Close</button>
        {inspector === "requirements" ? <ProductRequirements requirements={model.requirements} note={model.scopeNote} /> : null}
        {inspector === "readiness" ? <section><h2>Is this version ready?</h2>
            <p className="cr-product-readiness" data-state={model.readiness.state}>{model.readiness.label}</p>
            <p>These checks apply to the selected version. Approval and delivery are separate decisions.</p>
            <ProductRequirements requirements={model.requirements} note={model.scopeNote} />
            <button type="button" onClick={() => { setRecord("Checks"); onInspect("record"); }}>Inspect checks</button>
            <button type="button" onClick={() => { setRecord("Delivery"); onInspect("record"); }}>Review delivery</button>
          </section> : null}
        <section hidden={inspector !== "record"} inert={inspector !== "record"}><h2>How this product is being made</h2>
            <div className="cr-product-record-nav" aria-label="Production records">
              {(Object.keys(records) as (keyof typeof records)[]).map((key) => <button type="button" key={key}
                aria-pressed={record === key} onClick={() => setRecord(key)}>{key}</button>)}
            </div>{props.recordBlocked}<div key={recordScopeKey} className="cr-product-record">{panels.map((name) =>
              <div key={name} hidden={blocked || record !== name || inspector !== "record"} inert={blocked || record !== name || inspector !== "record"}>
                <fieldset disabled={blocked} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>{records[name]}</fieldset>
              </div>)}</div>
          </section>
      </aside>
    </div>
  </section>;
}
