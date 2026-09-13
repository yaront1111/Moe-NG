import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROJECT_MANAGER_REFRESH_INTERVAL_MS, ProjectManagerApp } from "./project-manager-app.js";
import type { ProjectManagerClient, ProjectManagerConnection, ProjectManagerProject,
  ProjectManagerProjectListResult } from "./project-manager-client.js";

const PROJECT: ProjectManagerProject = { instanceId: "11111111-1111-4111-8111-111111111111",
  projectId: "atlas", title: "Atlas", root: "C:\\work\\atlas", lifecycle: "RUNNING" };
const UNAVAILABLE = { code: "PROJECT_MANAGER_PROJECTS_UNAVAILABLE",
  layer: "CONTROL_ROOM_PROJECT_MANAGER", ok: false } as const;
const ACCEPTED = { code: "PROJECT_RUNTIME_STOPPED", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: true } as const;

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function listed(lifecycle: ProjectManagerProject["lifecycle"]): ProjectManagerProjectListResult {
  return { ok: true, projects: [{ ...PROJECT, lifecycle }] };
}
function client(listProjects: ProjectManagerClient["listProjects"]): ProjectManagerClient {
  return { listProjects, createProject: vi.fn().mockResolvedValue(ACCEPTED),
    registerProject: vi.fn().mockResolvedValue(ACCEPTED), startProject: vi.fn().mockResolvedValue(ACCEPTED),
    stopProject: vi.fn().mockResolvedValue(ACCEPTED), openProject: vi.fn().mockResolvedValue(ACCEPTED) };
}
async function attach(manager: ProjectManagerClient) {
  const prepared = Promise.resolve({ ok: true, client: manager, projects: [PROJECT] } as const);
  const view = render(<ProjectManagerApp prepared={prepared} />);
  await act(async () => { await Promise.resolve(); });
  return view;
}
async function poll(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(PROJECT_MANAGER_REFRESH_INTERVAL_MS); });
}
async function click(name: string): Promise<void> {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name })); await Promise.resolve(); });
}
const lifecycle = (): string | null => screen.getByTestId("cr.projects.lifecycle").getAttribute("data-lifecycle");
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("manager refresh ordering", () => {
  it("keeps a newer stopped read when an older running poll finishes", async () => {
    vi.useFakeTimers();
    const older = deferred<ProjectManagerProjectListResult>();
    const list = vi.fn().mockReturnValueOnce(older.promise).mockResolvedValue(listed("STOPPED"));
    await attach(client(list));
    await poll();
    await click("Refresh");
    expect(list).toHaveBeenCalledTimes(2);
    expect(lifecycle()).toBe("STOPPED");
    await act(async () => { older.resolve(listed("RUNNING")); });
    expect(lifecycle()).toBe("STOPPED");
    expect((screen.getByRole("button", { name: "Open Atlas" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Project list updated.")).toBeTruthy();
  });

  it.each(["refusal", "exception"] as const)("ignores an older poll %s after a successful manual read", async (ending) => {
    vi.useFakeTimers();
    const older = deferred<ProjectManagerProjectListResult>();
    const list = vi.fn().mockReturnValueOnce(older.promise).mockResolvedValue(listed("STOPPED"));
    await attach(client(list));
    await poll();
    await click("Refresh");
    await act(async () => { if (ending === "refusal") older.resolve(UNAVAILABLE); else older.reject(new Error("late failure")); });
    expect(lifecycle()).toBe("STOPPED");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Project list updated.")).toBeTruthy();
  });

  it("does not publish an older manual refusal after a newer poll succeeds", async () => {
    vi.useFakeTimers();
    const older = deferred<ProjectManagerProjectListResult>();
    const list = vi.fn().mockReturnValueOnce(older.promise).mockResolvedValue(listed("STOPPED"));
    await attach(client(list));
    await click("Refresh");
    await poll();
    expect(lifecycle()).toBe("STOPPED");
    await act(async () => { older.resolve(UNAVAILABLE); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Project list updated.")).toBeNull();
    expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not report an older manual success after the current poll fails", async () => {
    vi.useFakeTimers();
    const older = deferred<ProjectManagerProjectListResult>();
    const list = vi.fn().mockReturnValueOnce(older.promise).mockResolvedValue(UNAVAILABLE);
    await attach(client(list));
    await click("Refresh");
    await poll();
    const currentRefusal = screen.getByRole("alert");
    await act(async () => { older.resolve(listed("STOPPED")); });
    expect(screen.getAllByRole("alert")).toEqual([currentRefusal]);
    expect(screen.queryByText("Project list updated.")).toBeNull();
    expect(lifecycle()).toBe("RUNNING");
  });

  it("ignores an outdated mutation refresh while retaining the actual operation result", async () => {
    vi.useFakeTimers();
    const older = deferred<ProjectManagerProjectListResult>();
    const list = vi.fn().mockReturnValueOnce(older.promise).mockResolvedValue(listed("STOPPED"));
    const manager = client(list);
    await attach(manager);
    await click("Stop Atlas");
    await poll();
    await act(async () => { older.resolve(UNAVAILABLE); });
    expect(lifecycle()).toBe("STOPPED");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("That project has stopped.")).toBeTruthy();
    expect(manager.stopProject).toHaveBeenCalledTimes(1);
  });

  it("cannot replace a new manager connection with an old poll", async () => {
    vi.useFakeTimers();
    const older = deferred<ProjectManagerProjectListResult>();
    const view = await attach(client(vi.fn().mockReturnValue(older.promise)));
    await poll();
    const replacement = client(vi.fn().mockResolvedValue(listed("STOPPED")));
    view.rerender(<ProjectManagerApp prepared={Promise.resolve({ ok: true, client: replacement,
      projects: [{ ...PROJECT, title: "New project", lifecycle: "STOPPED" }] })} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { older.resolve(listed("RUNNING")); });
    expect(screen.getByRole("heading", { name: "New project" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Atlas" })).toBeNull();
  });

  it("cannot replace a new connection with an old pairing claim", async () => {
    const older = deferred<ProjectManagerConnection>();
    const view = render(<ProjectManagerApp prepared={Promise.resolve({ status: "AWAITING_OPERATOR",
      confirmationLabel: "abcd-ef01-2345", claim: () => older.promise })} />);
    await act(async () => { await Promise.resolve(); });
    await click("I entered this label");
    const replacement = client(vi.fn().mockResolvedValue(listed("STOPPED")));
    view.rerender(<ProjectManagerApp prepared={Promise.resolve({ ok: true, client: replacement,
      projects: [{ ...PROJECT, title: "New project", lifecycle: "STOPPED" }] })} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { older.resolve({ ok: true, client: client(vi.fn()), projects: [PROJECT] }); });
    expect(screen.getByRole("heading", { name: "New project" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Atlas" })).toBeNull();
  });
});
