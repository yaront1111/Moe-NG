import { useState } from "react";
import type { JSX } from "react";

import "../styles/control-room.css";
import { CONTROL_ROOM_FIXTURE_KIND } from "../fixtures.js";
import { NodeInspectorJ1 } from "../nodes/node-inspector-j1.js";
import { ShellFrame } from "../shell/frame.js";
import type { NavLabel } from "../shell/nav-rail.js";
import {
  PREVIEW_CONTEXT, previewAffordance, previewFacts,
} from "./preview-data.js";
import {
  ApprovalsWorkspace, GoalWorkspace, HealthWorkspace, PolicyWorkspace,
  ResourcesWorkspace, RunsWorkspace, TimelineWorkspace,
} from "./preview-surfaces.js";

function ActiveWorkspace({ active, onNavigate }: {
  readonly active: NavLabel;
  readonly onNavigate: (label: NavLabel) => void;
}): JSX.Element {
  switch (active) {
    case "Approvals": return <ApprovalsWorkspace />;
    case "Goals": return <GoalWorkspace />;
    case "Health": return <HealthWorkspace />;
    case "Policy": return <PolicyWorkspace onOpenHealth={() => { onNavigate("Health"); }} />;
    case "Resources": return <ResourcesWorkspace />;
    case "Runs & leases": return <RunsWorkspace />;
  }
}

function PreviewInspector({ active }: { readonly active: NavLabel }): JSX.Element {
  const showsReferenceNode = active === "Goals" || active === "Runs & leases";
  return (
    <div className="cr-preview-inspector">
      <div className="cr-preview-mode" data-testid="cr.preview.mode">
        <span>Development fixture</span>
        <strong>No live authority attached</strong>
        <code>{CONTROL_ROOM_FIXTURE_KIND}</code>
      </div>
      {showsReferenceNode ? (
        <>
          <div className="cr-inspector-section-label">Reference node / node-j1</div>
          <NodeInspectorJ1 facts={previewFacts("node")} nodeId="node-j1" />
        </>
      ) : (
        <div className="cr-inspector-empty" data-testid="cr.preview.inspector.empty">
          <span>Proof lens</span>
          <strong>No claim focused</strong>
          <p>Select a truth chip in this workspace to inspect its supplied provenance.</p>
        </div>
      )}
      <div className="cr-inspector-hint">
        <kbd>p</kbd><span>Open provenance from a focused truth chip</span>
      </div>
    </div>
  );
}

/**
 * Browser entry for the deterministic fixture build.
 *
 * This composes presentation-only surfaces around the same fixture and affordance
 * contracts the tests exercise. It does not attach a daemon, construct a command,
 * infer a lifecycle, or grant the preview authority beyond its supplied command set.
 */
export function ControlRoomPreview(): JSX.Element {
  const [active, setActive] = useState<NavLabel>("Goals");
  const context = PREVIEW_CONTEXT[active];
  return (
    <ShellFrame
      activeNavItem={active}
      affordance={previewAffordance()}
      contextEyebrow={context.eyebrow}
      contextTitle={context.title}
      inspector={<PreviewInspector active={active} />}
      onNavigate={setActive}
      projectionEnabled={active === "Goals"}
      timeline={<TimelineWorkspace />}
    >
      <ActiveWorkspace active={active} onNavigate={setActive} />
    </ShellFrame>
  );
}
