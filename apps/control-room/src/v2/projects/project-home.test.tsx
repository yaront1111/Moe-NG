import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PROJECT_HOME_LOCAL_REFUSAL,
  PROJECT_LIFECYCLES,
  ProjectHome,
} from "./project-home.js";
import type {
  ProjectHomeProject,
  ProjectHomeResult,
  ProjectHomeProps,
} from "./project-home.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const ACCEPTED: ProjectHomeResult = {
  code: "PROJECT_OPERATION_ACCEPTED",
  layer: "PROJECT_SUPERVISOR",
  ok: true,
};
const SET_UP_FOR_ME = /Moe should set this folder up/u;
const SET_UP_ALREADY = /Moe already set this folder up/u;

function project(
  lifecycle: ProjectHomeProject["lifecycle"],
  instanceId = `instance-${lifecycle.toLowerCase()}`,
): ProjectHomeProject {
  return {
    instanceId,
    lifecycle,
    projectId: `project-${lifecycle.toLowerCase()}`,
    root: `C:\\work\\${lifecycle.toLowerCase()}`,
    title: `${lifecycle} project`,
  };
}

function props(overrides: Partial<ProjectHomeProps> = {}): ProjectHomeProps {
  return {
    onCreateProject: vi.fn().mockResolvedValue(ACCEPTED),
    onOpenProject: vi.fn().mockResolvedValue(ACCEPTED),
    onRefreshProjects: vi.fn().mockResolvedValue(ACCEPTED),
    onRegisterProject: vi.fn().mockResolvedValue(ACCEPTED),
    onStartProject: vi.fn().mockResolvedValue(ACCEPTED),
    onStopProject: vi.fn().mockResolvedValue(ACCEPTED),
    projects: [],
    ...overrides,
  };
}

describe("ProjectHome first-project intake", () => {
  it("renders an actionable empty state without inventing a project", () => {
    render(<ProjectHome {...props()} />);

    expect(screen.getByRole("heading", { name: "Add your first project" })).toBeTruthy();
    expect(screen.getByText(/Moe is not tracking any folder yet/i)).toBeTruthy();
    expect(screen.queryByTestId("cr.projects.list")).toBeNull();
    expect(screen.getByRole("form", { name: "Add a project" })).toBeTruthy();
  });

  it("submits trimmed create and register inputs through their async callbacks", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn().mockResolvedValue(ACCEPTED);
    const onRegisterProject = vi.fn().mockResolvedValue(ACCEPTED);
    render(<ProjectHome {...props({ onCreateProject, onRegisterProject })} />);

    const form = screen.getByRole("form", { name: "Add a project" });
    const addButton = within(form).getByRole("button", { name: "Add project" });
    expect((addButton as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(form).getByLabelText("Name for this project"), "  Atlas  ");
    await user.type(within(form).getByLabelText("Folder on this computer"), "  C:\\work\\atlas  ");
    await user.click(addButton);
    await waitFor(() => {
      expect(onCreateProject).toHaveBeenCalledWith({ root: "C:\\work\\atlas", title: "Atlas" });
    });
    expect(onRegisterProject).not.toHaveBeenCalled();

    await user.click(within(form).getByRole("radio", { name: SET_UP_ALREADY }));
    await user.type(within(form).getByLabelText("Name for this project"), "  Beacon  ");
    const root = within(form).getByLabelText("Folder on this computer");
    await user.type(root, "  D:\\repos\\beacon  ");
    root.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(onRegisterProject).toHaveBeenCalledWith({ root: "D:\\repos\\beacon", title: "Beacon" });
    });
    expect(onCreateProject).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("PROJECT_OPERATION_ACCEPTED @ PROJECT_SUPERVISOR")).toHaveLength(1);
  });

  it("fails a rejected callback closed under a local stable code and layer", async () => {
    const user = userEvent.setup();
    render(<ProjectHome {...props({ onCreateProject: vi.fn().mockRejectedValue(new Error("secret detail")) })} />);

    const form = screen.getByRole("form", { name: "Add a project" });
    await user.type(within(form).getByLabelText("Name for this project"), "Atlas");
    await user.type(within(form).getByLabelText("Folder on this computer"), "C:\\work\\atlas");
    await user.click(within(form).getByRole("button", { name: "Add project" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(
      `${PROJECT_HOME_LOCAL_REFUSAL.code} @ ${PROJECT_HOME_LOCAL_REFUSAL.layer}`,
    )).toBeTruthy();
    expect(alert.textContent).not.toContain("secret detail");
  });
});

