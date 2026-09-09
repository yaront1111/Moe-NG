import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { CriterionCheckInput, CriterionEvidenceRow, CriterionEvidenceView } from "../../live/live-criterion-evidence-contracts.js";
import type { OfferOutcome } from "../approvals/offer-wire.js";
import { ActionButton } from "../components/primitives.js";
import { OutcomeNote } from "../components/outcome-note.js";
import type { CriterionEvidencePort } from "./criterion-evidence-port.js";

export function CriterionCheckForm({ view, criterion, port, onRecorded }: {
  readonly view: CriterionEvidenceView; readonly criterion: CriterionEvidenceRow;
  readonly port: CriterionEvidencePort | null; readonly onRecorded: (() => void) | undefined;
}): JSX.Element {
  const [checkId, setCheckId] = useState(criterion.approval?.checkId ?? criterion.criterionId);
  const [checkVersion, setCheckVersion] = useState(criterion.approval?.checkVersion ?? "1");
  const [program, setProgram] = useState(criterion.approval?.program ?? "");
  const [argsText, setArgsText] = useState(JSON.stringify(criterion.approval?.args ?? []));
  const [seconds, setSeconds] = useState(String((criterion.approval?.timeoutMs ?? 60000) / 1000));
  const [busy, setBusy] = useState(false); const sending = useRef(false); const mounted = useRef(true);
  const [error, setError] = useState<string | null>(null); const [report, setReport] = useState<OfferOutcome | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const submit = async (): Promise<void> => {
    if (port === null || sending.current || criterion.approveOffer === null) return;
    setError(null); setReport(null);
    let args: unknown;
    try { args = JSON.parse(argsText); } catch { setError("Arguments must be a JSON array of strings."); return; }
    if (!Array.isArray(args) || args.length > 128 || args.some((arg: unknown) => typeof arg !== "string"
      || arg.length > 4096 || arg.includes("\0") || arg.normalize("NFC") !== arg)) {
      setError("Arguments must be a JSON array of strings."); return;
    }
    const validId = (value: string) => value.length > 0 && value.length <= 128 && value.trim() === value && value.normalize("NFC") === value;
    if (!validId(checkId) || !validId(checkVersion)) { setError("Give this check an identifier and version, each at most 128 characters."); return; }
    if (!/^[a-zA-Z]:[\\/](?![\\/])/u.test(program) || program.length > 260 || program.includes("\0")) {
      setError("Choose the full local Windows path to the executable."); return;
    }
    const timeoutMs = Number(seconds) * 1000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1_800_000) { setError("Choose a timeout from 1 to 1800 seconds."); return; }
    const check: CriterionCheckInput = { checkId, checkVersion, program, args: args as string[], timeoutMs };
    sending.current = true; setBusy(true);
    let result: OfferOutcome;
    try { result = await port.approve(view, criterion, check); }
    catch { result = { ok: false, code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_CRITERIA" }; }
    if (!mounted.current) return;
    sending.current = false; setBusy(false); setReport(result);
    if (result.ok) onRecorded?.();
  };
  return <details className="cr2-effect-form" open={criterion.approval === null}>
    <summary>{criterion.approval === null ? "Configure a criterion check" : "Change the approved check"}</summary>
    <p className="cr2-needs-note">Approve a check that specifically tests this criterion. It runs from the integrated repository with the listed arguments.</p>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label>Check identifier<input aria-label={`Check identifier for ${criterion.criterionId}`} value={checkId} maxLength={128} disabled={busy}
        onChange={(event) => setCheckId(event.target.value)} /></label>
      <label>Check version<input aria-label={`Check version for ${criterion.criterionId}`} value={checkVersion} maxLength={128} disabled={busy}
        onChange={(event) => setCheckVersion(event.target.value)} /></label>
      <label>Executable<input aria-label={`Executable for ${criterion.criterionId}`} value={program} maxLength={260} disabled={busy}
        placeholder="C:\Program Files\nodejs\node.exe" onChange={(event) => setProgram(event.target.value)} /></label>
      <label>Arguments (JSON array)<textarea aria-label={`Arguments for ${criterion.criterionId}`} value={argsText} disabled={busy}
        onChange={(event) => setArgsText(event.target.value)} /></label>
      <label>Timeout (seconds)<input aria-label={`Timeout for ${criterion.criterionId}`} type="number" min="1" max="1800" step="1"
        value={seconds} disabled={busy} onChange={(event) => setSeconds(event.target.value)} /></label>
      <ActionButton type="submit" variant="secondary" disabled={port === null || criterion.approveOffer === null || busy || report?.ok === true}>
        {`Approve check for ${criterion.criterionId}`}
      </ActionButton>
    </form>
    {error !== null && <p role="alert">{error}</p>}
    {report?.ok === true && <p role="status">Check approval recorded.</p>}
    {report?.ok === false && <OutcomeNote code={report.code} layer={report.layer} said="The check approval was refused."
      testId={`cr.criteria.approval-refusal.${criterion.criterionId}`} />}
  </details>;
}
