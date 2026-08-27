import { useRef, useState } from "react";
import type { ChangeEvent, DragEvent, JSX } from "react";

import { ActionButton } from "../components/primitives.js";
import { EMDASH } from "../glyphs.js";
import type { DocumentIngestOutcome, DocumentIngestRequest } from "../../live/live-document-ingest.js";
import type { AdvisoryRiskClass, GoalDraft } from "./goal-model.js";
import {
  PLACEHOLDER_OUTCOME,
  PRD_INGEST_NOTE,
  RISK_OPTIONS,
  formatBytes,
  ingestStatusText,
} from "./new-goal-form-model.js";
import { useGoalPrd } from "./use-goal-prd.js";

export { PRD_FILE_PREFLIGHT_MAX_BYTES } from "./use-goal-prd.js";

/**
 * The new-goal form (UI-3), opened in place from "New goal". Its fields are the
 * plain ones the design names - Outcome, Acceptance criteria, Budget envelope,
 * Risk class - plus the PRD DROP affordance the owner asked for.
 *
 * Honesty rules kept:
 *  - The caption states the control room authors no defaults; policy supplies them.
 *  - The PRD drop has TWO paths, decided by whether an `onIngestPrd` is supplied:
 *     - WIRED (a live operator session): the file is actually read and POSTed to
 *       the daemon's /documents/ingest route. The inline status region shows the
 *       real state (Reading / the daemon's candidate title / a verbatim refusal
 *       or error code), and an INGESTED candidate title seeds the empty outcome
 *       field - a real daemon-derived seed, not a placeholder.
 *     - UNWIRED (fixtures / not-attached): the file's name + size are shown with
 *       the honest "Moe will read this once ingest is wired" note and a plainly
 *       marked placeholder outcome. Nothing is read or sent. This path is
 *       unchanged from UI-3.
 *  - Create goal requires a real outcome and hands the draft to the caller. The
 *    live caller persists a canonical advisory intake before goal.create; that
 *    document is deliberately not represented as lifecycle authority.
 */

export interface NewGoalFormProps {
  readonly onCreate: (draft: GoalDraft) => void;
  readonly onCancel: () => void;
  readonly busy?: boolean | undefined;
  /**
   * When supplied (a live operator session), the dropped PRD is actually read
   * and ingested through this action. Its absence is the UNWIRED path: the file
   * is only described, never read or sent.
   */
  readonly onIngestPrd?: ((request: DocumentIngestRequest) => Promise<DocumentIngestOutcome>) | undefined;
}

