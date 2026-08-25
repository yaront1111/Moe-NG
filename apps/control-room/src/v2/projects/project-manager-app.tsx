import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

import "../cordum-fonts.js";
import "../styles/cordum-tokens.css";
import "../styles/cordum-shell.css";
import { PairingConfirmation } from "../live/pairing-confirmation.js";
import { ProjectHome } from "./project-home.js";
import type { ProjectHomeResult } from "./project-home.js";
import { PROJECT_MANAGER_LOCAL_LAYER } from "./project-manager-client.js";
import type {
  ProjectManagerClient,
  ProjectManagerConnection,
  ProjectManagerOpenWindow,
  ProjectManagerProject,
  ProjectManagerRefusal,
  ProjectManagerPairingPending,
} from "./project-manager-client.js";

const APP_REFUSAL: ProjectManagerRefusal = Object.freeze({
  code: "PROJECT_MANAGER_CONNECT_FAILED",
  layer: PROJECT_MANAGER_LOCAL_LAYER,
  ok: false,
});
const STABLE_NAME = /^[A-Z][A-Z0-9_]*$/u;
export const PROJECT_MANAGER_REFRESH_INTERVAL_MS = 2_000;

type Resolution =
  | { readonly status: "PENDING" }
  | { readonly busy: boolean; readonly pairing: ProjectManagerPairingPending; readonly status: "PAIRING" }
  | { readonly refusal: ProjectManagerRefusal; readonly status: "REFUSED" }
  | {
    readonly client: ProjectManagerClient;
    readonly projects: readonly ProjectManagerProject[];
    readonly status: "READY";
  };

export interface ProjectManagerAppProps {
  /** Prepared once before React so StrictMode cannot duplicate a one-use request. */
  readonly prepared: Promise<ProjectManagerConnection>;
  readonly openWindow?: ProjectManagerOpenWindow | undefined;
}

function stableRefusal(value: ProjectManagerRefusal): ProjectManagerRefusal {
  if (!value.ok && STABLE_NAME.test(value.code) && STABLE_NAME.test(value.layer)) {
    return { code: value.code, layer: PROJECT_MANAGER_LOCAL_LAYER, ok: false };
  }
  return APP_REFUSAL;
}

function isPairingPending(value: ProjectManagerConnection): value is ProjectManagerPairingPending {
  return "status" in value && value.status === "AWAITING_OPERATOR";
}

function defaultOpenWindow(): ReturnType<ProjectManagerOpenWindow> {
  try {
    return window.open("", "_blank") as ReturnType<ProjectManagerOpenWindow>;
  } catch { return null; }
}

function ManagerNotice({ refusal }: { readonly refusal?: ProjectManagerRefusal }): JSX.Element {
  const refused = refusal !== undefined;
  return (
    <main className="cr2-project-home">
      <header className="cr2-project-home-header">
        <div>
          <p>WINDOWS PROJECT CONTROL</p>
          <h2>{refused ? "Project manager unavailable" : "Connecting to project manager"}</h2>
        </div>
        <p>{refused
          ? "Open the manager origin and request pairing again. No project data was loaded."
          : "Checking the local manager session. No project data is shown until it answers."}</p>
      </header>
      {refused ? <p className="cr2-project-report is-refused" role="alert">
        {refusal.code} @ {refusal.layer}
      </p> : null}
    </main>
  );
}

