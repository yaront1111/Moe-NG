import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import type { LiveSetup } from "../../live/live-config.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { readPlanningRun } from "../../live/live-planning-run.js";
import { readProductContractGate1 } from "../../live/live-product-contract-gate-1.js";
import { ApprovePlan } from "../goals/approve-plan.js";
import { authorizeApproval, createPlanApprovalPort } from "../goals/plan-approval.js";
import { planReviewObservationKey } from "../goals/plan-review-observation.js";
import { currentRunOf, planSentBack } from "../goals/plan-run-resolution.js";
import { LiveDesignVersionNote } from "../goals/design-version-note.js";
import { CriterionEvidenceCard } from "../goals/criterion-evidence-card.js";
import { createCriterionEvidencePort } from "../goals/criterion-evidence-port.js";
import { LiveGoalRelease } from "../goals/live-goal-release.js";
import { LiveGoalDeployments } from "../goals/live-goal-deployments.js";
import { LiveGoalEnvironments } from "../goals/goal-environments.js";
import { ContractDossier } from "../goals/contract-dossier.js";
import { useContractGates } from "../goals/contract-gates.js";
import { LiveBoard } from "../board/board-screen.js";
import { LiveWorkBoard } from "../goals/live-work-board.js";
import { createPublishPort } from "../goals/publish-port.js";
import { ProductWorkspace } from "./product-workspace.js";
import { ProductArtifact } from "./product-artifact.js";
import { LiveProductDefinition } from "./live-product-definition.js";
import { reconcileProductArtifactHistory, selectProductArtifactHistory } from "./product-artifact-history.js";
import type { ProductArtifactHistory } from "./product-artifact-history.js";
import { productActionContext } from "./product-action-context.js";
import { useProductReads } from "./use-product-reads.js";
import { useWorkspaceSurface } from "./use-workspace-surface.js";
import type { ProductQuery, UpdateProductQuery } from "./product-query.js";
import type { BoardRoute } from "../shell/shell-routes.js";

