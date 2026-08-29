import { useRef, useState } from "react";
import type { ChangeEvent, DragEvent, JSX } from "react";

import { ActionButton } from "../components/primitives.js";
import { EMDASH } from "../glyphs.js";
import type { GoalDraft } from "./goal-model.js";

/**
 * The new-goal form (UI-3), opened in place from "New goal". Its fields are the
 * plain ones the design names - Outcome, Acceptance criteria, Budget envelope,
 * Risk class - plus the PRD DROP affordance the owner asked for.
 *
 * Honesty rules:
 *  - Budget and risk start blank; the control room authors no hidden defaults.
 *  - Dropping a PRD stores metadata plus a lazy memoized reader in local state.
 *    Selection and cancellation never read bytes or contact the daemon.
 *  - Create hands the full draft to the dispatcher, which reads at most once and
 *    binds the source to GoalCreated in one durable command.
 */

const RISK_OPTIONS = Object.freeze(["STANDARD", "ELEVATED", "RESTRICTED"] as const);

const PLACEHOLDER_OUTCOME = "Ship the scoped MCP stdio entry behind per-agent bearer credentials";
const PRD_LOCAL_NOTE = "Nothing has been read or sent. It will be bound only when you create the goal.";

interface PrdFile {
  readonly mediaType: string;
  readonly name: string;
  readonly readText: () => Promise<string>;
  readonly size: number;
}

function mediaTypeOf(file: File): string {
  if (file.type === "text/markdown" || file.type === "text/plain") return file.type;
  const lower = file.name.toLocaleLowerCase("en-US");
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  return file.type === "" ? "application/octet-stream" : file.type;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${String(size)} B`;
  const kib = size / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KB`;
  return `${(kib / 1024).toFixed(1)} MB`;
}

export interface NewGoalFormProps {
  readonly onCreate: (draft: GoalDraft) => void;
  readonly onCancel: () => void;
  readonly busy?: boolean | undefined;
  /** An earlier send may have committed; freeze every byte except the retry action. */
  readonly retryUnchanged?: boolean | undefined;
}

export function NewGoalForm({
  onCreate,
  onCancel,
  busy = false,
  retryUnchanged = false,
}: NewGoalFormProps): JSX.Element {
  const [outcome, setOutcome] = useState("");
  const [criteria, setCriteria] = useState("");
  const [budget, setBudget] = useState("");
  const [risk, setRisk] = useState<GoalDraft["riskClass"]>("");
  const [prd, setPrd] = useState<PrdFile | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const locked = busy || retryUnchanged;

  const acceptFile = (file: File | null | undefined): void => {
    if (locked || file === null || file === undefined) return;
    let cached: Promise<string> | null = null;
    setPrd({
      mediaType: mediaTypeOf(file),
      name: file.name,
      readText: () => {
        cached = cached ?? file.text();
        return cached;
      },
      size: file.size,
    });
  };

  const onInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
    acceptFile(event.target.files?.[0]);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    if (locked) return;
    setDragging(false);
    acceptFile(event.dataTransfer.files?.[0]);
  };

  const submit = (): void => {
    onCreate({
      outcome: outcome.trim(),
      acceptanceCriteria: criteria.split("\n").map((line) => line.trim()).filter((line) => line !== ""),
      budgetEnvelope: budget.trim(),
      riskClass: risk,
      prd: prd ?? undefined,
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
        onDragLeave={() => { if (!locked) setDragging(false); }}
        onDragOver={(event) => { event.preventDefault(); if (!locked) setDragging(true); }}
        onDrop={onDrop}
      >
        <div className="cr2-prd-lead">
          <span className="cr2-field-label">DROP prd.md OR PASTE TEXT</span>
          <button
            className="cr2-prd-browse"
            disabled={locked}
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            Choose a file
          </button>
        </div>
        <input
          className="cr2-visually-hidden"
          data-testid="cr.goals.newgoal.prd.input"
          disabled={locked}
          onChange={onInputChange}
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          ref={inputRef}
          type="file"
        />
        {prd === null ? (
          <p className="cr2-prd-hint">
            Drop a text PRD to bind it to the goal. Nothing is read or sent until Create goal.
          </p>
        ) : (
          <p className="cr2-prd-file" data-testid="cr.goals.newgoal.prd.file">
            <span className="cr2-prd-file-name">{prd.name}</span>
            <span className="cr2-prd-file-size">{formatBytes(prd.size)}</span>
            <span className="cr2-prd-file-note">{PRD_LOCAL_NOTE}</span>
          </p>
        )}
      </div>

      <div className="cr2-newgoal-col">
        <label className="cr2-field-label" htmlFor="cr2-outcome">{`OUTCOME ${EMDASH} ONE SENTENCE IS ENOUGH`}</label>
        <input
          className="cr2-field-input"
          data-testid="cr.goals.newgoal.outcome"
          disabled={locked}
          id="cr2-outcome"
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
          disabled={locked}
          id="cr2-criteria"
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
          disabled={locked}
          id="cr2-budget"
          onChange={(event) => setBudget(event.target.value)}
          value={budget}
        />
        <label className="cr2-field-label" htmlFor="cr2-risk">RISK CLASS</label>
        <select
          className="cr2-field-select"
          data-testid="cr.goals.newgoal.risk"
          disabled={locked}
          id="cr2-risk"
          onChange={(event) => setRisk(event.target.value as GoalDraft["riskClass"])}
          value={risk}
        >
          <option value="">Not specified</option>
          {RISK_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        <p className="cr2-newgoal-caption">
          Budget and risk are optional. The control room supplies no hidden defaults.
        </p>
        <div className="cr2-newgoal-actions">
          <ActionButton disabled={busy || outcome.trim() === ""} onClick={submit} testId="cr.goals.newgoal.create" variant="primary">
            {retryUnchanged ? "Retry unchanged goal" : "Create goal"}
          </ActionButton>
          <ActionButton disabled={locked} onClick={onCancel} testId="cr.goals.newgoal.cancel" variant="ghost">
            Cancel
          </ActionButton>
        </div>
      </div>
    </form>
  );
}
