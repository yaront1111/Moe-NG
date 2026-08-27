import { useId, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";

import "./project-home.css";

export const PROJECT_LIFECYCLES = Object.freeze([
  "STARTING",
  "RUNNING",
  "STOPPING",
  "STOPPED",
  "FAILED",
  "UNKNOWN",
] as const);

export type ProjectLifecycle = (typeof PROJECT_LIFECYCLES)[number];

export interface ProjectHomeProject {
  readonly instanceId: string;
  readonly lifecycle: ProjectLifecycle;
  readonly projectId: string;
  readonly root: string;
  readonly title: string;
}

export interface ProjectHomeResult {
  readonly code: string;
  readonly layer: string;
  readonly ok: boolean;
}

export interface ProjectHomeProps {
  readonly projects: readonly ProjectHomeProject[];
  readonly onCreateProject: (input: { readonly root: string; readonly title: string }) => Promise<ProjectHomeResult>;
  readonly onRefreshProjects: () => Promise<ProjectHomeResult>;
  readonly onRegisterProject: (input: { readonly root: string; readonly title: string }) => Promise<ProjectHomeResult>;
  readonly onStartProject: (instanceId: string) => Promise<ProjectHomeResult>;
  readonly onStopProject: (instanceId: string) => Promise<ProjectHomeResult>;
  readonly onOpenProject: (instanceId: string) => Promise<ProjectHomeResult>;
}

export const PROJECT_HOME_LOCAL_REFUSAL = Object.freeze({
  code: "PROJECT_HOME_REQUEST_FAILED",
  layer: "CONTROL_ROOM_PROJECT_HOME",
  ok: false,
} satisfies ProjectHomeResult);

type Operation = () => Promise<ProjectHomeResult>;
type RunOperation = (
  busyKey: string,
  reportKey: string,
  operation: Operation,
) => Promise<ProjectHomeResult>;

const STABLE_NAME = /^[A-Z][A-Z0-9_]*$/u;

function safeResult(value: unknown): ProjectHomeResult {
  if (typeof value !== "object" || value === null) return PROJECT_HOME_LOCAL_REFUSAL;
  const candidate = value as Partial<ProjectHomeResult>;
  if (typeof candidate.ok !== "boolean"
    || typeof candidate.code !== "string"
    || typeof candidate.layer !== "string"
    || !STABLE_NAME.test(candidate.code)
    || !STABLE_NAME.test(candidate.layer)) return PROJECT_HOME_LOCAL_REFUSAL;
  return { code: candidate.code, layer: candidate.layer, ok: candidate.ok };
}

/**
 * projects-09. The daemon owns the outcome; these are only its own codes said in
 * words, one entry per code, adding no fact the code does not already carry. Each
 * value is `[what happened, what to do next]`; an empty next step means none is
 * needed. Codes with no entry fall back to `GENERIC_WORDS`, so an unmapped daemon
 * refusal reads as a refusal and never as an invented success or diagnosis.
 * Sources: project-manager-client.ts LOCAL_CODE, apps/daemon/src/projects
 * (project-manager-service.ts, project-manager-files.ts, project-runtime-supervisor.ts,
 * project-manager-http-routing.ts) and apps/daemon/src/cli/moe-init.ts.
 */
const RESULT_WORDS: Readonly<Record<string, readonly [said: string, next: string]>> = Object.freeze({
  MOE_INIT_CONFIG_PRESENT: ["Moe is already set up in that folder.", "Choose \u201cMoe already set this folder up\u201d above and add it again."],
  MOE_INIT_TARGET_NOT_EMPTY: ["That folder already has files in it, so Moe would not set it up.", "Point Moe at a new or empty folder, then copy your files in after it is added."],
  MOE_INIT_TARGET_UNWRITABLE: ["Moe cannot write into that folder.", "Pick a folder you can write to, then press Add project again."],
  PROJECT_HOME_REQUEST_FAILED: ["This page could not reach Moe.", "Press Refresh. If that fails too, check the terminal window running Moe Projects."],
  PROJECT_MANAGER_AUTHENTICATION_REQUIRED: ["This browser is no longer paired with Moe Projects.", "Reload this page to pair again."],
  PROJECT_MANAGER_BOOTSTRAP_MALFORMED: ["Moe Projects answered in a way this page could not read.", "Reload this page. If it happens again, restart Moe Projects."],
  PROJECT_MANAGER_BOOTSTRAP_UNAVAILABLE: ["This page could not reach Moe Projects.", "Reload this page. If that fails, check the terminal window running Moe Projects."],
  PROJECT_MANAGER_BUSY: ["Moe Projects is already handling another change.", "Wait a moment, then try again."],
  PROJECT_MANAGER_CONFIG_INVALID: ["Moe could not read the setup file in that folder.", "Pick a folder Moe set up itself, or let Moe set up a new folder."],
  PROJECT_MANAGER_CONFIG_UNREADABLE: ["Moe found no setup file in that folder.", "Choose \u201cMoe should set this folder up\u201d above, or pick a folder Moe set up before."],
  PROJECT_MANAGER_CONFIG_WRITE_FAILED: ["Moe could not write its setup file into that folder.", "Pick a folder you can write to, then press Add project again."],
  PROJECT_MANAGER_CONNECT_FAILED: ["This page could not reach Moe Projects.", "Reload this page. If that fails, check the terminal window running Moe Projects."],
  PROJECT_MANAGER_CSRF_INVALID: ["This page's session with Moe Projects has expired.", "Reload this page to start a new one."],
  PROJECT_MANAGER_INSTANCE_ID_INVALID: ["This page could not name that project to Moe.", "Press Refresh, then use the button again."],
  PROJECT_MANAGER_INTAKE_INVALID: ["Moe would not take that folder and name.", "Check the folder path and the name, then press Add project again."],
  PROJECT_MANAGER_PAIRED: ["This browser is paired with Moe Projects.", ""],
  PROJECT_MANAGER_PAIRING_REFUSED: ["Pairing with Moe Projects did not go through.", "Reload this page to start pairing again."],
  PROJECT_MANAGER_POPUP_BLOCKED: ["Your browser blocked the new tab.", "Allow pop-ups for this address, then press Open again."],
  PROJECT_MANAGER_PROJECTS_MALFORMED: ["Moe Projects sent a project list this page could not read.", "Press Refresh. If it happens again, restart Moe Projects."],
  PROJECT_MANAGER_PROJECTS_REFRESHED: ["Project list updated.", ""],
  PROJECT_MANAGER_PROJECTS_UNAVAILABLE: ["Moe Projects did not send the project list.", "Press Refresh to ask again."],
  PROJECT_MANAGER_PROJECT_CREATED: ["Moe set up the folder and added the project.", "Press Start to run it."],
  PROJECT_MANAGER_PROJECT_INPUT_INVALID: ["Moe would not take that folder and name.", "Check the folder path and the name, then press Add project again."],
  PROJECT_MANAGER_PROJECT_ORIGIN_INVALID: ["Moe Projects did not give this page a usable address for that project.", "Press Refresh, then press Open again."],
  PROJECT_MANAGER_PROJECT_REGISTERED: ["Moe added that folder as a project.", "Press Start to run it."],
  PROJECT_MANAGER_PROJECT_UNKNOWN: ["Moe Projects no longer knows that project.", "Press Refresh to reload the list."],
  PROJECT_MANAGER_PROTOCOL_MISMATCH: ["This page and Moe Projects are different versions.", "Restart Moe Projects, then reload this page."],
  PROJECT_MANAGER_PROTOCOL_UNSUPPORTED: ["This page and Moe Projects are different versions.", "Restart Moe Projects, then reload this page."],
  PROJECT_MANAGER_REQUEST_FAILED: ["Moe Projects did not answer this page.", "Press Refresh. If that fails too, check the terminal window running Moe Projects."],
  PROJECT_MANAGER_RESPONSE_MALFORMED: ["Moe Projects sent an answer this page could not read.", "Reload this page. If it happens again, restart Moe Projects."],
  PROJECT_MANAGER_ROOT_INVALID: ["Moe could not use that folder path.", "Enter the full path to a folder on this computer, like C:\\work\\project."],
  PROJECT_RUNTIME_BOUNDARY_REFUSED: ["Moe lost contact with that project's runtime.", "Press Refresh, then try again."],
  PROJECT_RUNTIME_EXITED_BEFORE_READY: ["The project shut down before it finished starting.", "Press Start again. If it happens again, check that folder's setup."],
  PROJECT_RUNTIME_INSTANCE_ACTIVE: ["That project is already running.", "Press Refresh to see its current state."],
  PROJECT_RUNTIME_INSTANCE_UNKNOWN: ["Moe Projects no longer knows that project.", "Press Refresh to reload the list."],
  PROJECT_RUNTIME_NOT_RUNNING: ["That project is not running.", "Press Start first."],
  PROJECT_RUNTIME_OPENED: ["Moe opened that project in a new tab.", "If no tab appeared, allow pop-ups for this address and press Open again."],
  PROJECT_RUNTIME_OPERATION_ACTIVE: ["That project is busy with another action.", "Wait a moment, then press Refresh."],
  PROJECT_RUNTIME_STARTED: ["That project is running.", "Press Open to work in it."],
  PROJECT_RUNTIME_START_TIMEOUT: ["The project did not finish starting in time.", "Press Refresh, then press Start again."],
  PROJECT_RUNTIME_STOPPED: ["That project has stopped.", ""],
  PROJECT_RUNTIME_STOP_TIMEOUT: ["The project did not finish stopping in time.", "Press Refresh to see where it stands."],
  PROJECT_RUNTIME_STORE_ACTIVE: ["Another project is already using that folder's store.", "Stop the project using it, then press Start again."],
});
const GENERIC_WORDS = Object.freeze({
  ok: Object.freeze(["Moe accepted that.", "The list updates as the project reports back."] as const),
  refused: Object.freeze(["Moe refused that.", "Open Details for the exact reason, then press Refresh."] as const),
});

function resultWords(result: ProjectHomeResult): readonly [string, string] {
  return RESULT_WORDS[result.code] ?? (result.ok ? GENERIC_WORDS.ok : GENERIC_WORDS.refused);
}

/**
 * The sentence is the headline; `CODE @ LAYER` stays verbatim behind Details so
 * the daemon's own word is always one click away and never the first thing read.
 */
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
 * projects-10. Two equally weighted forms told the owner nothing about which
 * folder each one takes, so the choice is stated instead of implied. Each hint is
 * the daemon's own precondition: `create` runs planInit, which refuses a folder
 * that already holds entries (moe-init.ts, MOE_INIT_TARGET_NOT_EMPTY), and
 * `register` re-reads an existing moe.config.json (project-manager-files.ts,
 * registerExisting). Both endpoints stay reachable; only the cue is new.
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
  readonly busyKey: string | null;
  readonly onCreate: ProjectHomeProps["onCreateProject"];
  readonly onRegister: ProjectHomeProps["onRegisterProject"];
  readonly report: ProjectHomeResult | undefined;
  readonly run: RunOperation;
}