export function ProjectManagerApp({ prepared, openWindow = defaultOpenWindow }:
  ProjectManagerAppProps): JSX.Element {
  const [resolution, setResolution] = useState<Resolution>({ status: "PENDING" });
  const [refreshRefusal, setRefreshRefusal] = useState<ProjectManagerRefusal | null>(null);

  useEffect(() => {
    let cancelled = false;
    void prepared.then((result) => {
      if (cancelled) return;
      if (isPairingPending(result)) {
        setResolution({ busy: false, pairing: result, status: "PAIRING" });
      } else if (result.ok) {
        setResolution({ client: result.client, projects: result.projects, status: "READY" });
      } else setResolution({ refusal: stableRefusal(result), status: "REFUSED" });
    }, () => {
      if (!cancelled) setResolution({ refusal: APP_REFUSAL, status: "REFUSED" });
    });
    return (): void => { cancelled = true; };
  }, [prepared]);

  const claimPairing = useCallback((): void => {
    if (resolution.status !== "PAIRING" || resolution.busy) return;
    const pairing = resolution.pairing;
    setResolution({ busy: true, pairing, status: "PAIRING" });
    void pairing.claim().then((result) => {
      if (isPairingPending(result)) {
        setResolution({ busy: false, pairing: result, status: "PAIRING" });
      } else if (result.ok) {
        setResolution({ client: result.client, projects: result.projects, status: "READY" });
      } else setResolution({ refusal: stableRefusal(result), status: "REFUSED" });
    }, () => { setResolution({ refusal: APP_REFUSAL, status: "REFUSED" }); });
  }, [resolution]);

  const refresh = useCallback(async (client: ProjectManagerClient): Promise<ProjectHomeResult> => {
    let result: Awaited<ReturnType<ProjectManagerClient["listProjects"]>>;
    try { result = await client.listProjects(); }
    catch { setRefreshRefusal(APP_REFUSAL); return APP_REFUSAL; }
    if (result.ok) {
      setRefreshRefusal(null);
      setResolution({ client, projects: result.projects, status: "READY" });
      return { code: "PROJECT_MANAGER_PROJECTS_REFRESHED", layer: PROJECT_MANAGER_LOCAL_LAYER, ok: true };
    }
    const refused = stableRefusal(result);
    setRefreshRefusal(refused);
    return refused;
  }, []);

  const run = useCallback(async (operation: () => Promise<ProjectHomeResult>): Promise<ProjectHomeResult> => {
    const result = await operation();
    if (result.ok && resolution.status === "READY") await refresh(resolution.client);
    return result;
  }, [refresh, resolution]);

  useEffect(() => {
    if (resolution.status !== "READY" || !resolution.projects.some(({ lifecycle }) =>
      lifecycle === "RUNNING" || lifecycle === "STARTING" || lifecycle === "STOPPING")) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      await refresh(resolution.client);
      if (!cancelled) timer = setTimeout(() => { void poll(); }, PROJECT_MANAGER_REFRESH_INTERVAL_MS);
    };
    timer = setTimeout(() => { void poll(); }, PROJECT_MANAGER_REFRESH_INTERVAL_MS);
    return (): void => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [refresh, resolution]);

  const connection = resolution.status === "READY" ? "CONNECTED"
    : resolution.status === "REFUSED" ? "DISCONNECTED" : "OFFLINE";
  let body: JSX.Element;
  if (resolution.status === "PENDING") body = <ManagerNotice />;
  else if (resolution.status === "PAIRING") body = <PairingConfirmation
    busy={resolution.busy}
    confirmationLabel={resolution.pairing.confirmationLabel}
    onConfirm={claimPairing}
    scope="manager"
  />;
  else if (resolution.status === "REFUSED") body = <ManagerNotice refusal={resolution.refusal} />;
  else {
    const client = resolution.client;
    body = <>
      {refreshRefusal === null ? null : <p className="cr2-project-report is-refused" role="alert">
        {refreshRefusal.code} @ {refreshRefusal.layer}
      </p>}
      <ProjectHome
        onCreateProject={(input) => run(() => client.createProject(input))}
        onOpenProject={(instanceId) => client.openProject(instanceId, openWindow)}
        onRefreshProjects={() => refresh(client)}
        onRegisterProject={(input) => run(() => client.registerProject(input))}
        onStartProject={(instanceId) => run(() => client.startProject(instanceId))}
        onStopProject={(instanceId) => run(() => client.stopProject(instanceId))}
        projects={resolution.projects}
      />
    </>;
  }

  return (
    <div className="cr2-shell cr2-manager-root" data-connection={connection} data-testid="cr.manager.root">
      <div className="cr2-brand" aria-label="Moe project manager">
        <span aria-hidden="true" className="cr2-brand-mark">M</span>
        <span className="cr2-brand-name">Moe</span>
        <span className="cr2-brand-version">PROJECTS</span>
      </div>
      {body}
    </div>
  );
}
