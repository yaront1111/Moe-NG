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

function ResultReport({ result }: { readonly result: ProjectHomeResult | undefined }): JSX.Element | null {
  if (result === undefined) return null;
  return (
    <p className={`cr2-project-report ${result.ok ? "is-ok" : "is-refused"}`}
      role={result.ok ? "status" : "alert"}>
      {result.code} @ {result.layer}
    </p>
  );
}

interface IntakeFormProps {
  readonly busyKey: string | null;
  readonly kind: "create" | "register";
  readonly onSubmit: ProjectHomeProps["onCreateProject"];
  readonly report: ProjectHomeResult | undefined;
  readonly run: RunOperation;
}

function IntakeForm({ busyKey, kind, onSubmit, report, run }: IntakeFormProps): JSX.Element {
  const titleId = useId();
  const rootId = useId();
  const [title, setTitle] = useState("");
  const [root, setRoot] = useState("");
  const key = `intake:${kind}`;
  const isCreate = kind === "create";
  const isBusy = busyKey === key;
  const blocked = busyKey !== null;
  const ready = title.trim() !== "" && root.trim() !== "";

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!ready || blocked) return;
    const result = await run(key, key, () => onSubmit({ root: root.trim(), title: title.trim() }));
    if (result.ok) {
      setRoot("");
      setTitle("");
    }
  };

  return (
    <form aria-label={isCreate ? "Create a new project" : "Register an existing Windows folder"}
      className="cr2-project-intake" onSubmit={(event) => { void submit(event); }}>
      <div>
        <p className="cr2-project-intake-kicker">{isCreate ? "NEW WORKSPACE" : "EXISTING WORKSPACE"}</p>
        <h3>{isCreate ? "Create a new project" : "Register a Windows folder"}</h3>
      </div>
      <label htmlFor={titleId}>Project title</label>
      <input autoComplete="off" disabled={blocked} id={titleId}
        onChange={(event) => { setTitle(event.currentTarget.value); }} required value={title} />
      <label htmlFor={rootId}>{isCreate ? "New Windows folder" : "Existing Windows folder"}</label>
      <input autoComplete="off" disabled={blocked} id={rootId}
        onChange={(event) => { setRoot(event.currentTarget.value); }} placeholder="C:\\work\\project"
        required spellCheck={false} value={root} />
      <button disabled={!ready || blocked} type="submit">
        {isBusy ? (isCreate ? "Creating project" : "Registering folder")
          : (isCreate ? "Create project" : "Register folder")}
      </button>
      <ResultReport result={report} />
    </form>
  );
}

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
        <div>
          <h3>{title}</h3>
          <span className="cr2-project-id">{projectId}</span>
          <span className="cr2-project-instance">INSTANCE {instanceId}</span>
        </div>
        <span className="cr2-project-lifecycle" data-testid="cr.projects.lifecycle">{lifecycle}</span>
      </div>
      <div className="cr2-project-root"><span>WINDOWS ROOT</span><code>{root}</code></div>
      {lifecycle === "UNKNOWN" ? <p className="cr2-project-unknown">Project status is unavailable. Actions remain locked until authority returns.</p> : null}
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
        <div><p>QUIET ORCHESTRATION LEDGER</p><h2>Projects</h2></div>
        <div className="cr2-project-home-tools">
          <p>Create or register a Windows workspace, then start its isolated runtime.</p>
          <button disabled={busyKey !== null} onClick={() => {
            void run("refresh", "refresh", onRefreshProjects);
          }} type="button">{busyKey === "refresh" ? "Refreshing" : "Refresh"}</button>
        </div>
      </header>
      <ResultReport result={reports.get("refresh")} />
      {projects.length === 0 ? <section className="cr2-project-empty">
        <p>FIRST PROJECT</p><h2>Start your first project</h2>
        <span>No project instances are registered. Choose how this workspace should enter the ledger.</span>
      </section> : null}
      <section aria-label="Project intake" className="cr2-project-intake-grid">
        <IntakeForm busyKey={busyKey} kind="create" onSubmit={onCreateProject}
          report={reports.get("intake:create")} run={run} />
        <IntakeForm busyKey={busyKey} kind="register" onSubmit={onRegisterProject}
          report={reports.get("intake:register")} run={run} />
      </section>
      {projects.length > 0 ? <section aria-labelledby="cr2-project-ledger-heading" className="cr2-project-ledger">
        <div className="cr2-project-ledger-heading"><p>INSTANCE LEDGER</p><h2 id="cr2-project-ledger-heading">Project runtimes</h2></div>
        <ul data-testid="cr.projects.list">
          {projects.map((project) => <ProjectRow busyKey={busyKey} key={project.instanceId}
            onOpen={onOpenProject} onStart={onStartProject} onStop={onStopProject} project={project}
            report={reports.get(`project:${project.instanceId}`)} run={run} />)}
        </ul>
      </section> : null}
    </main>
  );
}