function IntakeForm({ busyKey, onCreate, onRegister, report, run }: IntakeFormProps): JSX.Element {
  const titleId = useId();
  const rootId = useId();
  const choiceName = useId();
  const [kind, setKind] = useState<"create" | "register">("create");
  const [title, setTitle] = useState("");
  const [root, setRoot] = useState("");
  const isBusy = busyKey === INTAKE_KEY;
  const blocked = busyKey !== null;
  const ready = title.trim() !== "" && root.trim() !== "";
  const chosen = INTAKE_CHOICES.find((entry) => entry.kind === kind);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!ready || blocked) return;
    const input = { root: root.trim(), title: title.trim() };
    const result = await run(INTAKE_KEY, INTAKE_KEY, () =>
      kind === "create" ? onCreate(input) : onRegister(input));
    if (result.ok) {
      setRoot("");
      setTitle("");
    }
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
            <input checked={kind === entry.kind} name={choiceName}
              onChange={() => { setKind(entry.kind); }} type="radio" value={entry.kind} />
            <span>{entry.label}</span>
          </label>
        ))}
        <p className="cr2-project-choice-hint">{chosen?.hint}</p>
      </fieldset>
      <label htmlFor={rootId}>Folder on this computer</label>
      <input autoComplete="off" className="cr2-project-path" disabled={blocked} id={rootId}
        onChange={(event) => { setRoot(event.currentTarget.value); }} placeholder="C:\\work\\project"
        required spellCheck={false} value={root} />
      <label htmlFor={titleId}>Name for this project</label>
      <input autoComplete="off" disabled={blocked} id={titleId}
        onChange={(event) => { setTitle(event.currentTarget.value); }} required value={title} />
      <button disabled={!ready || blocked} type="submit">
        {isBusy ? "Adding project" : "Add project"}
      </button>
      <ResultReport result={report} />
    </form>
  );
}