export function LiveProductWorkspace({ setup, route, query, update, onBack, onNeedsYou, onConnection }: {
  readonly setup: LiveSetup; readonly route: BoardRoute; readonly query: ProductQuery;
  readonly update: UpdateProductQuery;
  readonly onBack: () => void; readonly onNeedsYou: () => void;
  readonly onConnection: (connection: SurfaceFrame["connection"]) => void;
}): JSX.Element {
  const frame = useWorkspaceSurface(setup.headers, route.goalId, onConnection);
  const runId = currentRunOf(frame, route.goalId, route.planningRunRef);
  const reads = useProductReads(setup, route.goalId, runId);
  const [readRevision, setReadRevision] = useState(0);
  const scope = useMemo(() => ({ connectionId: crypto.randomUUID(), projectId: setup.projectId ?? "",
    goalId: route.goalId, plane: setup.commandAuthorityPlane }), [setup, route.goalId]);
  const history = useRef<ProductArtifactHistory | null>(null);
  const input = useMemo(() => ({ scope, goalRef: route.goalId, planningRunRef: runId || null,
    source: reads.source, design: reads.design, coverage: reads.coverage, criteria: reads.criteria,
    preview: reads.preview, release: reads.release, viewedContractRef: reads.definitionRef,
    availableDefinitionRef: reads.definitionRef, selectedArtifactId: query.artifactId }),
  [scope, route.goalId, runId, reads.source, reads.design, reads.coverage, reads.criteria, reads.preview, reads.release, reads.definitionRef, query.artifactId]);
  const observed = useMemo(() => {
    history.current = reconcileProductArtifactHistory(history.current, input, new Date().toISOString());
    return selectProductArtifactHistory(history.current, input);
  }, [input]);
  const model = observed.model;
  const context = productActionContext(input, model, observed.historical);
  // Pin the first complete observation. Polling never silently switches the viewed artifact.
  const initial = useRef<string | null>(null);
  useEffect(() => {
    if (initial.current === scope.connectionId || query.artifactId !== null || reads.definition === null || reads.source === null || reads.design === null
      || reads.preview === null || reads.criteria === null || reads.release === null || model.selection.selectedId === null) return;
    initial.current = scope.connectionId;
    const artifactId = model.selection.selectedId;
    update(current => current?.goalId === query.goalId && current.artifactId === null
      ? { ...current, artifactId } : current, true);
  }, [scope.connectionId, model.selection.selectedId, query, reads.definition, reads.source, reads.design, reads.preview, reads.criteria, reads.release, update]);
  const readRun = useMemo(() => (id: string) => readPlanningRun(setup.headers, id), [setup]);
  const planPort = useMemo(() => createPlanApprovalPort(setup), [setup]);
  const approval = useMemo(() => ({ authorization: authorizeApproval(frame, runId),
    sentBack: planSentBack(frame, route.goalId, route.planningRunRef), submit: planPort.submit }),
  [frame, runId, route.goalId, route.planningRunRef, planPort]);
  const planObservationKey = JSON.stringify([planReviewObservationKey(approval.authorization, runId), readRevision]);
  const criterionPort = useMemo(() => createCriterionEvidencePort(setup), [setup]);
  const readGate = useMemo(() => (ref: Parameters<typeof readProductContractGate1>[1]) => readProductContractGate1(setup.headers, ref), [setup]);
  // Only this exact compiled/viewed contract may reach the old dossier renderer.
  const scopedCoverage = reads.coverage?.status === "COVERAGE" && model.contractRef !== null ? { ...reads.coverage,
    contracts: reads.coverage.contracts.filter((item) => item.plane === model.contractRef?.plane
      && item.contractId === model.contractRef.contractId && item.revisionId === model.contractRef.revisionId
      && item.revisionDigest === model.contractRef.revisionDigest) } : null;
  const gates = useContractGates(scopedCoverage, readGate);
  const recordSubject = JSON.stringify([scope.connectionId, route.goalId, runId, model.selection.selectedId]);
  const recordBinding = useRef({ subject: recordSubject, contractRef: context.contractRef, candidateSha: context.candidateSha });
  // A failed observation is not a changed candidate. Keep in-flight records until an actual identity change.
  if (recordBinding.current.subject !== recordSubject || context.contractRef !== null) {
    recordBinding.current = { subject: recordSubject, contractRef: context.contractRef, candidateSha: context.candidateSha };
  }
  const recordKey = JSON.stringify([recordSubject, recordBinding.current.contractRef, recordBinding.current.candidateSha]);
  const recordsAvailable = context.allowCurrentControls
    && (recordBinding.current.contractRef === null || context.contractRef !== null);
  const lastAvailableRecord = useRef<string | null>(null);
  if (recordsAvailable) lastAvailableRecord.current = recordKey;
  const retainRecords = recordsAvailable || lastAvailableRecord.current === recordKey;
  const currentDefinitionRef = model.selection.artifact?.contractRef ?? reads.definitionRef ?? null;
  const retainedDefinition = useRef({ key: recordKey, ref: currentDefinitionRef });
  if (retainedDefinition.current.key !== recordKey || currentDefinitionRef !== null) {
    retainedDefinition.current = { key: recordKey, ref: currentDefinitionRef };
  }
  // Pending may disappear before a submitted command answers. Keep only this scope's exact review identity.
  const definitionRef = retainedDefinition.current.ref;
  // An independent current-proposal read must not expose a decision before its selected identity is known.
  const definition = definitionRef === null ? <article><h2>Product definition</h2><p role="status">
    {reads.definition === null ? "Reading your product definition…" : reads.definition?.status === "NONE"
      ? "No product definition is recorded yet." : "The exact product definition could not be read. Refresh to try again."}
  </p></article> : <LiveProductDefinition setup={setup} goalId={route.goalId} source={reads.source} expectedRef={definitionRef}
    readOnly={observed.historical || currentDefinitionRef === null} />;
  const definitionOnCanvas = model.selection.artifact === null || model.selection.artifact.kind === "DEFINITION";
  const definitionRecord = definitionOnCanvas ? <><p>The definition review stays on the product canvas.</p>
    <button type="button" onClick={() => update({ ...query, inspector: null })}>Review definition</button></> : definition;
  const currentRecord = (children: ReactNode): JSX.Element => <section key={recordKey} aria-label="Current product work">
    <p className="cr-product-kind">Current product work</p>
    <p>These actions concern the current product work. Review the exact plan or delivery source before deciding.</p>
    <dl><dt>Plan</dt><dd>{context.planningRunRef ?? "No plan recorded"}</dd>
      <dt>Candidate</dt><dd>{context.candidateSha ?? "No current candidate established"}</dd></dl>{children}</section>;
  const viewOnly = <div><p>{context.note}</p>{context.currentArtifactId === null ? null
    : <button type="button" onClick={() => update({ ...query, artifactId: context.currentArtifactId })}>Review current work</button>}</div>;
  return <ProductWorkspace title={route.title} model={model} inspector={query.inspector}
    recordScopeKey={recordKey}
    recordBlocked={recordsAvailable ? null : <div>{viewOnly}<p>Current work must be read again before another decision.</p></div>}
    observationNote={observed.historical ? `Saved observation from ${observed.observedAt}. Current checks and actions do not apply to this historical view.` : context.note}
    onInspect={(inspector) => update({ ...query, inspector })}
    onSelect={(artifactId) => update({ ...query, artifactId })} onRefresh={() => { reads.refresh(); setReadRevision(previous => previous + 1); }}
    renderArtifact={(artifact) => <ProductArtifact artifact={artifact} {...observed.reads}
      definition={definition} />}
    records={!retainRecords ? {
      Definition: viewOnly, "Build plan": viewOnly, Checks: viewOnly, Delivery: viewOnly, "Technical detail": viewOnly,
    } : {
      Definition: <>{definitionRecord}{scopedCoverage === null ? null : <ContractDossier coverage={scopedCoverage} gates={gates} />}</>,
      "Build plan": currentRecord(runId === "" ? <p>A build plan is not recorded yet. You can inspect the specification and product definition.</p>
        : <><ApprovePlan approval={approval} goalId={route.goalId} onBack={onBack} read={readRun} runId={runId} title={route.title} readRevision={readRevision} />
          <LiveDesignVersionNote goalRef={route.goalId} planningRunRef={runId} headers={setup.headers} observationKey={planObservationKey} /></>),
      Checks: currentRecord(<CriterionEvidenceCard outcome={context.criteria} port={criterionPort} onRecorded={reads.refresh} />),
      Delivery: currentRecord(<><h3>Release and environments</h3><p>Review the exact source version and destination before making a release or deployment decision.</p>
        <LiveGoalRelease frame={frame} goalId={route.goalId} setup={setup} />
        <LiveGoalDeployments frame={frame} goalRef={route.goalId} setup={setup} />
        <LiveGoalEnvironments goalId={route.goalId} setup={setup} /></>),
      "Technical detail": currentRecord(<><LiveBoard goalId={route.goalId} headers={setup.headers} onNeedsYou={onNeedsYou}
        publishing={{ frame, port: createPublishPort(setup) }} runId={runId} surface={frame} title={route.title} />
        <LiveWorkBoard goalId={route.goalId} headers={setup.headers} runId={runId} surface={frame} /></>),
    }} />;
}
