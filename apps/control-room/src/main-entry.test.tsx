import { act, cleanup, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Root } from "react-dom/client";

const calls = vi.hoisted(() => {
  const session = { read: vi.fn(), write: vi.fn(), clear: vi.fn() };
  return { session, sessionFactory: vi.fn((_origin: string, _storage: () => Storage | undefined) => session),
    manager: vi.fn(async (_input: unknown) => ({ ok: false, code: "PROJECT_MANAGER_BOOTSTRAP_UNAVAILABLE", layer: "CONTROL_ROOM_PROJECT_MANAGER" })),
    handshake: vi.fn(async () => ({ ok: false, code: "LIVE_BOOTSTRAP_UNAVAILABLE", detail: "offline" })) };
});
vi.mock("./live/live-handshake.js", () => ({ resolveLiveSetupFromHandshake: calls.handshake }));
vi.mock("./v2/cordum-app.js", () => ({ CordumApp: ({ search, liveSetup }: { search: string; liveSetup: unknown }) =>
  <div data-testid="product-entry" data-search={search} data-prepared={String(liveSetup !== undefined)} /> }));
vi.mock("./v2/projects/project-manager-app.js", () => ({ ProjectManagerApp: () => <div data-testid="manager-entry" /> }));
vi.mock("./v2/projects/project-manager-client.js", () => ({ connectProjectManager: calls.manager }));
vi.mock("./v2/projects/project-manager-session.js", () => ({ createProjectManagerSession: calls.sessionFactory }));

let mounted: Root | null = null;
let container: HTMLDivElement | null = null;
beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });
afterEach(async () => {
  if (mounted !== null) await act(async () => { mounted?.unmount(); });
  mounted = null; container?.remove(); container = null;
  history.replaceState({}, "", "/"); cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

async function mount(search: string, development: boolean) {
  vi.stubEnv("DEV", development);
  history.replaceState({}, "", search);
  container = document.createElement("div"); container.id = "root"; document.body.append(container);
  await act(async () => { mounted = (await import("./main.js")).MOUNTED_CONTROL_ROOM_ROOT; });
  return within(container);
}

describe("the single product entry", () => {
  it("constructs one tab session only for the manager route before StrictMode mounts", async () => {
    const fakeStorage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() } as unknown as Storage;
    const access = vi.spyOn(window, "sessionStorage", "get").mockReturnValue(fakeStorage);
    const page = await mount("/?projects=1", true);
    expect(page.getByTestId("manager-entry")).toBeTruthy();
    expect(calls.handshake).not.toHaveBeenCalled();
    expect(calls.sessionFactory).toHaveBeenCalledTimes(1);
    expect(calls.sessionFactory).toHaveBeenCalledWith(window.location.origin, expect.any(Function));
    expect(access).not.toHaveBeenCalled();
    expect(calls.sessionFactory.mock.calls[0]?.[1]()).toBe(fakeStorage);
    expect(calls.manager).toHaveBeenCalledTimes(1);
    expect(calls.manager).toHaveBeenCalledWith({ fetchImpl: expect.any(Function), session: calls.session });
  });

  it("opens the product interface and prepares its handshake for an old development link", async () => {
    const access = vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => { throw new Error("storage must not be accessed"); });
    const page = await mount("/?v1=1", true);
    expect(page.getByTestId("product-entry").getAttribute("data-prepared")).toBe("true");
    expect(page.getByTestId("product-entry").getAttribute("data-search")).toBe("");
    expect(calls.handshake).toHaveBeenCalledTimes(1);
    expect(calls.sessionFactory).not.toHaveBeenCalled();
    expect(calls.manager).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
    expect(page.queryByTestId("cr.shell.root")).toBeNull();
  });
  it("keeps development fixtures on the product interface without opening a session", async () => {
    const page = await mount("/?v1=1&fixtures=1&product=goal-a", true);
    expect(page.getByTestId("product-entry").getAttribute("data-search")).toBe("?fixtures=1&product=goal-a");
    expect(page.getByTestId("product-entry").getAttribute("data-prepared")).toBe("false");
    expect(calls.handshake).not.toHaveBeenCalled();
  });
  it("strips fixture and old-interface flags before production session preparation", async () => {
    const page = await mount("/?v1=1&fixtures=1&product=goal-a&artifact=source%3Aabc&inspect=readiness", false);
    expect(page.getByTestId("product-entry").getAttribute("data-search"))
      .toBe("?product=goal-a&artifact=source%3Aabc&inspect=readiness");
    expect(page.getByTestId("product-entry").getAttribute("data-prepared")).toBe("true");
    expect(calls.handshake).toHaveBeenCalledTimes(1);
  });
});