/** The daemon's own lifecycle token said as a word; the token itself rides `data-lifecycle`. */
const LIFECYCLE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  FAILED: "Failed", RUNNING: "Running", STARTING: "Starting",
  STOPPED: "Stopped", STOPPING: "Stopping", UNKNOWN: "Unknown",
});

interface ProjectRowProps {
  readonly busyKey: string | null;
  readonly onOpen: ProjectHomeProps["onOpenProject"];
  readonly onStart: ProjectHomeProps["onStartProject"];
  readonly onStop: ProjectHomeProps["onStopProject"];
  readonly project: ProjectHomeProject;
  readonly report: ProjectHomeResult | undefined;
  readonly run: RunOperation;
}

function ProjectRow({ busyKey, onOpen, onStart, onStop, project, report, run }: ProjectRowProps): JSX.Element {
  const { instanceId, lifecycle, projectId, root, title } = project;
  const startKey = `start:${instanceId}`;
  const stopKey = `stop:${instanceId}`;
  const openKey = `open:${instanceId}`;
  const reportKey = `project:${instanceId}`;
  const globalBusy = busyKey !== null;
  const projectBusy = busyKey === startKey || busyKey === stopKey || busyKey === openKey;
  const transitioning = lifecycle === "STARTING" || lifecycle === "STOPPING";
  const actionable = lifecycle === "RUNNING" || lifecycle === "STOPPED" || lifecycle === "FAILED";
  const canStart = !globalBusy && (lifecycle === "STOPPED" || lifecycle === "FAILED");
  const canRun = !globalBusy && lifecycle === "RUNNING";
  const rowBusy = projectBusy || transitioning;
  const action = (key: string, callback: (id: string) => Promise<ProjectHomeResult>): void => {
    void run(key, reportKey, () => callback(instanceId));
  };

  return (
    <li aria-busy={rowBusy || undefined} className="cr2-project-row"
      data-actionable={actionable && !globalBusy ? "true" : "false"}
      data-instance-id={instanceId} data-lifecycle={lifecycle} data-testid={`cr.projects.row.${instanceId}`}>
      <div className="cr2-project-row-heading">
        <div><h3>{title}</h3></div>
        <span className="cr2-project-lifecycle" data-lifecycle={lifecycle}
          data-testid="cr.projects.lifecycle">{LIFECYCLE_WORDS[lifecycle] ?? lifecycle}</span>
      </div>
      <div className="cr2-project-root"><span>Folder</span><code>{root}</code></div>
      {lifecycle === "UNKNOWN" ? <p className="cr2-project-unknown">Moe cannot see this project right now, so its buttons stay locked. Press Refresh to ask again.</p> : null}
      <div className="cr2-project-actions" aria-label={`${title} actions`} role="group">
        <button aria-label={busyKey === startKey ? `Starting ${title}` : `Start ${title}`}
          disabled={!canStart} onClick={() => { action(startKey, onStart); }} type="button">
          {busyKey === startKey ? "Starting" : "Start"}
        </button>
        <button aria-label={busyKey === stopKey ? `Stopping ${title}` : `Stop ${title}`}
          disabled={!canRun} onClick={() => { action(stopKey, onStop); }} type="button">
          {busyKey === stopKey ? "Stopping" : "Stop"}
        </button>
        <button aria-label={busyKey === openKey ? `Opening ${title}` : `Open ${title}`}
          className="is-primary" disabled={!canRun} onClick={() => { action(openKey, onOpen); }} type="button">
          {busyKey === openKey ? "Opening" : "Open"}
        </button>
      </div>
      <ResultReport result={report} />
      <details className="cr2-project-inspect">
        <summary>Inspect</summary>
        <dl>
          <dt>Project id</dt><dd className="cr2-project-id">{projectId}</dd>
          <dt>Instance id</dt><dd className="cr2-project-id">{instanceId}</dd>
        </dl>
      </details>
    </li>
  );
}

