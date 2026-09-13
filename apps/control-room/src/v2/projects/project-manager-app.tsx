import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import "../cordum-fonts.js";
import "../styles/cordum-tokens.css";
import "../styles/cordum-shell.css";
import "./project-manager.css";
import { PairingConfirmation } from "../live/pairing-confirmation.js";
import { ProjectHome, ResultReport } from "./project-home.js";
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
  /** Injected like `openWindow` so the retry stays observable without navigating a test. */
  readonly reloadPage?: (() => void) | undefined;
}

function stableRefusal(value: ProjectManagerRefusal): ProjectManagerRefusal {
  if (!value.ok && value.code === "OPERATOR_CHANNEL_UNAVAILABLE" && value.layer === "PROJECT_MANAGER_HTTP") {
    return { code: value.code, layer: value.layer, ok: false };
  }
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

function defaultReloadPage(): void {
  try { window.location.reload(); } catch { /* the browser owns navigation; nothing to report */ }
}

/**
 * projects-11. "Open the manager origin and request pairing again" named neither
 * a control the owner has nor a word they use. Reloading the tab is the only real
 * retry - `main.tsx` starts a fresh `connectProjectManager` per document - so it
 * is named and offered. The button is browser-side navigation only: it asks the
 * daemon for nothing and asserts nothing about why the answer went missing.
 */
function ManagerNotice({ onReload, refusal }: {
  readonly onReload?: () => void;
  readonly refusal?: ProjectManagerRefusal;
}): JSX.Element {
  if (refusal === undefined) {
    return (
      <main className="cr2-project-home">
        <header className="cr2-project-home-header">
          <div>
            <p>CONNECTION</p>
            {/* Pinned by the no-touch entry-project-manager.test.tsx divergence pair
                (:81 absence off the manager host, :104 presence on it), so this
                heading stays verbatim; projects-11 rewrites the copy under it. */}
            <h2>Connecting to project manager</h2>
          </div>
          <p>Nothing is shown until Moe Projects answers.</p>
        </header>
      </main>
    );
  }
  return (
    <main className="cr2-project-home">
      <header className="cr2-project-home-header">
        <div>
          <p>CONNECTION</p>
          {/* Seven refusals land here and four of them are answers Moe Projects
              did send, so the heading states the state only. The one cause
              statement is the ResultReport sentence directly beneath it. */}
          <h2>No projects loaded</h2>
        </div>
      </header>
      <section className="cr2-project-empty cr2-manager-notice">
        <ResultReport result={refusal} />
        <p>No project list was loaded, so this page is showing you nothing rather than a guess.</p>
        <button className="is-primary" onClick={onReload} type="button">Reload this page</button>
      </section>
    </main>
  );
}

export function ProjectManagerApp({ prepared, openWindow = defaultOpenWindow,
  reloadPage = defaultReloadPage }: ProjectManagerAppProps): JSX.Element {
  const [resolution, setResolution] = useState<Resolution>({ status: "PENDING" });
  const [refreshRefusal, setRefreshRefusal] = useState<ProjectManagerRefusal | null>(null);
  const mounted = useRef(false);
  const readGeneration = useRef(0);
  const connectionScope = useRef({ prepared, version: 0 });
  if (connectionScope.current.prepared !== prepared) {
    connectionScope.current = { prepared, version: connectionScope.current.version + 1 };
    readGeneration.current += 1;
  }

  useEffect(() => {
    let cancelled = false;
    mounted.current = true;
    setResolution({ status: "PENDING" });
    setRefreshRefusal(null);
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
    return (): void => { cancelled = true; mounted.current = false; readGeneration.current += 1; };
  }, [prepared]);

  const claimPairing = useCallback((): void => {
    if (!mounted.current || connectionScope.current.prepared !== prepared
      || resolution.status !== "PAIRING" || resolution.busy) return;
    const pairing = resolution.pairing;
    setResolution({ busy: true, pairing, status: "PAIRING" });
    void pairing.claim().then((result) => {
      if (!mounted.current || connectionScope.current.prepared !== prepared) return;
      if (isPairingPending(result)) {
        setResolution({ busy: false, pairing: result, status: "PAIRING" });
      } else if (result.ok) {
        setResolution({ client: result.client, projects: result.projects, status: "READY" });
      } else setResolution({ refusal: stableRefusal(result), status: "REFUSED" });
    }, () => {
      if (mounted.current && connectionScope.current.prepared === prepared) {
        setResolution({ refusal: APP_REFUSAL, status: "REFUSED" });
      }
    });
  }, [prepared, resolution]);

  /**
   * Three paths refresh the list: the poll, the reload after an accepted
   * operation, and the owner's own Refresh press. ProjectHome reports the press
   * itself under its button, so with `reportHere` false a refusal is returned
   * and not also shown by this frame - one refusal, one alert - and any
   * frame-level refusal still standing is cleared so it cannot pair with the new one.
   */
  const refresh = useCallback(async (client: ProjectManagerClient, reportHere = true): Promise<ProjectHomeResult | null> => {
    if (!mounted.current || connectionScope.current.prepared !== prepared) return null;
    const generation = ++readGeneration.current;
    const current = (): boolean => mounted.current && connectionScope.current.prepared === prepared
      && generation === readGeneration.current;
    if (!reportHere) setRefreshRefusal(null);
    const report = (refusal: ProjectManagerRefusal): void => { if (reportHere) setRefreshRefusal(refusal); };
    let result: Awaited<ReturnType<ProjectManagerClient["listProjects"]>>;
    try { result = await client.listProjects(); }
    catch {
      if (!current()) return null;
      report(APP_REFUSAL); return APP_REFUSAL;
    }
    if (!current()) return null;
    if (result.ok) {
      setRefreshRefusal(null);
      setResolution({ client, projects: result.projects, status: "READY" });
      return { code: "PROJECT_MANAGER_PROJECTS_REFRESHED", layer: PROJECT_MANAGER_LOCAL_LAYER, ok: true };
    }
    const refused = stableRefusal(result);
    report(refused);
    return refused;
  }, [prepared]);

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
  else if (resolution.status === "REFUSED") {
    body = <ManagerNotice onReload={reloadPage} refusal={resolution.refusal} />;
  }
  else {
    const client = resolution.client;
    body = <>
      <ResultReport result={refreshRefusal ?? undefined} />
      <ProjectHome
        key={connectionScope.current.version}
        onCreateProject={(input) => run(() => client.createProject(input))}
        onOpenProject={(instanceId) => client.openProject(instanceId, openWindow)}
        onRefreshProjects={() => refresh(client, false)}
        onRegisterProject={(input) => run(() => client.registerProject(input))}
        onStartProject={(instanceId) => run(() => client.startProject(instanceId))}
        onStopProject={(instanceId) => run(() => client.stopProject(instanceId))}
        projects={resolution.projects}
      />
    </>;
  }

  return (
    <div className="cr2-shell cr2-manager-root" data-connection={connection} data-testid="cr.manager.root">
      <header className="cr2-manager-header" aria-label="Moe project manager">
        <div className="cr2-brand">
          <span aria-hidden="true" className="cr2-brand-mark">M</span>
          <span className="cr2-brand-name">Moe</span>
          <span className="cr2-brand-version">PROJECTS</span>
        </div>
      </header>
      <div className="cr2-manager-content">
        <div className="cr2-manager-body">{body}</div>
      </div>
    </div>
  );
}
