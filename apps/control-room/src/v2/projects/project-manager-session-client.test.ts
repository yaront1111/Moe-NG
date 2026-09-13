import { describe, expect, it, vi } from "vitest";

import { connectProjectManager, PROJECT_MANAGER_SCHEMA_VERSION } from "./project-manager-client.js";
import type { ProjectManagerConnection, ProjectManagerFetch } from "./project-manager-client.js";

const CREDENTIAL = "test-manager-session";
const HEADER = "x-moe-manager-session-credential";
const CREATED = { confirmationLabel: "abcd-ef01-2345", ok: true, requestId: "ab".repeat(32) };
const PAIRED = {
  code: "PROJECT_MANAGER_PAIRED", layer: "PROJECT_MANAGER_HTTP", ok: true,
  sessionCredential: CREDENTIAL,
};
const LIST = { projects: [], schemaVersion: PROJECT_MANAGER_SCHEMA_VERSION };
function json(value: unknown, status = 200): Response {
  return { json: async () => value, ok: status >= 200 && status < 300, status } as Response;
}
function bootstrap(authenticated: boolean): Response {
  return json({ authenticated, csrfToken: "fresh-csrf", schemaVersion: PROJECT_MANAGER_SCHEMA_VERSION });
}
function sessionStore(initial?: string) {
  let saved = initial;
  return {
    clear: vi.fn(() => { saved = undefined; }),
    read: vi.fn(() => saved),
    write: vi.fn((credential: string) => { saved = credential; }),
  };
}
function pending(value: ProjectManagerConnection) {
  if (!("status" in value)) throw new Error("expected pairing");
  return value;
}

describe("manager session restoration", () => {
  it("saves a successful claim and validates it on reload without a second pairing request", async () => {
    const session = sessionStore();
    const fetchImpl = vi.fn<ProjectManagerFetch>(async (path, init) => {
      const credential = new Headers(init?.headers).get(HEADER);
      if (path === "/manager/bootstrap") return bootstrap(credential === CREDENTIAL);
      if (path === "/manager/session/pair/request") return json(CREATED);
      if (path === "/manager/session/pair/claim") return json(PAIRED);
      if (path === "/manager/projects") return credential === CREDENTIAL ? json(LIST) : json({}, 403);
      throw new Error("unexpected request");
    });
    const pairing = pending(await connectProjectManager({ fetchImpl, session }));
    expect(session.write).not.toHaveBeenCalled();
    expect(await pairing.claim()).toMatchObject({ ok: true, projects: [] });
    expect(session.write).toHaveBeenCalledExactlyOnceWith(CREDENTIAL);
    const restored = await connectProjectManager({ fetchImpl, session });
    expect(restored).toMatchObject({ ok: true, projects: [] });
    expect(JSON.stringify(restored)).not.toContain(CREDENTIAL);
    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual([
      "/manager/bootstrap", "/manager/session/pair/request", "/manager/session/pair/claim",
      "/manager/projects", "/manager/bootstrap", "/manager/projects",
    ]);
    expect(new Headers(fetchImpl.mock.calls[4]?.[1]?.headers).get(HEADER)).toBe(CREDENTIAL);
  });

  it("clears a rejected credential and uses fresh bootstrap metadata to request new approval", async () => {
    const session = sessionStore(CREDENTIAL);
    const fetchImpl = vi.fn<ProjectManagerFetch>(async (path) =>
      path === "/manager/bootstrap" ? bootstrap(false) : json(CREATED));
    expect(await connectProjectManager({ fetchImpl, session })).toMatchObject({ status: "AWAITING_OPERATOR" });
    expect(session.clear).toHaveBeenCalledOnce();
    expect(session.read()).toBeUndefined();
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get(HEADER)).toBe(CREDENTIAL);
    const pairingHeaders = new Headers(fetchImpl.mock.calls[1]?.[1]?.headers);
    expect(pairingHeaders.get(HEADER)).toBeNull();
    expect(pairingHeaders.get("x-moe-manager-csrf")).toBe("fresh-csrf");
    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual([
      "/manager/bootstrap", "/manager/session/pair/request",
    ]);
  });

  it.each(["network", "malformed", "protocol"])("does not erase approval on a %s bootstrap failure", async (failure) => {
    const session = sessionStore(CREDENTIAL);
    const fetchImpl = vi.fn<ProjectManagerFetch>(async () => {
      if (failure === "network") throw new Error("offline");
      return json(failure === "malformed" ? {} : {
        authenticated: false, csrfToken: "fresh-csrf", schemaVersion: "unknown/2",
      });
    });
    expect(await connectProjectManager({ fetchImpl, session })).toMatchObject({ ok: false });
    expect(session.clear).not.toHaveBeenCalled();
    expect(session.write).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps a claimed session when the first project list is temporarily unavailable", async () => {
    const session = sessionStore();
    let listReads = 0;
    const fetchImpl: ProjectManagerFetch = async (path, init) => {
      if (path === "/manager/bootstrap") return bootstrap(new Headers(init?.headers).get(HEADER) === CREDENTIAL);
      if (path === "/manager/session/pair/request") return json(CREATED);
      if (path === "/manager/session/pair/claim") return json(PAIRED);
      return ++listReads === 1 ? json({}, 503) : json(LIST);
    };
    expect(await pending(await connectProjectManager({ fetchImpl, session })).claim()).toMatchObject({
      code: "PROJECT_MANAGER_PROJECTS_UNAVAILABLE", ok: false,
    });
    expect(session.read()).toBe(CREDENTIAL);
    expect(await connectProjectManager({ fetchImpl, session })).toMatchObject({ ok: true, projects: [] });
  });

  it.each([
    ["refused", { code: "PAIRING_REQUEST_EXPIRED", layer: "CONTROL_ROOM_PAIRING_APPROVAL", ok: false }, 410],
    ["extra fields", { ...PAIRED, extra: true }, 200],
    ["wrong layer", { ...PAIRED, layer: "OTHER_LAYER" }, 200],
    ["empty credential", { ...PAIRED, sessionCredential: "" }, 200],
    ["non-header credential", { ...PAIRED, sessionCredential: "invalid-\u{1f600}" }, 200],
    ["HTTP failure", PAIRED, 403],
  ])("does not save a %s claim", async (_name, value, status) => {
    const session = sessionStore();
    const fetchImpl: ProjectManagerFetch = async (path) => path === "/manager/bootstrap"
      ? bootstrap(false) : path === "/manager/session/pair/request" ? json(CREATED) : json(value, status as number);
    expect(await pending(await connectProjectManager({ fetchImpl, session })).claim()).toMatchObject({ ok: false });
    expect(session.write).not.toHaveBeenCalled();
  });
});
