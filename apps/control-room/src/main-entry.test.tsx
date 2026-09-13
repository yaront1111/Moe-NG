import { act, cleanup, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Root } from "react-dom/client";

const calls = vi.hoisted(() => ({ handshake: vi.fn(async () => ({ ok: false, code: "LIVE_BOOTSTRAP_UNAVAILABLE", detail: "offline" })) }));
vi.mock("./live/live-handshake.js", () => ({ resolveLiveSetupFromHandshake: calls.handshake }));
vi.mock("./v2/cordum-app.js", () => ({ CordumApp: ({ search, liveSetup }: { search: string; liveSetup: unknown }) =>
  <div data-testid="product-entry" data-search={search} data-prepared={String(liveSetup !== undefined)} /> }));

let mounted: Root | null = null;
let container: HTMLDivElement | null = null;
beforeEach(() => { calls.handshake.mockClear(); vi.resetModules(); });
afterEach(async () => {
  if (mounted !== null) await act(async () => { mounted?.unmount(); });
  mounted = null; container?.remove(); container = null;
  history.replaceState({}, "", "/"); cleanup(); vi.unstubAllEnvs();
});

async function mount(search: string, development: boolean) {
  vi.stubEnv("DEV", development);
  history.replaceState({}, "", search);
  container = document.createElement("div"); container.id = "root"; document.body.append(container);
  await act(async () => { mounted = (await import("./main.js")).MOUNTED_CONTROL_ROOM_ROOT; });
  return within(container);
}

describe("the single product entry", () => {
  it("opens the product interface and prepares its handshake for an old development link", async () => {
    const page = await mount("/?v1=1", true);
    expect(page.getByTestId("product-entry").getAttribute("data-prepared")).toBe("true");
    expect(page.getByTestId("product-entry").getAttribute("data-search")).toBe("");
    expect(calls.handshake).toHaveBeenCalledTimes(1);
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