/**
 * projects-09. Every outcome used to reach the owner as a bare `CODE @ LAYER`
 * line, success included. The code is the daemon's word and stays verbatim, but
 * it belongs behind Details; the headline is a sentence plus what to do next.
 */
describe("projects-09 ProjectHome speaks the outcome before the code", () => {
  it("leads an accepted operation with a sentence and folds CODE @ LAYER behind Details", async () => {
    const user = userEvent.setup();
    render(<ProjectHome {...props()} />);

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    const status = await screen.findByRole("status");
    expect(status.firstElementChild?.textContent).toBe("Moe accepted that.");
    const code = within(status).getByText("PROJECT_OPERATION_ACCEPTED @ PROJECT_SUPERVISOR");
    const details = code.closest("details");
    expect(details).not.toBeNull();
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(within(details as HTMLDetailsElement).getByText("Details")).toBeTruthy();
  });

  it("gives a refusal a plain reason and a next step without inventing an outcome", async () => {
    const user = userEvent.setup();
    const onStopProject = vi.fn().mockResolvedValue({
      code: "PROJECT_RUNTIME_NOT_RUNNING", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: false,
    });
    render(<ProjectHome {...props({ onStopProject, projects: [project("RUNNING")] })} />);

    await user.click(screen.getByRole("button", { name: "Stop RUNNING project" }));

    const alert = await screen.findByRole("alert");
    expect(alert.firstElementChild?.textContent).toBe("That project is not running.");
    expect(alert.textContent).toContain("Press Start first.");
    expect(within(alert).getByText("PROJECT_RUNTIME_NOT_RUNNING @ PROJECT_RUNTIME_SUPERVISOR")).toBeTruthy();
  });

  it("keeps an unmapped code honest instead of guessing what the daemon meant", async () => {
    const user = userEvent.setup();
    const onStartProject = vi.fn().mockResolvedValue({
      code: "PROJECT_RUNTIME_NEVER_SEEN_BEFORE", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: false,
    });
    render(<ProjectHome {...props({ onStartProject, projects: [project("STOPPED")] })} />);

    await user.click(screen.getByRole("button", { name: "Start STOPPED project" }));

    const alert = await screen.findByRole("alert");
    expect(alert.firstElementChild?.textContent).toBe("Moe refused that.");
    expect(alert.textContent).toContain("Open Details for the exact reason");
    expect(within(alert).getByText("PROJECT_RUNTIME_NEVER_SEEN_BEFORE @ PROJECT_RUNTIME_SUPERVISOR"))
      .toBeTruthy();
  });
});

