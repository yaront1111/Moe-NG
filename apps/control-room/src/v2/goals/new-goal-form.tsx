import { useRef, useState } from "react";
import type { ChangeEvent, DragEvent, JSX } from "react";

import { ActionButton } from "../components/primitives.js";
import { EMDASH } from "../glyphs.js";
import type { DocumentIngestOutcome, DocumentIngestRequest } from "../../live/live-document-ingest.js";
import type { GoalDraft } from "./goal-model.js";

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
 *  - Create goal hands the draft to the caller, which dispatches goal.create
 *    through the kept dispatch layer; goal PROSE is not durable yet (a leftover),
 *    so the typed outcome is captured but not transmitted. Ingest is a SEPARATE
 *    action from goal.create - the draft still carries only { name, size }.
 */

const RISK_OPTIONS = Object.freeze(["STANDARD", "ELEVATED", "RESTRICTED"] as const);

const PLACEHOLDER_OUTCOME = "Ship the scoped MCP stdio entry behind per-agent bearer credentials";
const PRD_INGEST_NOTE = "Moe will read this once ingest is wired.";

interface PrdFile {
  readonly name: string;
  readonly size: number;
}

/** The live ingest state the status region renders; null before any file is read. */
type IngestState = "READING" | DocumentIngestOutcome | null;

/** Renders the live ingest state as one plain ASCII line for the status region. */
function ingestStatusText(state: "READING" | DocumentIngestOutcome): string {
  if (state === "READING") return "Reading...";
  if (state.status === "INGESTED") {
    return state.candidateTitle === null
      ? "Ingested - the daemon returned no candidate title"
      : `Ingested - candidate: ${state.candidateTitle}`;
  }
  if (state.status === "REFUSED") return `Refused - ${state.code}`;
  return `Error - ${state.code}`;
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
  const [budget, setBudget] = useState("120 min agent time");
  const [risk, setRisk] = useState<GoalDraft["riskClass"]>("STANDARD");
  const [prd, setPrd] = useState<PrdFile | null>(null);
  const [ingest, setIngest] = useState<IngestState>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Latest-wins guard (same discipline as the live feeds): a second drop while
  // the first read/POST is still in flight must not let a stale answer overwrite
  // the newer file's status or seed the outcome from a file the operator replaced.
  const ingestGeneration = useRef(0);

  const acceptFile = (file: File | null | undefined): void => {
    if (file === null || file === undefined) return;
    setPrd({ name: file.name, size: file.size });
    if (onIngestPrd === undefined) {
      // UNWIRED path, unchanged: pre-fill a PLACEHOLDER outcome, plainly marked -
      // the file is not read yet.
      setIngest(null);
      setOutcome((prior) => (prior.trim() === ""
        ? `Ingest ${file.name} (${PRD_INGEST_NOTE})`
        : prior));
      return;
    }
    // WIRED path: read the file and POST it to the daemon's ingest route.
    const generation = (ingestGeneration.current += 1);
    setIngest("READING");
    void (async (): Promise<void> => {
      let text: string;
      try {
        text = await file.text();
      } catch {
        if (ingestGeneration.current !== generation) return;
        setIngest(Object.freeze({
          code: "PRD_FILE_UNREADABLE", layer: "CONTROL_ROOM_NEWGOAL", status: "ERROR" as const,
        }));
        return;
      }
      if (ingestGeneration.current !== generation) return;
      const mediaType = file.name.endsWith(".md") ? "text/markdown" : "text/plain";
      const answer = await onIngestPrd({ displayPath: file.name, mediaType, text });
      if (ingestGeneration.current !== generation) return;
      setIngest(answer);
      // A REAL daemon-derived seed replaces the old placeholder: fill the empty
      // outcome with the daemon's candidate title, and only when it is empty so a
      // typed outcome is never clobbered.
      if (answer.status === "INGESTED" && answer.candidateTitle !== null) {
        const seed = answer.candidateTitle;
        setOutcome((prior) => (prior.trim() === "" ? seed : prior));
      }
    })();
  };

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
            Drop a PRD to seed the outcome below. {PRD_INGEST_NOTE} Nothing is sent to
            the daemon until you press Create goal.
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
          onChange={(event) => setBudget(event.target.value)}
          value={budget}
        />
        <label className="cr2-field-label" htmlFor="cr2-risk">RISK CLASS</label>
        <select
          className="cr2-field-select"
          data-testid="cr.goals.newgoal.risk"
          id="cr2-risk"
          onChange={(event) => setRisk(event.target.value as GoalDraft["riskClass"])}
          value={risk}
        >
          {RISK_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        <p className="cr2-newgoal-caption">
          Policy supplies these defaults. The control room authors none of its own.
        </p>
        <div className="cr2-newgoal-actions">
          <ActionButton disabled={busy} onClick={submit} testId="cr.goals.newgoal.create" variant="primary">
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
