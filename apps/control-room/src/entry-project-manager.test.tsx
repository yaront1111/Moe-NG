import { act, cleanup, within } from "@testing-library/react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PROJECT_MANAGER_HOSTNAME, isProjectManagerLocation } from "./entry-project-manager.js";

const MOUNT_IMPORT_TIMEOUT_MS = 20_000;
/** The jsdom origin every arm below starts from; an ordinary project location. */
const ORDINARY_HOSTNAME = "localhost";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("task-15ca5c44 isProjectManagerLocation", () => {
  it("selects the manager on its fixed host even when the build is production", () => {
    expect(isProjectManagerLocation(PROJECT_MANAGER_HOSTNAME, "", false)).toBe(true);
  });

  it("accepts ?projects=1 while development is true", () => {
    expect(isProjectManagerLocation(ORDINARY_HOSTNAME, "?projects=1", true)).toBe(true);
  });

  it("refuses ?projects=1 in a production build", () => {
    // The security property: no query string may move a production document onto
    // the manager surface. Only the fixed manager origin may.
    expect(isProjectManagerLocation(ORDINARY_HOSTNAME, "?projects=1", false)).toBe(false);
  });

  it("refuses an ordinary location", () => {
    expect(isProjectManagerLocation(ORDINARY_HOSTNAME, "", true)).toBe(false);
  });

  it("reads the query and never the fragment", () => {
    // A fragment is not part of `search`, so it cannot smuggle the switch in.
    expect(isProjectManagerLocation(ORDINARY_HOSTNAME, "#projects=1", true)).toBe(false);
  });
});

/** Records every request URL in call order so an arm can assert what was NOT asked. */
function recordFetch(): string[] {
  const requested: string[] = [];
  vi.stubGlobal("fetch", vi.fn((input: string) => {
    requested.push(input);
    // Never settles: each arm asserts the request that was issued, not its answer.
    return new Promise<Response>(() => undefined);
  }));
  return requested;
}

/**
 * Evaluates the real entry module, whose module-level mount lands in `#root`.
 * jsdom makes `location` and `location.hostname` unforgeable (both are
 * `configurable: false`), so the module-level mount can only ever observe the
 * ORDINARY origin — which is exactly the arm that must not mount the manager.
 */
async function mountProductionEntry(): Promise<HTMLElement> {
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  vi.resetModules();
  await act(async () => void (await import("./main.js")));
  return container;
}

describe("task-15ca5c44 Control Room entry composition", () => {
  it("mounts the existing app at an ordinary location and asks only for the v2 handshake",
    async () => {
      const requested = recordFetch();
      const container = await mountProductionEntry();
      const main = await import("./main.js");
      try {
        expect(window.location.hostname).toBe(ORDINARY_HOSTNAME);
        expect(within(container).getByTestId("cr2.shell.root")).toBeTruthy();
        expect(within(container).queryByTestId("cr.manager.root")).toBeNull();
        expect(container.textContent).not.toContain("Connecting to project manager");
        expect(requested).toEqual(["/bootstrap"]);
      } finally {
        await act(async () => { main.MOUNTED_CONTROL_ROOM_ROOT.unmount(); });
        container.remove();
      }
    }, MOUNT_IMPORT_TIMEOUT_MS);

  it("mounts the project manager on the manager host and asks for no v2 handshake",
    async () => {
      const requested = recordFetch();
      const entry = await mountProductionEntry();
      const main = await import("./main.js");
      // Scope the recorder to the manager mount; the line above is the ordinary one.
      requested.length = 0;
      const container = document.createElement("div");
      document.body.append(container);
      let root: Root | undefined;
      try {
        await act(async () => {
          root = main.mountControlRoom(container, main.BROWSER_CLOCK, PROJECT_MANAGER_HOSTNAME);
        });
        expect(within(container).getByTestId("cr.manager.root")).toBeTruthy();
        expect(within(container).getByRole("heading", { name: "Connecting to project manager" }))
          .toBeTruthy();
        expect(within(container).queryByTestId("cr2.shell.root")).toBeNull();
        // The manager bootstraps its own session; the v2 pairing handshake must
        // NOT be started, or the browser opens a pairing request nothing consumes.
        expect(requested).toEqual(["/manager/bootstrap"]);
      } finally {
        await act(async () => {
          root?.unmount();
          main.MOUNTED_CONTROL_ROOM_ROOT.unmount();
        });
        container.remove();
        entry.remove();
      }
    }, MOUNT_IMPORT_TIMEOUT_MS);

  it("keeps the manager host on the manager even when a query names another route",
    async () => {
      // The route order is load-bearing: the manager branch is decided BEFORE any
      // query branch, so no flag can steer the manager origin onto another surface.
      recordFetch();
      const entry = await mountProductionEntry();
      const main = await import("./main.js");
      const container = document.createElement("div");
      document.body.append(container);
      const original = globalThis.location.href;
      let root: Root | undefined;
      try {
        globalThis.history.replaceState({}, "", "/?v1=1&fixtures=1");
        await act(async () => {
          root = main.mountControlRoom(container, main.BROWSER_CLOCK, PROJECT_MANAGER_HOSTNAME);
        });
        expect(within(container).getByTestId("cr.manager.root")).toBeTruthy();
        expect(within(container).queryByTestId("cr.shell.root")).toBeNull();
        expect(within(container).queryByTestId("cr2.shell.root")).toBeNull();
      } finally {
        globalThis.history.replaceState({}, "", original);
        await act(async () => {
          root?.unmount();
          main.MOUNTED_CONTROL_ROOM_ROOT.unmount();
        });
        container.remove();
        entry.remove();
      }
    }, MOUNT_IMPORT_TIMEOUT_MS);
});
