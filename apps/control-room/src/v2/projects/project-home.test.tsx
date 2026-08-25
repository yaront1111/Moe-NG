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

    expect(screen.getByRole("heading", { name: "Start your first project" })).toBeTruthy();
    expect(screen.getByText(/No project instances are registered/i)).toBeTruthy();
    expect(screen.queryByTestId("cr.projects.list")).toBeNull();
    expect(screen.getByRole("form", { name: "Create a new project" })).toBeTruthy();
    expect(screen.getByRole("form", { name: "Register an existing Windows folder" })).toBeTruthy();
  });

  it("submits trimmed create and register inputs through their async callbacks", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn().mockResolvedValue(ACCEPTED);
    const onRegisterProject = vi.fn().mockResolvedValue(ACCEPTED);
    render(<ProjectHome {...props({ onCreateProject, onRegisterProject })} />);

    const create = screen.getByRole("form", { name: "Create a new project" });
    const createButton = within(create).getByRole("button", { name: "Create project" });
    expect((createButton as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(create).getByLabelText("Project title"), "  Atlas  ");
    await user.type(within(create).getByLabelText("New Windows folder"), "  C:\\work\\atlas  ");
    await user.click(createButton);
    await waitFor(() => {
      expect(onCreateProject).toHaveBeenCalledWith({ root: "C:\\work\\atlas", title: "Atlas" });
    });

    const register = screen.getByRole("form", { name: "Register an existing Windows folder" });
    await user.type(within(register).getByLabelText("Project title"), "  Beacon  ");
    const root = within(register).getByLabelText("Existing Windows folder");
    await user.type(root, "  D:\\repos\\beacon  ");
    root.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(onRegisterProject).toHaveBeenCalledWith({ root: "D:\\repos\\beacon", title: "Beacon" });
    });
    expect(screen.getAllByText("PROJECT_OPERATION_ACCEPTED @ PROJECT_SUPERVISOR")).toHaveLength(2);
  });

  it("fails a rejected callback closed under a local stable code and layer", async () => {
    const user = userEvent.setup();
    render(<ProjectHome {...props({ onCreateProject: vi.fn().mockRejectedValue(new Error("secret detail")) })} />);

    const form = screen.getByRole("form", { name: "Create a new project" });
    await user.type(within(form).getByLabelText("Project title"), "Atlas");
    await user.type(within(form).getByLabelText("New Windows folder"), "C:\\work\\atlas");
    await user.click(within(form).getByRole("button", { name: "Create project" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      `${PROJECT_HOME_LOCAL_REFUSAL.code} @ ${PROJECT_HOME_LOCAL_REFUSAL.layer}`,
    );
    expect(alert.textContent).not.toContain("secret detail");
  });
});

describe("ProjectHome project ledger", () => {
  it("offers an explicit refresh and reports its exact result", async () => {
    const user = userEvent.setup();
    const onRefreshProjects = vi.fn().mockResolvedValue(ACCEPTED);
    render(<ProjectHome {...props({ onRefreshProjects })} />);

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(onRefreshProjects).toHaveBeenCalledTimes(1);
    expect((await screen.findByRole("status")).textContent).toBe(
      "PROJECT_OPERATION_ACCEPTED @ PROJECT_SUPERVISOR",
    );
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
      expect(within(row).getByTestId("cr.projects.lifecycle").textContent).toBe(lifecycle);
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
    expect(within(row).getByText(/status is unavailable/i)).toBeTruthy();
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
    expect(alert.textContent).toBe("PROJECT_STOP_REFUSED @ PROJECT_SUPERVISOR");
    expect(onStopProject).toHaveBeenCalledTimes(1);
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