export function NewGoalForm({
  onCreate,
  onCancel,
  busy = false,
  onIngestPrd,
}: NewGoalFormProps): JSX.Element {
  const [outcome, setOutcome] = useState("");
  const [criteria, setCriteria] = useState("");
  const [budget, setBudget] = useState("");
  const [risk, setRisk] = useState<AdvisoryRiskClass | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { acceptFile, ingest, prd, submittedPrd } = useGoalPrd(onIngestPrd, (seed) => {
    setOutcome((prior) => (prior.trim() === "" ? seed : prior));
  });

  const onInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
    acceptFile(event.target.files?.[0]);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
    acceptFile(event.dataTransfer.files?.[0]);
  };

  const submit = (): void => {
    onCreate({
      outcome: outcome.trim(),
      acceptanceCriteria: criteria.split("\n").map((line) => line.trim()).filter((line) => line !== ""),
      budgetEnvelope: budget.trim(),
      ...(risk === undefined ? {} : { riskClass: risk }),
      ...(submittedPrd === undefined ? {} : { prd: submittedPrd }),
    });
  };

  return (
    <form
      className="cr2-newgoal"
      data-testid="cr.goals.newgoal.form"
      onSubmit={(event) => { event.preventDefault(); }}
    >
      <div
        className="cr2-prd"
        data-dragging={dragging ? "true" : undefined}
        data-testid="cr.goals.newgoal.prd"
        onDragLeave={() => setDragging(false)}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDrop={onDrop}
      >
        <div className="cr2-prd-lead">
          <span className="cr2-field-label">DROP prd.md OR PASTE TEXT</span>
          <button
            className="cr2-prd-browse"
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            Choose a file
          </button>
        </div>
        <input
          className="cr2-visually-hidden"
          data-testid="cr.goals.newgoal.prd.input"
          onChange={onInputChange}
          ref={inputRef}
          type="file"
        />
        {prd === null ? (
          <p className="cr2-prd-hint">
            Drop a PRD to seed the outcome below. {onIngestPrd === undefined
              ? PRD_INGEST_NOTE
              : "An attached session records the selected file immediately as advisory project material."}
          </p>
        ) : (
          <p className="cr2-prd-file" data-testid="cr.goals.newgoal.prd.file">
            <span className="cr2-prd-file-name">{prd.name}</span>
            <span className="cr2-prd-file-size">{formatBytes(prd.size)}</span>
            {onIngestPrd === undefined ? (
              <span className="cr2-prd-file-note">{PRD_INGEST_NOTE}</span>
            ) : null}
          </p>
        )}
        {ingest === null ? null : (
          <p
            aria-live="polite"
            className="cr2-prd-status"
            data-testid="cr.goals.newgoal.prd.status"
            role="status"
          >
            {ingestStatusText(ingest)}
          </p>
        )}
      </div>

      <div className="cr2-newgoal-col">
        <label className="cr2-field-label" htmlFor="cr2-outcome">{`OUTCOME ${EMDASH} ONE SENTENCE IS ENOUGH`}</label>
        <input
          className="cr2-field-input"
          data-testid="cr.goals.newgoal.outcome"
          id="cr2-outcome"
          maxLength={512}
          onChange={(event) => setOutcome(event.target.value)}
          placeholder={PLACEHOLDER_OUTCOME}
          value={outcome}
        />
        <label className="cr2-field-label" htmlFor="cr2-criteria">
          {`ACCEPTANCE CRITERIA ${EMDASH} OPTIONAL, ONE PER LINE`}
        </label>
        <textarea
          className="cr2-field-area"
          data-testid="cr.goals.newgoal.criteria"
          id="cr2-criteria"
          maxLength={8_192}
          onChange={(event) => setCriteria(event.target.value)}
          placeholder="pnpm test:security exits 0"
          rows={3}
          value={criteria}
        />
      </div>

      <div className="cr2-newgoal-col">
        <label className="cr2-field-label" htmlFor="cr2-budget">BUDGET ENVELOPE</label>
        <input
          className="cr2-field-input"
          data-testid="cr.goals.newgoal.budget"
          id="cr2-budget"
          maxLength={256}
          onChange={(event) => setBudget(event.target.value)}
          placeholder="Optional, for example 120 min agent time"
          value={budget}
        />
        <label className="cr2-field-label" htmlFor="cr2-risk">RISK CLASS</label>
        <select
          className="cr2-field-select"
          data-testid="cr.goals.newgoal.risk"
          id="cr2-risk"
          onChange={(event) => {
            const value = event.target.value;
            setRisk(value === "" ? undefined : value as AdvisoryRiskClass);
          }}
          value={risk ?? ""}
        >
          <option value="">Not supplied</option>
          {RISK_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        <p className="cr2-newgoal-caption" data-testid="cr.goals.newgoal.authority-note">
          Budget and risk are optional advisory requests. Blank means not supplied; daemon policy remains authority.
        </p>
        <div className="cr2-newgoal-actions">
          <ActionButton
            disabled={busy || ingest === "READING" || outcome.trim() === ""}
            onClick={submit}
            testId="cr.goals.newgoal.create"
            variant="primary"
          >
            Create goal
          </ActionButton>
          <ActionButton disabled={busy} onClick={onCancel} testId="cr.goals.newgoal.cancel" variant="ghost">
            Cancel
          </ActionButton>
        </div>
      </div>
    </form>
  );
}
