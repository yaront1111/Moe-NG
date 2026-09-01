import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, JSX } from "react";

import { ActionButton } from "../components/primitives.js";
import { EMDASH } from "../glyphs.js";
import type { AdvisoryRiskClass, GoalDraft } from "./goal-model.js";
import {
  PLACEHOLDER_OUTCOME,
  RISK_OPTIONS,
  formatBytes,
  prdStatusText,
} from "./new-goal-form-model.js";
import { useGoalPrd } from "./use-goal-prd.js";

export { PRD_FILE_PREFLIGHT_MAX_BYTES } from "./use-goal-prd.js";

/**
 * Deliberately LOOSER than GOAL_BRIEF_LIMITS.maxTitleUtf8Bytes (1024). The shared
 * brief contract is the authority on what a title may be; a field that silently
 * truncated at the contract bound would hide the refusal instead of surfacing it,
 * and would quietly send prose the operator never approved.
 */
const TITLE_INPUT_MAX_LENGTH = 2_048;

/**
 * The new-goal form (UI-3), opened in place from "New goal". Its fields are the
 * plain ones the design names - Outcome, Acceptance criteria, Budget envelope,
 * Risk class - plus the PRD DROP affordance the owner asked for.
 *
 * Honesty rules kept:
 *  - The caption states the control room authors no defaults; policy supplies them.
 *  - The PRD drop has ONE path and it is entirely local: the file is read in the
 *    browser and digested there. Selecting a PRD calls no route and writes
 *    nothing, so it can be changed or abandoned without retracting a durable
 *    record. The status region reports only what this page did.
 *  - Nothing seeds the operator's prose. The outcome and title are the words the
 *    human typed; the PRD contributes an advisory line to the composed brief and
 *    is never presented as an ingest receipt or as lifecycle authority.
 *  - Create goal requires both a title and an outcome and hands the draft to the
 *    caller, which owns the dispatch and the refusal report.
 */

export interface NewGoalFormProps {
  readonly onCreate: (draft: GoalDraft) => void;
  readonly onCancel: () => void;
  readonly busy?: boolean | undefined;
  /**
   * Advanced by the parent ONLY when a create actually committed. The form never
   * discards the operator's words on its own, so a refusal - at any layer - leaves
   * every field exactly as typed and the draft can be corrected and resent.
   */
  readonly resetToken?: number | undefined;
}

export function NewGoalForm({
  onCreate,
  onCancel,
  busy = false,
  resetToken = 0,
}: NewGoalFormProps): JSX.Element {
  const [title, setTitle] = useState("");
  const [outcome, setOutcome] = useState("");
  const [criteria, setCriteria] = useState("");
  const [budget, setBudget] = useState("");
  const [risk, setRisk] = useState<AdvisoryRiskClass | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { acceptFile, prd, read, submittedPrd } = useGoalPrd();

  // A committed create is the ONLY thing that clears the draft. The token starts at
  // its mount value, so a plain re-render (busy flipping back after a refusal) is
  // inert; only an advance the parent authored discards what the operator typed.
  const clearedToken = useRef(resetToken);
  useEffect(() => {
    if (clearedToken.current === resetToken) return;
    clearedToken.current = resetToken;
    setTitle("");
    setOutcome("");
    setCriteria("");
    setBudget("");
    setRisk(undefined);
  }, [resetToken]);

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
      title: title.trim(),
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
            Drop a PRD to attach it to this goal. It is read in this browser only; nothing is
            sent until you click Create goal.
          </p>
        ) : (
          <p className="cr2-prd-file" data-testid="cr.goals.newgoal.prd.file">
            <span className="cr2-prd-file-name">{prd.name}</span>
            <span className="cr2-prd-file-size">{formatBytes(prd.size)}</span>
          </p>
        )}
        {read === null ? null : (
          <p
            aria-live="polite"
            className="cr2-prd-status"
            data-testid="cr.goals.newgoal.prd.status"
            role="status"
          >
            {prdStatusText(read)}
          </p>
        )}
      </div>

      <div className="cr2-newgoal-col">
        <label className="cr2-field-label" htmlFor="cr2-title">TITLE</label>
        <input
          className="cr2-field-input"
          data-testid="cr.goals.newgoal.title"
          id="cr2-title"
          maxLength={TITLE_INPUT_MAX_LENGTH}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Ship the stdio entry point"
          value={title}
        />
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
            disabled={busy || read === "READING" || outcome.trim() === "" || title.trim() === ""}
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
