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
  ProjectManagerRefusal,
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

function renderApp(props: ProjectManagerAppProps): ReturnType<typeof render> {
  return render(<ClockProvider clock={{ now: () => 0 }}><ProjectManagerApp {...props} /></ClockProvider>);
}

describe("ProjectManagerApp connection state", () => {
  it("renders an honest pending state until the pre-React connection resolves", () => {
    renderApp({ prepared: new Promise(() => undefined) });

    // Verbatim by the no-touch entry-project-manager.test.tsx pins (:81, :104).
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
    expect(screen.getByRole("heading", { name: "No projects loaded" })).toBeTruthy();
    // projects-09: the code is still exactly the daemon's, now behind Details.
    expect(alert.firstElementChild?.textContent).toBe("Pairing with Moe Projects did not go through.");
    expect(within(alert).getByText("PROJECT_MANAGER_PAIRING_REFUSED @ CONTROL_ROOM_PROJECT_MANAGER"))
      .toBeTruthy();
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

/**
 * projects-11. The unavailable notice told the owner to "Open the manager origin
 * and request pairing again" and gave them no control to press. Reloading the tab
 * is the one retry that exists (main.tsx re-runs connectProjectManager), so the
 * notice now names it and offers it as a button.
 */
describe("projects-11 ProjectManagerApp offers the retry it names", () => {
  it("drops the origin-and-session wording for a plain sentence and a Reload button", async () => {
    const user = userEvent.setup();
    const reloadPage = vi.fn();
    renderApp({ prepared: Promise.resolve({
      code: "PROJECT_MANAGER_BOOTSTRAP_UNAVAILABLE",
      layer: PROJECT_MANAGER_LOCAL_LAYER,
      ok: false,
    } as ProjectManagerConnection), reloadPage });

    const alert = await screen.findByRole("alert");
    expect(alert.firstElementChild?.textContent).toBe("This page could not reach Moe Projects.");
    expect(document.body.textContent).not.toContain("manager origin");
    expect(document.body.textContent).not.toContain("request pairing again");
    expect(screen.getByText(/No project list was loaded/u)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Reload this page" }));

    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it("says it is waiting, not that a session is being checked, and offers nothing to press", () => {
    renderApp({ prepared: new Promise(() => undefined) });

    expect(screen.getByText(/Nothing is shown until Moe Projects answers/u)).toBeTruthy();
    expect(document.body.textContent).not.toContain("manager session");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

/**
 * Seven refusals reach this one notice: six from `connectProjectManager`
 * (bootstrapUnavailable, bootstrapMalformed, protocolMismatch, pairingRefused,
 * and projectsUnavailable / projectsMalformed through `ready()`) plus the app's
 * own connectFailed when the prepared promise rejects. Four of them are answers
 * Moe Projects did send, so a heading that names a cause is contradicted word for
 * word by the ResultReport directly beneath it. The heading therefore states the
 * state and nothing else; the frame's sentence is the only cause statement.
 */
describe("projects-11 the refused notice heading names no cause", () => {
  const REFUSALS: readonly (readonly [code: string, said: string])[] = Object.freeze([
    ["PROJECT_MANAGER_BOOTSTRAP_UNAVAILABLE", "This page could not reach Moe Projects."],
    ["PROJECT_MANAGER_CONNECT_FAILED", "This page could not reach Moe Projects."],
    ["PROJECT_MANAGER_BOOTSTRAP_MALFORMED", "Moe Projects answered in a way this page could not read."],
    ["PROJECT_MANAGER_PROTOCOL_MISMATCH", "This page and Moe Projects are different versions."],
    ["PROJECT_MANAGER_PAIRING_REFUSED", "Pairing with Moe Projects did not go through."],
    ["PROJECT_MANAGER_PROJECTS_UNAVAILABLE", "Moe Projects did not send the project list."],
    ["PROJECT_MANAGER_PROJECTS_MALFORMED", "Moe Projects sent a project list this page could not read."],
  ]);

  async function notice(code: string): Promise<readonly [heading: string, said: string]> {
    const refusal: ProjectManagerRefusal = { code, layer: PROJECT_MANAGER_LOCAL_LAYER, ok: false };
    const view = renderApp({ prepared: Promise.resolve(refusal), reloadPage: () => undefined });
    const scope = within(view.container);
    const said = (await scope.findByRole("alert")).firstElementChild?.textContent ?? "";
    const heading = scope.getByRole("heading", { level: 2 }).textContent ?? "";
    view.unmount();
    return [heading, said];
  }

  it("holds one cause-free heading over every sentence this notice can carry", async () => {
    const headings: string[] = [];
    const sentences: string[] = [];

    for (const [code, expected] of REFUSALS) {
      const [heading, said] = await notice(code);
      expect(said).toBe(expected);
      headings.push(heading);
      sentences.push(said);
    }

    // Control: the cause really does vary per code, so one invariant heading is a
    // property of the heading and not an artifact of seven identical frames.
    expect(new Set(sentences).size).toBe(6);
    expect([...new Set(headings)]).toEqual(["No projects loaded"]);
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
    // projects-10: the chip says the word, the daemon's token stays on the attribute.
    expect(screen.getByTestId("cr.projects.lifecycle").getAttribute("data-lifecycle")).toBe("FAILED");
    expect(screen.getByTestId("cr.projects.lifecycle").textContent).toBe("Failed");
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

    // projects-10: one intake form; the radio choice picks the daemon endpoint.
    const form = screen.getByRole("form", { name: "Add a project" });
    await user.type(within(form).getByLabelText("Name for this project"), "Nova");
    await user.type(within(form).getByLabelText("Folder on this computer"), "C:\\work\\nova");
    await user.click(within(form).getByRole("button", { name: "Add project" }));
    await waitFor(() => { expect(listProjects).toHaveBeenCalledTimes(1); });

    await user.click(within(form).getByRole("radio", { name: /Moe already set this folder up/u }));
    await user.type(within(form).getByLabelText("Name for this project"), "Existing");
    await user.type(within(form).getByLabelText("Folder on this computer"), "D:\\repos\\existing");
    await user.click(within(form).getByRole("button", { name: "Add project" }));
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
    // projects-09: sentence first, the daemon's own code verbatim behind Details.
    // Exactly one alert: the reload after an accepted Start is the frame's to
    // report, and ProjectHome's own box under the row carries the Start's ok.
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.firstElementChild?.textContent).toBe("Moe Projects did not send the project list.");
    expect(alerts[0]?.textContent).toContain("PROJECT_MANAGER_PROJECTS_UNAVAILABLE @ CONTROL_ROOM_PROJECT_MANAGER");
    expect(alerts[0]?.closest("main.cr2-project-home")).toBeNull();
  });
});

/**
 * Three paths refresh the list: the poll, the reload after an accepted
 * operation, and the owner's own Refresh press. ProjectHome reports the press
 * itself under its Refresh button, so the frame must not report that refusal
 * a second time - the owner used to read one refusal as two alert panels with
 * two identical Details, and a screen reader announced it twice.
 */
describe("ProjectManagerApp reports each refresh refusal once", () => {
  const UNAVAILABLE: ProjectManagerRefusal = {
    code: "PROJECT_MANAGER_PROJECTS_UNAVAILABLE", layer: PROJECT_MANAGER_LOCAL_LAYER, ok: false,
  };

  it("leaves an explicit Refresh refusal to ProjectHome alone", async () => {
    const user = userEvent.setup();
    const manager = client({ listProjects: vi.fn().mockResolvedValue(UNAVAILABLE) });
    renderApp({ prepared: Promise.resolve(ready(manager, [project(UUID_STOPPED, "STOPPED", "Atlas")])) });

    await user.click(await screen.findByRole("button", { name: "Refresh" }));

    const alerts = await screen.findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.firstElementChild?.textContent).toBe("Moe Projects did not send the project list.");
    expect(alerts[0]?.closest("main.cr2-project-home")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Atlas" })).toBeTruthy();
  });

  it("clears a frame-level refusal the moment the owner presses Refresh, so a stale one cannot pair with the new one", async () => {
    const user = userEvent.setup();
    const listProjects = vi.fn().mockResolvedValue(UNAVAILABLE);
    const manager = client({ listProjects });
    renderApp({ prepared: Promise.resolve(ready(manager, [project(UUID_STOPPED, "STOPPED", "Atlas")])) });

    // First the reload after an accepted Start refuses: that one is the frame's.
    await user.click(await screen.findByRole("button", { name: "Start Atlas" }));
    await waitFor(() => { expect(screen.getAllByRole("alert")).toHaveLength(1); });
    expect(screen.getByRole("alert").closest("main.cr2-project-home")).toBeNull();

    // Then the owner presses Refresh and it refuses again: still one alert, ProjectHome's.
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(screen.getAllByRole("alert").map((alert) => alert.closest("main.cr2-project-home") !== null))
        .toEqual([true]);
    });
  });

  it("reports a poll refusal at the frame, where no button of the owner's caused it", async () => {
    vi.useFakeTimers();
    const manager = client({ listProjects: vi.fn().mockResolvedValue(UNAVAILABLE) });
    renderApp({ prepared: Promise.resolve(ready(manager, [project(UUID_RUNNING, "RUNNING", "Beacon")])) });
    await act(async () => { await Promise.resolve(); });

    await act(async () => { await vi.advanceTimersByTimeAsync(PROJECT_MANAGER_REFRESH_INTERVAL_MS); });

    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.closest("main.cr2-project-home")).toBeNull();
    expect(alerts[0]?.firstElementChild?.textContent).toBe("Moe Projects did not send the project list.");
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
    // Deliberately re-pinned in pass 2: the step now leads with the owner's
    // words and keeps the launcher's name after the dash.
    expect(screen.getByText(
      "Go to the terminal window where you started Moe Projects - the foreground terminal that launched the project manager.",
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
    // The no-touch cordum-app.test.tsx pins only the regex below as a single
    // getByText match; this arm pins the whole sentence around it.
    expect(screen.getByText(
      "Go to the terminal window where you started Moe - the foreground terminal that launched this project.",
    )).toBeTruthy();
    expect(screen.getByText(/foreground terminal that launched this project/iu)).toBeTruthy();
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
