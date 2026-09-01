import { useId, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";

import "./project-home.css";
import { PROJECT_HOME_LOCAL_REFUSAL, lifecycleWord, resultWords, safeResult } from "./project-result-words.js";
import type { ProjectHomeProject, ProjectHomeResult } from "./project-result-words.js";

export { PROJECT_HOME_LOCAL_REFUSAL, PROJECT_LIFECYCLES } from "./project-result-words.js";
export type { ProjectHomeProject, ProjectHomeResult, ProjectLifecycle } from "./project-result-words.js";

type Intake = (input: { readonly root: string; readonly title: string }) => Promise<ProjectHomeResult>;
type ById = (instanceId: string) => Promise<ProjectHomeResult>;

export interface ProjectHomeProps {
  readonly projects: readonly ProjectHomeProject[];
  readonly onCreateProject: Intake;
  readonly onRefreshProjects: () => Promise<ProjectHomeResult>;
  readonly onRegisterProject: Intake;
  readonly onStartProject: ById;
  readonly onStopProject: ById;
  readonly onOpenProject: ById;
}

type RunOperation = (busyKey: string, reportKey: string, operation: () => Promise<ProjectHomeResult>) => Promise<ProjectHomeResult>;

/** The sentence is the headline; `CODE @ LAYER` stays verbatim behind Details so
    the daemon's own word is always one click away and never the first thing read. */
export function ResultReport({ result }: { readonly result: ProjectHomeResult | undefined }): JSX.Element | null {
  if (result === undefined) return null;
  const [said, next] = resultWords(result);
  return (
    <div className={`cr2-project-report ${result.ok ? "is-ok" : "is-refused"}`}
      role={result.ok ? "status" : "alert"}>
      <p className="cr2-project-report-said">{said}</p>
      {next === "" ? null : <p className="cr2-project-report-next">{next}</p>}
      <details className="cr2-project-report-details">
        <summary>Details</summary>
        <code>{result.code} @ {result.layer}</code>
      </details>
    </div>
  );
}

const INTAKE_KEY = "intake";
/**
 * projects-10. Each hint is the daemon's own precondition: `create` runs planInit,
 * which refuses a folder that already holds entries (moe-init.ts,
 * MOE_INIT_TARGET_NOT_EMPTY); `register` re-reads an existing moe.config.json
 * (project-manager-files.ts, registerExisting). The hint swaps with the selection,
 * so each radio names it through aria-describedby and a screen reader hears the
 * precondition with the choice, not only the two labels.
 */
const INTAKE_CHOICES = Object.freeze([
  Object.freeze({
    hint: "For a new folder, or an empty one. Moe creates it if it is not there yet and writes"
      + " its setup file. Moe will not set up a folder that already has files in it, so point it"
      + " at a new folder and copy your work in once the project is added.",
    kind: "create" as const,
    label: "Moe should set this folder up",
  }),
  Object.freeze({
    hint: "For a folder Moe set up before. It already holds a moe.config.json, and Moe reads that"
      + " file instead of writing a new one.",
    kind: "register" as const,
    label: "Moe already set this folder up",
  }),
]);

interface IntakeFormProps {
  readonly busyKey: string | null; readonly onCreate: Intake; readonly onRegister: Intake;
  readonly report: ProjectHomeResult | undefined; readonly run: RunOperation;
}

function IntakeForm({ busyKey, onCreate, onRegister, report, run }: IntakeFormProps): JSX.Element {
  const titleId = useId(), rootId = useId(), choiceName = useId(), hintId = useId();
  const [kind, setKind] = useState<"create" | "register">("create");
  const [title, setTitle] = useState("");
  const [root, setRoot] = useState("");
  const blocked = busyKey !== null;
  const ready = title.trim() !== "" && root.trim() !== "";

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!ready || blocked) return;
    const input = { root: root.trim(), title: title.trim() };
    const result = await run(INTAKE_KEY, INTAKE_KEY, () =>
      kind === "create" ? onCreate(input) : onRegister(input));
    if (result.ok) { setRoot(""); setTitle(""); }
  };

  return (
    <form aria-label="Add a project" className="cr2-project-intake"
      onSubmit={(event) => { void submit(event); }}>
      <div>
        <p className="cr2-project-intake-kicker">ADD A PROJECT</p>
        <h3>Point Moe at a folder on this computer</h3>
      </div>
      <fieldset className="cr2-project-choice" disabled={blocked}>
        <legend>What is this folder?</legend>
        {INTAKE_CHOICES.map((entry) => (
          <label className="cr2-project-choice-option" key={entry.kind}>
            <input aria-describedby={hintId} checked={kind === entry.kind} name={choiceName}
              onChange={() => { setKind(entry.kind); }} type="radio" value={entry.kind} />
            <span>{entry.label}</span>
          </label>
        ))}
        <p className="cr2-project-choice-hint" id={hintId}>
          {INTAKE_CHOICES.find((entry) => entry.kind === kind)?.hint}
        </p>
      </fieldset>
      <label htmlFor={rootId}>Folder on this computer</label>
      <input autoComplete="off" className="cr2-project-path" disabled={blocked} id={rootId}
        onChange={(event) => { setRoot(event.currentTarget.value); }} placeholder="C:\\work\\project"
        required spellCheck={false} value={root} />
      <label htmlFor={titleId}>Name for this project</label>
      <input autoComplete="off" disabled={blocked} id={titleId}
        onChange={(event) => { setTitle(event.currentTarget.value); }} required value={title} />
      <button disabled={!ready || blocked} type="submit">
        {busyKey === INTAKE_KEY ? "Adding project" : "Add project"}
      </button>
      <ResultReport result={report} />
    </form>
  );
}