describe("ProjectHome project ledger", () => {
  it("offers an explicit refresh and reports its exact result", async () => {
    const user = userEvent.setup();
    const onRefreshProjects = vi.fn().mockResolvedValue(ACCEPTED);
    render(<ProjectHome {...props({ onRefreshProjects })} />);

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(onRefreshProjects).toHaveBeenCalledTimes(1);
    expect(within(await screen.findByRole("status"))
      .getByText("PROJECT_OPERATION_ACCEPTED @ PROJECT_SUPERVISOR")).toBeTruthy();
  });

  it("renders every exact lifecycle and only the four public project facts", () => {
    expect(PROJECT_LIFECYCLES).toEqual([
      "STARTING", "RUNNING", "STOPPING", "STOPPED", "FAILED", "UNKNOWN",
    ]);
    const projects = PROJECT_LIFECYCLES.map((lifecycle) => project(lifecycle));
    const secret = {
      ...projects[0],
      credential: "DO-NOT-RENDER-CREDENTIAL",
      pairingToken: "DO-NOT-RENDER-TOKEN",
    } as ProjectHomeProject;
    render(<ProjectHome {...props({ projects: [secret, ...projects.slice(1)] })} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(PROJECT_LIFECYCLES.length);
    for (const lifecycle of PROJECT_LIFECYCLES) {
      const row = screen.getByTestId(`cr.projects.row.instance-${lifecycle.toLowerCase()}`);
      expect(row.getAttribute("data-instance-id")).toBe(`instance-${lifecycle.toLowerCase()}`);
      // projects-10: the chip reads as a word, the daemon's own token stays on the
      // attribute so nothing downstream has to parse prose.
      expect(within(row).getByTestId("cr.projects.lifecycle").getAttribute("data-lifecycle"))
        .toBe(lifecycle);
      expect(within(row).getByRole("heading", { name: `${lifecycle} project` })).toBeTruthy();
      expect(within(row).getByText(`project-${lifecycle.toLowerCase()}`)).toBeTruthy();
      expect(within(row).getByText(`C:\\work\\${lifecycle.toLowerCase()}`)).toBeTruthy();
    }
    expect(document.body.textContent).not.toContain("DO-NOT-RENDER");
  });

  it("uses opaque instanceId for actions even when project identities collide", async () => {
    const user = userEvent.setup();
    const onOpenProject = vi.fn().mockResolvedValue(ACCEPTED);
    const duplicate = {
      lifecycle: "RUNNING",
      projectId: "same-project",
      root: "C:\\same-root",
      title: "Atlas",
    } as const;
    render(<ProjectHome {...props({
      onOpenProject,
      projects: [
        { ...duplicate, instanceId: "opaque-one" },
        { ...duplicate, instanceId: "opaque-two", title: "Atlas mirror" },
      ],
    })} />);

    await user.click(screen.getByRole("button", { name: "Open Atlas mirror" }));
    expect(onOpenProject).toHaveBeenCalledTimes(1);
    expect(onOpenProject).toHaveBeenCalledWith("opaque-two");
  });

  it.each([
    ["STOPPED", false, true, true],
    ["FAILED", false, true, true],
    ["RUNNING", true, false, false],
    ["STARTING", true, true, true],
    ["STOPPING", true, true, true],
    ["UNKNOWN", true, true, true],
  ] as const)(
    "gates %s actions without guessing authority",
    (lifecycle, startDisabled, stopDisabled, openDisabled) => {
      render(<ProjectHome {...props({ projects: [project(lifecycle)] })} />);
      const row = screen.getByRole("listitem");
      expect((within(row).getByRole("button", { name: new RegExp(`Start ${lifecycle}`, "i") }) as HTMLButtonElement).disabled)
        .toBe(startDisabled);
      expect((within(row).getByRole("button", { name: new RegExp(`Stop ${lifecycle}`, "i") }) as HTMLButtonElement).disabled)
        .toBe(stopDisabled);
      expect((within(row).getByRole("button", { name: new RegExp(`Open ${lifecycle}`, "i") }) as HTMLButtonElement).disabled)
        .toBe(openDisabled);
    },
  );

  it("keeps UNKNOWN visibly fail-closed", () => {
    render(<ProjectHome {...props({ projects: [project("UNKNOWN")] })} />);

    const row = screen.getByRole("listitem");
    expect(row.getAttribute("data-actionable")).toBe("false");
    expect(row.getAttribute("aria-busy")).toBeNull();
    expect(within(row).getByText(/Moe cannot see this project right now/i)).toBeTruthy();
  });

  it("locks every action during an async operation and surfaces refusal code plus layer", async () => {
    const user = userEvent.setup();
    let settle: ((result: ProjectHomeResult) => void) | undefined;
    const onStopProject = vi.fn(() => new Promise<ProjectHomeResult>((resolve) => { settle = resolve; }));
    render(<ProjectHome {...props({ onStopProject, projects: [project("RUNNING", "opaque-running")] })} />);

    await user.click(screen.getByRole("button", { name: "Stop RUNNING project" }));
    expect(onStopProject).toHaveBeenCalledWith("opaque-running");
    expect(screen.getByRole("listitem").getAttribute("aria-busy")).toBe("true");
    for (const button of screen.getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Stopping RUNNING project" })).toBeTruthy();

    settle?.({ code: "PROJECT_STOP_REFUSED", layer: "PROJECT_SUPERVISOR", ok: false });
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("PROJECT_STOP_REFUSED @ PROJECT_SUPERVISOR")).toBeTruthy();
    expect(onStopProject).toHaveBeenCalledTimes(1);
  });
});

/**
 * projects-10. The page used to offer two equally weighted intake forms with no
 * cue which one a folder needs, under ledger words the owner never used. The
 * daemon's own preconditions decide: `create` runs planInit, which refuses a
 * folder that already has entries (moe-init.ts MOE_INIT_TARGET_NOT_EMPTY), while
 * `register` demands an existing moe.config.json (project-manager-files.ts
 * registerExisting). One form now names that difference and routes accordingly.
 */
describe("projects-10 ProjectHome names which folder each choice takes", () => {
  it("replaces the two equal forms with one guided choice", () => {
    render(<ProjectHome {...props()} />);

    const form = screen.getByRole("form", { name: "Add a project" });
    expect(screen.queryByRole("form", { name: "Create a new project" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Register an existing Windows folder" })).toBeNull();
    const setUp = within(form).getByRole("radio", { name: SET_UP_FOR_ME }) as HTMLInputElement;
    const already = within(form).getByRole("radio", { name: SET_UP_ALREADY }) as HTMLInputElement;
    expect(setUp.checked).toBe(true);
    expect(already.checked).toBe(false);
    expect(within(form).getByLabelText("Folder on this computer")).toBeTruthy();
    expect(within(form).getByLabelText("Name for this project")).toBeTruthy();
  });

  it("states the daemon's real precondition for each choice", async () => {
    const user = userEvent.setup();
    render(<ProjectHome {...props()} />);

    const form = screen.getByRole("form", { name: "Add a project" });
    expect(within(form).getByText(/will not set up a folder that already has files in it/iu)).toBeTruthy();
    expect(within(form).queryByText(/moe\.config\.json/u)).toBeNull();

    await user.click(within(form).getByRole("radio", { name: SET_UP_ALREADY }));

    expect(within(form).getByText(/moe\.config\.json/u)).toBeTruthy();
    expect(within(form).queryByText(/will not set up a folder that already has files in it/iu)).toBeNull();
  });

  it("drops the ledger words the owner never used", () => {
    render(<ProjectHome {...props({ projects: [project("RUNNING")] })} />);

    for (const jargon of [
      "QUIET ORCHESTRATION LEDGER", "INSTANCE LEDGER", "Project runtimes",
      "WINDOWS ROOT", "enter the ledger", "isolated runtime",
    ]) expect(document.body.textContent).not.toContain(jargon);
    expect(screen.getByText("Folder")).toBeTruthy();
  });

  it("says the lifecycle in a word and keeps raw ids behind Inspect", () => {
    render(<ProjectHome {...props({ projects: [project("RUNNING", "opaque-running")] })} />);

    const row = screen.getByRole("listitem");
    expect(within(row).getByTestId("cr.projects.lifecycle").textContent).toBe("Running");
    const inspect = within(row).getByText("opaque-running").closest("details");
    expect(inspect).not.toBeNull();
    expect((inspect as HTMLDetailsElement).open).toBe(false);
    expect(within(inspect as HTMLDetailsElement).getByText("Inspect")).toBeTruthy();
    expect(within(inspect as HTMLDetailsElement).getByText("project-running")).toBeTruthy();
    // The heading area carries the owner's own words, never an opaque id.
    expect(row.querySelector(".cr2-project-row-heading")?.textContent)
      .not.toContain("opaque-running");
  });
});

describe("ProjectHome has no browser-side authority", () => {
  it("contains no storage, transport, navigation, or secret-bearing implementation", () => {
    const source = readFileSync(resolve(process.cwd(), "src/v2/projects/project-home.tsx"), "utf8");
    for (const banned of [
      "localStorage", "sessionStorage", "fetch(", "window.open", "location.assign",
      "sessionCredential", "pairingToken",
    ]) expect(source).not.toContain(banned);
  });
});
