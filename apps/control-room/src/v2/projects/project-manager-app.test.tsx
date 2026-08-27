import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { LiveHandshakeResult } from "../../live/live-handshake.js";
import { ClockProvider } from "../../performance/command-latency.js";
import { CordumApp } from "../cordum-app.js";
import { PairingConfirmation } from "../live/pairing-confirmation.js";
import { PROJECT_MANAGER_REFRESH_INTERVAL_MS, ProjectManagerApp } from "./project-manager-app.js";
import type { ProjectManagerAppProps } from "./project-manager-app.js";
import { PROJECT_MANAGER_LOCAL_LAYER } from "./project-manager-client.js";
import type {
  ProjectManagerClient,
  ProjectManagerConnection,
  ProjectManagerOpenWindow,
  ProjectManagerProject,
  ProjectManagerResult,
} from "./project-manager-client.js";

const UUID_STOPPED = "11111111-1111-4111-8111-111111111111";
const UUID_RUNNING = "22222222-2222-4222-8222-222222222222";
const ACCEPTED: ProjectManagerResult = {
  code: "PROJECT_OPERATION_ACCEPTED",
  layer: "PROJECT_MANAGER_HTTP",
  ok: true,
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function project(instanceId: string, lifecycle: ProjectManagerProject["lifecycle"], title: string): ProjectManagerProject {
  return { instanceId, lifecycle, projectId: title.toLowerCase(), root: `C:\\work\\${title.toLowerCase()}`, title };
}

function client(overrides: Partial<ProjectManagerClient> = {}): ProjectManagerClient {
  return {
    createProject: vi.fn().mockResolvedValue(ACCEPTED),
    listProjects: vi.fn().mockResolvedValue({ ok: true, projects: [] }),
    openProject: vi.fn().mockResolvedValue(ACCEPTED),
    registerProject: vi.fn().mockResolvedValue(ACCEPTED),
    startProject: vi.fn().mockResolvedValue(ACCEPTED),
    stopProject: vi.fn().mockResolvedValue(ACCEPTED),
    ...overrides,
  };
}

function ready(manager: ProjectManagerClient, projects: readonly ProjectManagerProject[] = []): ProjectManagerConnection {
  return { client: manager, ok: true, projects };
}

function renderApp(props: ProjectManagerAppProps): void {
  render(<ClockProvider clock={{ now: () => 0 }}><ProjectManagerApp {...props} /></ClockProvider>);
}

describe("ProjectManagerApp connection state", () => {
  it("renders an honest pending state until the pre-React connection resolves", () => {
    renderApp({ prepared: new Promise(() => undefined) });

    expect(screen.getByRole("heading", { name: "Connecting to project manager" })).toBeTruthy();
    const root = screen.getByTestId("cr.manager.root");
    expect(root.getAttribute("data-connection")).toBe("OFFLINE");
    expect(root.classList.contains("cr2-manager-root")).toBe(true);
    expect(root.getAttribute("style")).toBeNull();
    expect(screen.queryByTestId("cr.projects.list")).toBeNull();
  });

  it("shows only the stable refusal code and layer when pairing or connection refuses", async () => {
    renderApp({ prepared: Promise.resolve({
      code: "PROJECT_MANAGER_PAIRING_REFUSED",
      layer: PROJECT_MANAGER_LOCAL_LAYER,
      ok: false,
      secretDetail: "must never render",
    } as ProjectManagerConnection) });

    const alert = await screen.findByRole("alert");
    expect(screen.getByRole("heading", { name: "Project manager unavailable" })).toBeTruthy();
    expect(alert.textContent).toBe("PROJECT_MANAGER_PAIRING_REFUSED @ CONTROL_ROOM_PROJECT_MANAGER");
    expect(document.body.textContent).not.toContain("must never render");
    expect(screen.getByTestId("cr.manager.root").getAttribute("data-connection")).toBe("DISCONNECTED");
  });

  it("renders the server-owned project ledger when the cookie-backed session is ready", async () => {
    const manager = client();
    renderApp({ prepared: Promise.resolve(ready(manager, [project(UUID_STOPPED, "STOPPED", "Atlas")])) });

    expect(await screen.findByRole("heading", { name: "Atlas" })).toBeTruthy();
    expect(screen.getByText("C:\\work\\atlas")).toBeTruthy();
    expect(screen.getByTestId("cr.manager.root").getAttribute("data-connection")).toBe("CONNECTED");
    expect(screen.getByLabelText("Moe project manager").textContent).toContain("PROJECTS");
  });
});

describe("ProjectManagerApp project operations", () => {
  it("polls a running project so asynchronous exits cannot leave a stale RUNNING ledger", async () => {
    vi.useFakeTimers();
    const listProjects = vi.fn().mockResolvedValue({
      ok: true,
      projects: [project(UUID_RUNNING, "FAILED", "Beacon")],
    });
    const manager = client({ listProjects });
    renderApp({ prepared: Promise.resolve(ready(manager, [project(UUID_RUNNING, "RUNNING", "Beacon")])) });
    await act(async () => { await Promise.resolve(); });

    await act(async () => { await vi.advanceTimersByTimeAsync(PROJECT_MANAGER_REFRESH_INTERVAL_MS); });

    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("cr.projects.lifecycle").textContent).toBe("FAILED");
  });

  it("refreshes the project ledger after every successful create, register, start, and stop", async () => {
    const user = userEvent.setup();
    const listProjects = vi.fn().mockResolvedValue({
      ok: true,
      projects: [
        project(UUID_STOPPED, "STOPPED", "Atlas"),
        project(UUID_RUNNING, "RUNNING", "Beacon"),
      ],
    });
    const manager = client({ listProjects });
    renderApp({ prepared: Promise.resolve(ready(manager, [
      project(UUID_STOPPED, "STOPPED", "Atlas"),
      project(UUID_RUNNING, "RUNNING", "Beacon"),
    ])) });
    await screen.findByRole("heading", { name: "Atlas" });

    const create = screen.getByRole("form", { name: "Create a new project" });
    await user.type(within(create).getByLabelText("Project title"), "Nova");
    await user.type(within(create).getByLabelText("New Windows folder"), "C:\\work\\nova");
    await user.click(within(create).getByRole("button", { name: "Create project" }));
    await waitFor(() => { expect(listProjects).toHaveBeenCalledTimes(1); });

    const register = screen.getByRole("form", { name: "Register an existing Windows folder" });
    await user.type(within(register).getByLabelText("Project title"), "Existing");
    await user.type(within(register).getByLabelText("Existing Windows folder"), "D:\\repos\\existing");
    await user.click(within(register).getByRole("button", { name: "Register folder" }));
    await waitFor(() => { expect(listProjects).toHaveBeenCalledTimes(2); });

    await user.click(screen.getByRole("button", { name: "Start Atlas" }));
    await waitFor(() => { expect(listProjects).toHaveBeenCalledTimes(3); });
    await user.click(screen.getByRole("button", { name: "Stop Beacon" }));
    await waitFor(() => { expect(listProjects).toHaveBeenCalledTimes(4); });

    expect(manager.createProject).toHaveBeenCalledWith({ root: "C:\\work\\nova", title: "Nova" });
    expect(manager.registerProject).toHaveBeenCalledWith({ root: "D:\\repos\\existing", title: "Existing" });
    expect(manager.startProject).toHaveBeenCalledWith(UUID_STOPPED);
    expect(manager.stopProject).toHaveBeenCalledWith(UUID_RUNNING);
  });

  it("passes the synchronously callable blank-window factory into open", async () => {
    const user = userEvent.setup();
    const openProject = vi.fn().mockResolvedValue(ACCEPTED);
    const manager = client({ openProject });
    const openWindow: ProjectManagerOpenWindow = vi.fn(() => null);
    renderApp({
      openWindow,
      prepared: Promise.resolve(ready(manager, [project(UUID_RUNNING, "RUNNING", "Beacon")])),
    });

    await user.click(await screen.findByRole("button", { name: "Open Beacon" }));

    expect(openProject).toHaveBeenCalledTimes(1);
    expect(openProject).toHaveBeenCalledWith(UUID_RUNNING, openWindow);
  });

  it("keeps the last proven ledger visible and reports a refresh refusal", async () => {
    const user = userEvent.setup();
    const manager = client({
      listProjects: vi.fn().mockResolvedValue({
        code: "PROJECT_MANAGER_PROJECTS_UNAVAILABLE",
        layer: PROJECT_MANAGER_LOCAL_LAYER,
        ok: false,
      }),
    });
    renderApp({ prepared: Promise.resolve(ready(manager, [project(UUID_STOPPED, "STOPPED", "Atlas")])) });

    await user.click(await screen.findByRole("button", { name: "Start Atlas" }));

    expect(await screen.findByRole("heading", { name: "Atlas" })).toBeTruthy();
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((alert) => alert.textContent ===
      "PROJECT_MANAGER_PROJECTS_UNAVAILABLE @ CONTROL_ROOM_PROJECT_MANAGER")).toBe(true);
  });
});