/** projects-07. A tab that Moe Projects opened asks for `<instance id> <label>` on
    one line in the terminal running Moe Projects, so the id sits on the row in readable
    mono with a Copy button. The button exists only where the browser has a clipboard
    to write, and says Copied only once that write has resolved. */
function InstanceId({ busy, hintId, instanceId, title }: {
  readonly busy: boolean; readonly hintId: string; readonly instanceId: string; readonly title: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  const copy = (): void => { void clipboard?.writeText(instanceId).then(() => { setCopied(true); }, () => { setCopied(false); }); };
  return (
    <div className="cr2-project-instance">
      <span>Instance id</span>
      <code data-testid="cr.projects.instance">{instanceId}</code>
      {typeof clipboard?.writeText === "function" ? (
        <button aria-describedby={hintId} aria-label={`Copy the instance id for ${title}`}
          className="cr2-project-copy" disabled={busy} onBlur={() => { setCopied(false); }}
          onClick={copy} type="button">{copied ? "Copied" : "Copy"}</button>
      ) : null}
    </div>
  );
}

interface ProjectRowProps {
  readonly busyKey: string | null; readonly hintId: string; readonly project: ProjectHomeProject;
  readonly onOpen: ById; readonly onStart: ById; readonly onStop: ById;
  readonly report: ProjectHomeResult | undefined; readonly run: RunOperation;
}

function ProjectRow({ busyKey, hintId, onOpen, onStart, onStop, project, report, run }: ProjectRowProps): JSX.Element {
  const { instanceId, lifecycle, projectId, root, title } = project;
  const globalBusy = busyKey !== null;
  const transitioning = lifecycle === "STARTING" || lifecycle === "STOPPING";
  const actionable = lifecycle === "RUNNING" || lifecycle === "STOPPED" || lifecycle === "FAILED";
  const canStart = !globalBusy && (lifecycle === "STOPPED" || lifecycle === "FAILED");
  const canRun = !globalBusy && lifecycle === "RUNNING";
  const actions = [
    { busyWord: "Starting", callback: onStart, enabled: canStart, key: `start:${instanceId}`, primary: false, word: "Start" },
    { busyWord: "Stopping", callback: onStop, enabled: canRun, key: `stop:${instanceId}`, primary: false, word: "Stop" },
    { busyWord: "Opening", callback: onOpen, enabled: canRun, key: `open:${instanceId}`, primary: true, word: "Open" },
  ];
  const rowBusy = transitioning || actions.some((action) => action.key === busyKey);

  return (
    <li aria-busy={rowBusy || undefined} className="cr2-project-row"
      data-actionable={actionable && !globalBusy ? "true" : "false"}
      data-instance-id={instanceId} data-lifecycle={lifecycle} data-testid={`cr.projects.row.${instanceId}`}>
      <div className="cr2-project-row-heading">
        <div><h3>{title}</h3></div>
        <span className="cr2-project-lifecycle" data-lifecycle={lifecycle}
          data-testid="cr.projects.lifecycle">{lifecycleWord(lifecycle)}</span>
      </div>
      <div className="cr2-project-facts">
        <div className="cr2-project-root"><span>Folder</span><code>{root}</code></div>
        <InstanceId busy={globalBusy} hintId={hintId} instanceId={instanceId} title={title} />
      </div>
      <div className="cr2-project-actions" aria-label={`${title} actions`} role="group">
        {actions.map(({ busyWord, callback, enabled, key, primary, word }) => (
          <button aria-label={`${busyKey === key ? busyWord : word} ${title}`}
            className={primary ? "is-primary" : undefined} disabled={!enabled} key={key}
            onClick={() => { void run(key, `project:${instanceId}`, () => callback(instanceId)); }}
            type="button">{busyKey === key ? busyWord : word}</button>
        ))}
      </div>
      {lifecycle === "UNKNOWN" ? <p className="cr2-project-unknown">Moe cannot see this project right now, so its buttons stay locked. Press Refresh to ask again.</p> : null}
      <ResultReport result={report} />
      <details className="cr2-project-inspect">
        <summary>Inspect</summary>
        <dl><dt>Project id</dt><dd className="cr2-project-id">{projectId}</dd></dl>
      </details>
    </li>
  );
}

export function ProjectHome({ projects, onCreateProject, onRefreshProjects, onRegisterProject,
  onStartProject, onStopProject, onOpenProject }: ProjectHomeProps): JSX.Element {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [reports, setReports] = useState<ReadonlyMap<string, ProjectHomeResult>>(() => new Map());
  const busy = useRef(false), hintId = useId();

  const run: RunOperation = async (key, reportKey, operation) => {
    if (busy.current) return PROJECT_HOME_LOCAL_REFUSAL;
    busy.current = true;
    setBusyKey(key);
    let result: ProjectHomeResult;
    try { result = safeResult(await operation()); }
    catch { result = PROJECT_HOME_LOCAL_REFUSAL; }
    busy.current = false; setBusyKey(null);
    setReports((current) => new Map(current).set(reportKey, result));
    return result;
  };

  return (
    <main className="cr2-project-home">
      <header className="cr2-project-home-header">
        <div><p>ON THIS COMPUTER</p><h2>Projects</h2></div>
        <div className="cr2-project-home-tools">
          <p>A project is a folder on this computer that Moe runs for you. Add one below, then press Start.</p>
          <button disabled={busyKey !== null} onClick={() => { void run("refresh", "refresh", onRefreshProjects); }}
            type="button">{busyKey === "refresh" ? "Refreshing" : "Refresh"}</button>
        </div>
      </header>
      <ResultReport result={reports.get("refresh")} />
      {projects.length === 0 ? <section className="cr2-project-empty">
        <p>NOTHING HERE YET</p><h2>Add your first project</h2>
        <span>Moe is not tracking any folder yet. Point it at one below, then press Start to run it.</span>
      </section> : null}
      <IntakeForm busyKey={busyKey} onCreate={onCreateProject} onRegister={onRegisterProject}
        report={reports.get(INTAKE_KEY)} run={run} />
      {projects.length > 0 ? <section aria-labelledby="cr2-project-ledger-heading" className="cr2-project-ledger">
        <div className="cr2-project-ledger-heading"><p>ADDED SO FAR</p><h2 id="cr2-project-ledger-heading">Your projects</h2></div>
        <p className="cr2-project-ledger-hint" id={hintId}>
          When a project opened from here asks for a pairing label, type its instance id, a space, and that
          label on one line in the terminal window running Moe Projects. Copy the id from the project&apos;s row.
        </p>
        <ul data-testid="cr.projects.list">
          {projects.map((project) => <ProjectRow busyKey={busyKey} hintId={hintId} key={project.instanceId}
            onOpen={onOpenProject} onStart={onStartProject} onStop={onStopProject} project={project}
            report={reports.get(`project:${project.instanceId}`)} run={run} />)}
        </ul>
      </section> : null}
    </main>
  );
}