export function ProjectHome({ projects, onCreateProject, onRefreshProjects, onRegisterProject,
  onStartProject, onStopProject, onOpenProject }: ProjectHomeProps): JSX.Element {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [reports, setReports] = useState<ReadonlyMap<string, ProjectHomeResult>>(() => new Map());
  const busy = useRef(false);

  const run: RunOperation = async (key, reportKey, operation) => {
    if (busy.current) return PROJECT_HOME_LOCAL_REFUSAL;
    busy.current = true;
    setBusyKey(key);
    let result: ProjectHomeResult;
    try { result = safeResult(await operation()); }
    catch { result = PROJECT_HOME_LOCAL_REFUSAL; }
    busy.current = false;
    setBusyKey(null);
    setReports((current) => new Map(current).set(reportKey, result));
    return result;
  };

  return (
    <main className="cr2-project-home">
      <header className="cr2-project-home-header">
        <div><p>ON THIS COMPUTER</p><h2>Projects</h2></div>
        <div className="cr2-project-home-tools">
          <p>A project is a folder on this computer that Moe runs for you. Add one below, then press Start.</p>
          <button disabled={busyKey !== null} onClick={() => {
            void run("refresh", "refresh", onRefreshProjects);
          }} type="button">{busyKey === "refresh" ? "Refreshing" : "Refresh"}</button>
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
        <ul data-testid="cr.projects.list">
          {projects.map((project) => <ProjectRow busyKey={busyKey} key={project.instanceId}
            onOpen={onOpenProject} onStart={onStartProject} onStop={onStopProject} project={project}
            report={reports.get(`project:${project.instanceId}`)} run={run} />)}
        </ul>
      </section> : null}
    </main>
  );
}
