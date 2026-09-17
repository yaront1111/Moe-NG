import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  RUNTIME_ERROR_REGISTRY_VERSION,
  RUNTIME_QUERY_ENVELOPE_VERSION,
} from "@moe/contracts";
import { act, cleanup, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// ./main.js is imported dynamically only: it mounts on evaluation and refuses when
// the document has no mount point, so a static import would run at collection time.

const FILESYSTEM_IMPORT_TIMEOUT_MS = 20_000;

/** What the retired development fixtures called themselves; it must never reach the DOM. */
const DEVELOPMENT_FIXTURE_KIND = "DEVELOPMENT_ONLY/NOT_CONFIRMATORY";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const readOwnSource = (fileName: string): string =>
  readFileSync(fileURLToPath(new URL(fileName, import.meta.url)), "utf8");

/**
 * The entry point mounts on evaluation and reads `location.search` while it does,
 * so each arm needs its own URL in place BEFORE the import and put back after.
 */
async function mountEntryPointAt(search: string): Promise<HTMLElement> {
  const original = globalThis.location.href;
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  globalThis.history.replaceState({}, "", search);
  try {
    vi.resetModules();
    await act(async () => void (await import("./main.js")));
  } finally {
    globalThis.history.replaceState({}, "", original);
  }
  return container;
}

describe("control-room scaffold mounts", () => {
  it("mounts through the production entry point, not just its exported helper", async () => {
    // Old links resolve into the replacement product interface; fixtures remain development-only.
    const container = await mountEntryPointAt("/?v1=1&fixtures=1");
    try {
      expect(within(container).getByTestId("cr2.shell.root")).toBeTruthy();
      expect(within(container).getByTestId("cr.goals.home")).toBeTruthy();
      expect(within(container).queryByTestId("cr.shell.root")).toBeNull();
      const main = await import("./main.js");
      expect(main.CONTROL_ROOM_ROOT_ELEMENT_ID).toBe("root");
    } finally {
      await act(async () => { (await import("./main.js")).MOUNTED_CONTROL_ROOM_ROOT.unmount(); });
      container.remove();
    }
  }, FILESYSTEM_IMPORT_TIMEOUT_MS);

  it("mounts the v2 Cordum shell by default at the bare URL", async () => {
    // The swap: no flag now selects the v2 rebuild, which acquires its credential
    // at runtime through the handshake rather than a baked secret.
    const container = await mountEntryPointAt("/");
    try {
      expect(within(container).getByTestId("cr2.shell.root")).toBeTruthy();
      // The legacy v1 shell is no longer the default entry.
      expect(within(container).queryByTestId("cr.shell.root")).toBeNull();
    } finally {
      container.remove();
    }
  }, FILESYSTEM_IMPORT_TIMEOUT_MS);

  it("creates and claims one pairing request under the production StrictMode mount", async () => {
    const wire = [
      RUNTIME_COMMAND_ENVELOPE_VERSION,
      RUNTIME_QUERY_ENVELOPE_VERSION,
      RUNTIME_ERROR_REGISTRY_VERSION,
    ].join("+");
    const requestId = "d".repeat(64);
    let resolveOpen!: (response: Response) => void;
    const openResponse = new Promise<Response>((resolve) => { resolveOpen = resolve; });
    let openBody: Readonly<Record<string, unknown>> | undefined;
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === "/bootstrap") {
        return Promise.resolve(new Response(JSON.stringify({
          commandAuthorityPlane: "V1",
          csrfToken: "csrf-strict",
          projectId: "project-strict",
          protocolVersion: wire,
        }), { headers: { "content-type": "application/json" }, status: 200 }));
      }
      if (input === "/session/pair/request") {
        return Promise.resolve(new Response(JSON.stringify({
          confirmationLabel: "dead-beef-1234",
          ok: true,
          requestId,
        }), {
          headers: { "content-type": "application/json", "x-moe-operator-channel": "true" },
          status: 200,
        }));
      }
      if (input === "/session/pair/claim") {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-moe-csrf")).toBe("csrf-strict");
        expect(headers.get("x-moe-protocol-version")).toBe(wire);
        expect(headers.get("x-moe-session-credential")).toBeNull();
        const claim = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
        expect(Object.keys(claim).toSorted()).toEqual(["publicKeySpkiHex", "requestId"]);
        expect(claim["requestId"]).toBe(requestId);
        expect(claim["publicKeySpkiHex"]).toMatch(/^[0-9a-f]{88}$/u);
        return Promise.resolve(new Response(JSON.stringify({
          capabilities: ["project.admin"],
          challenge: {
            keyEpochRef: "key-epoch-strict", profileRevisionId: "profile-strict",
            recoveryIncarnationRef: "recovery-strict",
          },
          expiresAt: "2026-08-26T00:00:00.000Z",
          ok: true,
          principalId: "principal-strict",
          projectId: "project-strict",
          protocolVersion: wire,
          sessionCredential: "credential-strict",
        }), { headers: { "content-type": "application/json" }, status: 200 }));
      }
      if (input === "/session/pair/open") {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-moe-csrf")).toBe("csrf-strict");
        expect(headers.get("x-moe-protocol-version")).toBe(wire);
        expect(headers.get("x-moe-session-credential")).toBeNull();
        openBody = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
        expect(Object.keys(openBody).toSorted()).toEqual([
          "clientKeyId", "commandId", "correlationId", "credentialId", "principalId", "proof",
          "publicKeySpkiHex", "requestDigest", "sessionId", "transportId", "transportIds",
        ]);
        const proof = openBody["proof"] as Readonly<Record<string, unknown>>;
        expect(Object.keys(proof).toSorted()).toEqual([
          "algorithm", "issuedAt", "nonce", "protocolVersion", "signatureHex",
        ]);
        return openResponse;
      }
      if (input === "/affordances/read") {
        return Promise.resolve(new Response(JSON.stringify({
          nextAllowedCommands: [],
          outcome: "SURFACE",
          steps: [],
        }), { headers: { "content-type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`unexpected fetch to ${input}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const replaceState = vi.spyOn(window.history, "replaceState");

    const container = await mountEntryPointAt("/#pair=STRICT-ONE-TIME-TOKEN");
    const main = await import("./main.js");
    let unmounted = false;
    try {
      expect(replaceState).toHaveBeenCalledWith(null, "", "/");
      expect(await within(container).findByText("dead-beef-1234")).toBeTruthy();
      expect(container.textContent).not.toContain(requestId);
      expect(container.textContent).not.toContain("STRICT-ONE-TIME-TOKEN");
      await userEvent.setup().click(within(container).getByRole("button", {
        name: "I entered this label",
      }));
      await waitFor(() => {
        expect(fetchMock.mock.calls.filter(([input]) => input === "/session/pair/request"))
          .toHaveLength(1);
        expect(fetchMock.mock.calls.filter(([input]) => input === "/session/pair/claim"))
          .toHaveLength(1);
        expect(fetchMock.mock.calls.filter(([input]) => input === "/session/pair/open"))
          .toHaveLength(1);
      });
      expect(within(container).getByText("dead-beef-1234")).toBeTruthy();
      expect(fetchMock.mock.calls.filter(([input]) => input === "/affordances/read"))
        .toHaveLength(0);
      expect(JSON.stringify(openBody)).not.toContain("privateKey");
      expect(JSON.stringify(openBody)).not.toContain("STRICT-ONE-TIME-TOKEN");
      resolveOpen(new Response(JSON.stringify({
        ok: true, protocolVersion: wire, sessionId: openBody?.["sessionId"],
      }), { headers: { "content-type": "application/json" }, status: 200 }));
      await waitFor(() => {
        expect(fetchMock.mock.calls.filter(([input]) => input === "/affordances/read").length)
          .toBeGreaterThan(0);
        expect(within(container).queryByText("dead-beef-1234")).toBeNull();
      });
      await act(async () => { main.MOUNTED_CONTROL_ROOM_ROOT.unmount(); });
      unmounted = true;
    } finally {
      if (!unmounted) await act(async () => { main.MOUNTED_CONTROL_ROOM_ROOT.unmount(); });
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      container.remove();
    }
  }, FILESYSTEM_IMPORT_TIMEOUT_MS);

  it("refuses closed at the real entry point when runtime bootstrap is unavailable", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("bootstrap unavailable"); });
    vi.stubGlobal("fetch", fetchMock);
    const container = await mountEntryPointAt("/?v1=1");
    try {
      expect((await within(container).findByRole("region", { name: "Live connection refusal" })).textContent)
        .toContain("LIVE_BOOTSTRAP_UNAVAILABLE");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(within(container).queryByTestId("cr.shell.root")).toBeNull();
      expect(container.textContent).not.toContain(DEVELOPMENT_FIXTURE_KIND);
    } finally {
      await act(async () => { (await import("./main.js")).MOUNTED_CONTROL_ROOM_ROOT.unmount(); });
      vi.unstubAllGlobals();
      container.remove();
    }
  }, FILESYSTEM_IMPORT_TIMEOUT_MS);

  it("refuses with a stable code when the document supplies no mount point", async () => {
    expect(document.getElementById("root")).toBeNull();
    vi.resetModules();
    await expect(import("./main.js")).rejects.toThrow("CONTROL_ROOM_ROOT_MISSING");
  });
});

describe("shell source tripwires", () => {
  const modules = ["./main.tsx"] as const;
  const schedulerPackage = `sched${"uler"}`;
  const schedulerInternal =
    new RegExp(`(?:@moe/${schedulerPackage}/|${schedulerPackage}[\\\\/]src[\\\\/])`, "u");
  const heldOutImport = /(?:from|import|require)\s*\(?\s*["'][^"']*foundation[\\/][^"']*["']/u;
  const nondeterminism = /Date\.now|Math\.random|new Date\(\)/u;

  it.each(modules)("keeps %s clear of forbidden literals", (fileName) => {
    const source = readOwnSource(fileName);
    expect(source).not.toBe("");
    expect(schedulerInternal.test(source)).toBe(false);
    expect(heldOutImport.test(source)).toBe(false);
    expect(nondeterminism.test(source)).toBe(false);
  });

  it("loads the whole shell module graph without any Node-only API", async () => {
    // A bundler stubs node:util out for the browser, so anything this app touches at
    // module load must survive `types` being absent. Masking the module catches that;
    // a build cannot, because a bundle that throws on load still exits `vite build` 0.
    vi.doMock("node:util", () => ({ default: {}, types: undefined }));
    vi.resetModules();
    try {
      const app = await import("./v2/cordum-app.js");
      expect(typeof app.CordumApp).toBe("function");
    } finally {
      vi.doUnmock("node:util");
      vi.resetModules();
    }
  });

  it("proves the tripwire patterns actually bite", () => {
    expect(schedulerInternal.test(`import x from "@moe/${schedulerPackage}/internal";`)).toBe(true);
    expect(schedulerInternal.test(`see packages/${schedulerPackage}/src/thing.ts`)).toBe(true);
    expect(heldOutImport.test('import { J1 } from "@moe/testkit/foundation/model.js";')).toBe(true);
    expect(nondeterminism.test("const t = Date.now();")).toBe(true);
  });
});
