import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { CriterionEvidenceOutcome, CriterionEvidenceView } from "../../live/live-criterion-evidence-contracts.js";
import type { OfferOutcome } from "../approvals/offer-wire.js";
import { ActionButton } from "../components/primitives.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { CriterionCheckForm } from "./criterion-check-form.js";
import type { CriterionEvidencePort } from "./criterion-evidence-port.js";
import "../styles/cordum-repository-effects.css";
interface Props { readonly outcome: CriterionEvidenceOutcome | null; readonly port: CriterionEvidencePort | null; readonly onRecorded?: () => void }

function EvidenceBody({ view, port, onRecorded }: { readonly view: CriterionEvidenceView; readonly port: CriterionEvidencePort | null;
  readonly onRecorded: (() => void) | undefined }): JSX.Element {
  const [busy, setBusy] = useState(false); const sending = useRef(false); const mounted = useRef(true);
  const [report, setReport] = useState<OfferOutcome | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const verify = async (): Promise<void> => {
    if (port === null || view.verifyOffer === null || sending.current) return;
    sending.current = true; setBusy(true); setReport(null);
    let result: OfferOutcome;
    try { result = await port.verify(view); } catch { result = { ok: false, code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_CRITERIA" }; }
    if (!mounted.current) return;
    sending.current = false; setBusy(false); setReport(result);
    if (result.ok) onRecorded?.();
  };
  return <>
    <p className="cr2-needs-note">{`${view.contractRef.contractId} · revision ${view.contractRef.revisionId}`}</p>
    <p className="cr2-approve-mono" data-testid="cr.criteria.artifact">{view.integratedArtifact === null
      ? "The daemon has not established a complete integrated artifact."
      : `Integrated commit ${view.integratedArtifact.sha}`}</p>
    <p className="cr2-needs-note">{"Each result comes from its approved criterion check. Passing a node's general test command does not verify its criteria."}</p>
    {view.run !== null && <p role="status" data-testid="cr.criteria.run">{`Verification ${view.run.status} · ${view.run.runRef} · ${view.run.integratedSha}`}</p>}
    {view.criteria.map((criterion) => <article key={`${criterion.criterionId}:${criterion.approval?.approvalId ?? "unapproved"}`} className="cr2-effect-row">
      <h4>{criterion.criterionId}</h4><p>{criterion.statement}</p>
      <div data-testid={`cr.criteria.result.${criterion.criterionId}`}>
        {criterion.evidence === null ? <p>No criterion result recorded.</p> : <>
          <p>{`${criterion.evidence.status} · ${criterion.evidence.sha}`}</p>
          {criterion.evidence.sha !== view.integratedArtifact?.sha && <p>This result belongs to an earlier artifact.</p>}
          <details><summary>Evidence</summary>
            <p>{`Receipt ${criterion.evidence.receiptId}`}</p><p>{`Run ${criterion.evidence.runRef}`}</p>
            <p>{`Tree ${criterion.evidence.treeSha}`}</p><p>{`Output digest ${criterion.evidence.outputSha256} · ${criterion.evidence.byteCount} bytes`}</p>
            <p>{`Finished ${criterion.evidence.finishedAt}`}</p>
          </details>
        </>}
        {criterion.approval !== null && <details><summary>Approved check</summary>
          <p>{`${criterion.approval.checkId} · version ${criterion.approval.checkVersion} · ${criterion.approval.approvalId}`}</p>
          <p>{criterion.approval.program}</p><code>{JSON.stringify(criterion.approval.args)}</code>
          <p>{`Executor digest ${criterion.approval.executorDigest}`}</p>
        </details>}
      </div>
      <CriterionCheckForm view={view} criterion={criterion} port={port} onRecorded={onRecorded} />
    </article>)}
    <ActionButton disabled={port === null || view.verifyOffer === null || busy || report?.ok === true} onClick={() => { void verify(); }}>
      Verify approved criteria
    </ActionButton>
    {report?.ok === true && <p role="status">Criterion verification queued. Results will appear after the daemon runs the checks.</p>}
    {report?.ok === false && <OutcomeNote code={report.code} layer={report.layer} said="Criterion verification was refused." testId="cr.criteria.verify-refusal" />}
  </>;
}
export function CriterionEvidenceCard({ outcome, port, onRecorded }: Props): JSX.Element {
  return <section className="cr2-approve" data-testid="cr.criteria.card">
    <h3 className="cr2-approve-heading">Criterion checks</h3>
    {outcome === null ? <p>Reading criterion evidence…</p> : outcome.status !== "CRITERION_EVIDENCE"
      ? <OutcomeNote code={outcome.code} layer={outcome.layer} said="Criterion evidence could not be read." testId="cr.criteria.read-refusal" />
      : <EvidenceBody key={`${outcome.view.goalRef}:${outcome.view.planningRunRef}:${outcome.view.contractRef.revisionDigest}:${outcome.view.verifyOffer?.["expectedVersion"] ?? "held"}:${outcome.view.run?.runRef ?? "none"}`}
        view={outcome.view} port={port} onRecorded={onRecorded} />}
  </section>;
}
