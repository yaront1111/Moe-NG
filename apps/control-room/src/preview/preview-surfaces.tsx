import type { JSX } from "react";

import { ApprovalJ1 } from "../approvals/approval-j1.js";
import { BoardJ1 } from "../board/board-j1.js";
import { DoctorJ1 } from "../doctor/doctor-j1.js";
import { EvidenceJ1 } from "../evidence/evidence-j1.js";
import { FactWithProvenance } from "../shell/provenance-panel.js";
import { DocumentDossier } from "./document-dossier.js";
import {
  PREVIEW_BOARD_CARDS, PREVIEW_RECEIPT, previewFacts, previewRunFacts,
} from "./preview-data.js";

function SurfaceLead({ eyebrow, summary, title }: {
  readonly eyebrow: string;
  readonly summary: string;
  readonly title: string;
}): JSX.Element {
  return (
    <header className="cr-surface-lead">
      <p>{eyebrow}</p>
      <h1>{title}</h1>
      <span>{summary}</span>
    </header>
  );
}

export function GoalWorkspace(): JSX.Element {
  return (
    <div className="cr-workspace" data-testid="cr.workspace.goal">
      <SurfaceLead
        eyebrow="Project dossier / J1"
        summary="Project sources become traceable work candidates; nothing reaches the board without admission."
        title="Moe reads the project before it plans the work."
      />
      <section aria-label="Goal brief" className="cr-workspace-brief"
        data-testid="cr.surface.goals">
        {previewFacts("goals").map((fact) => (
          <FactWithProvenance fact={fact} key={fact.factId} />
        ))}
      </section>
      <DocumentDossier />
      <BoardJ1 cards={PREVIEW_BOARD_CARDS} facts={previewFacts("board")} />
      <div className="cr-workspace-disclosures">
        <details data-testid="cr.workspace.goalcomposer">
          <summary>
            <span>Describe work without docs</span>
            <small>The one-sentence path remains available when needed</small>
          </summary>
          <div className="cr-preview-unavailable" role="status">
            <span>Preview boundary</span>
            <strong>Attach the daemon to create a goal.</strong>
            <p>This deterministic build never constructs or submits a command.</p>
          </div>
        </details>
        <details data-testid="cr.workspace.evidence">
          <summary>
            <span>Inspect latest evidence</span>
            <small>Receipt, exit code, and exact tree</small>
          </summary>
          <EvidenceJ1 facts={previewFacts("evidence")} receipt={PREVIEW_RECEIPT} />
        </details>
      </div>
    </div>
  );
}

export function ApprovalsWorkspace(): JSX.Element {
  return (
    <div className="cr-workspace cr-workspace--decision">
      <SurfaceLead
        eyebrow="Decision desk"
        summary="Authority stays sparse: inspect the supplied proof, then use only the offered action."
        title="Two clean decisions. No approval theatre."
      />
      <ApprovalJ1 facts={previewFacts("approval")} kinds={["plan", "acceptance"]} />
    </div>
  );
}

export function RunsWorkspace(): JSX.Element {
  return (
    <section aria-label="Runs and leases" className="cr-workspace" data-testid="cr.surface.runs">
      <SurfaceLead
        eyebrow="Active execution"
        summary="Activity and renewal silence remain separate, so quiet work never becomes fake suspicion."
        title="One run crossing the review boundary."
      />
      <article className="cr-run-card">
        <header><span>node-j1</span><strong>Fix the stale-port crash</strong></header>
        {previewRunFacts().map((fact) => (
          <FactWithProvenance fact={fact} key={fact.factId} />
        ))}
      </article>
    </section>
  );
}

export function ResourcesWorkspace(): JSX.Element {
  return (
    <section aria-label="Resources" className="cr-workspace" data-testid="cr.surface.resources">
      <SurfaceLead
        eyebrow="Shared capacity"
        summary="Resources appear when the daemon reports an acquisition or policy declaration."
        title="No shared resources declared."
      />
      <div className="cr-empty-state">
        <span aria-hidden="true">◇</span>
        <p>There is no queue to resolve and no capacity claim to infer.</p>
      </div>
    </section>
  );
}

export function HealthWorkspace(): JSX.Element {
  return (
    <div className="cr-workspace">
      <SurfaceLead
        eyebrow="System integrity"
        summary="Health explains degraded state; it never softens or hides an unreadable record."
        title="The control plane is legible."
      />
      <DoctorJ1 facts={previewFacts("doctor")} />
    </div>
  );
}

export function PolicyWorkspace({ onOpenHealth }: {
  readonly onOpenHealth: () => void;
}): JSX.Element {
  return (
    <section aria-label="Policy" className="cr-workspace" data-testid="cr.surface.policy">
      <SurfaceLead
        eyebrow="Read-only authority"
        summary="Policy editing is outside this surface. Unloaded authority stays visibly unknown."
        title="No policy revision loaded."
      />
      <div className="cr-empty-state">
        <span aria-hidden="true">§</span>
        <p>Load a verified revision through the daemon before relying on policy decisions.</p>
        <button onClick={onOpenHealth} type="button">Open system health</button>
      </div>
    </section>
  );
}

export function TimelineWorkspace(): JSX.Element {
  return (
    <section aria-label="Timeline" className="cr-workspace" data-testid="cr.surface.timeline">
      <SurfaceLead
        eyebrow="Causal ledger"
        summary="This fixture exposes the proof records available now; no missing events are invented."
        title="Two records anchor the current decision."
      />
      <ol className="cr-timeline-preview">
        {previewFacts("evidence").map((fact) => (
          <li key={fact.factId}><FactWithProvenance fact={{ ...fact,
            factId: `timeline.${fact.factId}` }} /></li>
        ))}
      </ol>
    </section>
  );
}