/**
 * The two arms below are a divergence pair: the manager copy comes from the call
 * site's `scope="manager"`, the daemon copy from the parameter default. Each
 * mutant must red exactly one of them.
 */
describe("task-999a363f PairingConfirmation scope", () => {
  const LABEL = "abcd-ef01-2345";
  const PAIRING_REQUEST_ID = "ab".repeat(32);

  it("renders the manager pairing copy when the app drives its own pairing branch", async () => {
    renderApp({ prepared: Promise.resolve({
      claim: vi.fn(),
      confirmationLabel: LABEL,
      requestId: PAIRING_REQUEST_ID,
      status: "AWAITING_OPERATOR",
    } as ProjectManagerConnection) });

    expect(await screen.findByRole("heading", {
      name: "Pair this browser with Moe Projects",
    })).toBeTruthy();
    expect(screen.getByText(
      "Type this exact label into the foreground terminal that launched the project manager.",
    )).toBeTruthy();
    expect(screen.queryByText(/INSTANCE id and one space/u)).toBeNull();

    const label = screen.getByLabelText("Pairing confirmation label");
    expect(label.tagName).toBe("OUTPUT");
    expect(label.textContent).toBe(LABEL);
    expect(document.body.textContent).not.toContain(PAIRING_REQUEST_ID);
    // The manager scope owns its document's main landmark: ProjectManagerApp's
    // root is a div and its other branches are mutually exclusive with PAIRING.
    expect(document.querySelectorAll("main")).toHaveLength(1);
    // The accessible name rides the section, which `region` can carry - a
    // generic wrapper cannot, so the daemon arm below would lose it silently.
    expect(screen.getByRole("region", { name: "Pair this browser with Moe Projects" })).toBeTruthy();
  });

  it("renders the daemon pairing copy when no scope is passed", () => {
    render(<PairingConfirmation confirmationLabel={LABEL} onConfirm={() => undefined} />);

    expect(screen.getByRole("heading", { name: "Pair this browser with Moe" })).toBeTruthy();
    expect(screen.getByText(
      "Type this exact label into the foreground terminal that launched this project.",
    )).toBeTruthy();
    expect(screen.getByText(/INSTANCE id and one space/u)).toBeTruthy();
    // The daemon consumer nests this inside CordumShell's <main>, so the daemon
    // scope must contribute no main landmark of its own - but the named region
    // survives the swap, which is what keeps the heading reachable.
    expect(document.querySelectorAll("main")).toHaveLength(0);
    expect(screen.getByRole("region", { name: "Pair this browser with Moe" })).toBeTruthy();
  });

  /**
   * The seam arm. The two arms above render PairingConfirmation without its only
   * pre-existing consumer, so neither can see nesting introduced at the consumer
   * edge. This one drives the real daemon path: CordumApp -> CordumShell's
   * <main> -> PairingConfirmation with no scope.
   */
  it("nests no second main landmark inside the daemon shell at the CordumApp seam", async () => {
    const pending: Promise<LiveHandshakeResult> = Promise.resolve({
      claim: vi.fn(async () => ({
        code: "LIVE_PAIRING_REFUSED" as const, detail: "approval still required", ok: false as const,
      })),
      confirmationLabel: LABEL,
      status: "AWAITING_OPERATOR",
    });

    render(<CordumApp liveSetup={pending} search="" />);

    expect(await screen.findByText(LABEL)).toBeTruthy();
    expect(document.querySelectorAll("main main")).toHaveLength(0);
    expect(document.querySelectorAll("main")).toHaveLength(1);
    // classList.contains, not an exact className: task-15ca5c44 edits this
    // shell next, and an added class there must not red an arm it does not own.
    expect(document.querySelector("main")?.classList.contains("cr2-main")).toBe(true);
  });
});
