import { describe, expect, it, vi } from "vitest";

import {
  PROJECT_MANAGER_LOCAL_LAYER,
  PROJECT_MANAGER_SCHEMA_VERSION,
  connectProjectManager,
  validProjectOrigin,
} from "./project-manager-client.js";
import type {
  ProjectManagerConnection,
  ProjectManagerFetch,
  ProjectManagerPairingPending,
} from "./project-manager-client.js";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const REQUEST_ID = "ab".repeat(32);
const CSRF = "manager-csrf-secret";
const SESSION_CREDENTIAL = "manager-session-credential-0123456789";

function json(body: unknown, status = 200): Response {
  return { json: async () => body, ok: status >= 200 && status < 300, status } as Response;
}

function projectList(): Response {
  return json({
    projects: [{
      instanceId: ID, lifecycle: "RUNNING", projectId: "atlas",
      root: "C:\\work\\atlas", title: "Atlas",
    }],
    schemaVersion: PROJECT_MANAGER_SCHEMA_VERSION,
  });
}

function bootstrap(authenticated: boolean): Response {
  return json({ authenticated, csrfToken: CSRF, schemaVersion: PROJECT_MANAGER_SCHEMA_VERSION });
}

function pending(value: ProjectManagerConnection): ProjectManagerPairingPending {
  if (!("status" in value) || value.status !== "AWAITING_OPERATOR") {
    throw new Error("expected manager pairing");
  }
  return value;
}

describe("project manager request/approve/claim session", () => {
  it("keeps request identity closure-private and claims only after operator confirmation", async () => {
    const calls: { init: RequestInit | undefined; path: string }[] = [];
    const fetchImpl: ProjectManagerFetch = async (path, init) => {
      calls.push({ init, path });
      if (path === "/manager/bootstrap") return bootstrap(false);
      if (path === "/manager/session/pair/request") {
        return json({ confirmationLabel: "abcd-ef01-2345", ok: true, requestId: REQUEST_ID });
      }
      if (path === "/manager/session/pair/claim") {
        return json({
          code: "PROJECT_MANAGER_PAIRED", layer: "PROJECT_MANAGER_HTTP", ok: true,
          sessionCredential: SESSION_CREDENTIAL,
        });
      }
      if (path === "/manager/projects") return projectList();
      throw new Error(`unexpected ${path}`);
    };

    const pairing = pending(await connectProjectManager({ fetchImpl }));
    expect(Object.keys(pairing).sort()).toEqual(["claim", "confirmationLabel", "status"]);
    expect(pairing.confirmationLabel).toBe("abcd-ef01-2345");
    expect(JSON.stringify(pairing)).not.toContain(REQUEST_ID);
    expect(calls.map(({ path }) => path)).toEqual([
      "/manager/bootstrap", "/manager/session/pair/request",
    ]);

    const ready = await pairing.claim();
    expect("ok" in ready && ready.ok).toBe(true);
    if (!("ok" in ready) || !ready.ok) throw new Error("expected ready manager");
    expect(ready.projects[0]?.instanceId).toBe(ID);
    const claim = calls.find(({ path }) => path === "/manager/session/pair/claim");
    expect(JSON.parse(String(claim?.init?.body))).toEqual({ requestId: REQUEST_ID });
    expect(claim?.init?.credentials).toBe("omit");
    const listed = calls.find(({ path }) => path === "/manager/projects");
    expect(listed?.init?.headers).toMatchObject({
      "x-moe-manager-session-credential": SESSION_CREDENTIAL,
    });
    expect(listed?.init?.credentials).toBe("omit");
    expect(JSON.stringify(ready)).not.toContain(SESSION_CREDENTIAL);
  });

  it("remains pending when claim races foreground approval", async () => {
    const fetchImpl: ProjectManagerFetch = async (path) => path === "/manager/bootstrap"
      ? bootstrap(false)
      : path === "/manager/session/pair/request"
        ? json({ confirmationLabel: "abcd-ef01-2345", ok: true, requestId: REQUEST_ID })
        : json({ code: "PAIRING_APPROVAL_REQUIRED", layer: "CONTROL_ROOM_PAIRING_APPROVAL", ok: false }, 409);
    const pairing = pending(await connectProjectManager({ fetchImpl }));
    expect(await pairing.claim()).toBe(pairing);
  });

  it("never treats ambient browser cookies as an authenticated manager session", async () => {
    const fetchImpl = vi.fn<ProjectManagerFetch>(async (path, init) => {
      if (path === "/manager/bootstrap") return bootstrap(true);
      if (path === "/manager/session/pair/request") {
        expect(init?.credentials).toBe("omit");
        return json({ confirmationLabel: "abcd-ef01-2345", ok: true, requestId: REQUEST_ID });
      }
      throw new Error(path);
    });
    expect(pending(await connectProjectManager({ fetchImpl })).status).toBe("AWAITING_OPERATOR");
  });

  it("fails closed on malformed request metadata", async () => {
    const result = await connectProjectManager({
      fetchImpl: async (path) => path === "/manager/bootstrap" ? bootstrap(false)
        : json({ confirmationLabel: "UPPER-EF01-2345", ok: true, requestId: REQUEST_ID }),
    });
    expect(result).toEqual({
      code: "PROJECT_MANAGER_PAIRING_REFUSED", layer: PROJECT_MANAGER_LOCAL_LAYER, ok: false,
    });
  });
});

describe("authenticated project manager client", () => {
  it("opens only an exact plain project origin in a pre-reserved isolated tab", async () => {
    const fetchImpl: ProjectManagerFetch = async (path) => {
      if (path === "/manager/bootstrap") return bootstrap(false);
      if (path === "/manager/session/pair/request") {
        return json({ confirmationLabel: "abcd-ef01-2345", ok: true, requestId: REQUEST_ID });
      }
      if (path === "/manager/session/pair/claim") {
        return json({ code: "PROJECT_MANAGER_PAIRED", layer: "PROJECT_MANAGER_HTTP", ok: true,
          sessionCredential: SESSION_CREDENTIAL });
      }
      if (path === "/manager/projects") return projectList();
      if (path.endsWith("/open")) {
        return json({ code: "PROJECT_RUNTIME_OPENED", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: true,
          origin: "http://127.0.0.1:43123" });
      }
      throw new Error(path);
    };
    const ready = await pending(await connectProjectManager({ fetchImpl })).claim();
    if (!("ok" in ready) || !ready.ok) throw new Error("expected manager");
    const opened = { close: vi.fn(), location: { href: "" }, opener: {} as unknown };
    expect(await ready.client.openProject(ID, () => opened)).toMatchObject({ ok: true });
    expect(opened.location.href).toBe("http://127.0.0.1:43123");
    expect(opened.opener).toBeNull();
  });

  it.each([
    "http://127.0.0.1:43123/#pair=secret",
    "http://127.0.0.1:43123/?project=one",
    "https://127.0.0.1:43123",
    "http://localhost:43123",
  ])("rejects non-plain project address %s", (value) => {
    expect(validProjectOrigin(value)).toBe(false);
  });

  it("validates IDs before dispatch and closes a tab on a hostile open response", async () => {
    const calls: string[] = [];
    const fetchImpl: ProjectManagerFetch = async (path) => {
      calls.push(path);
      if (path === "/manager/bootstrap") return bootstrap(false);
      if (path === "/manager/session/pair/request") {
        return json({ confirmationLabel: "abcd-ef01-2345", ok: true, requestId: REQUEST_ID });
      }
      if (path === "/manager/session/pair/claim") {
        return json({ code: "PROJECT_MANAGER_PAIRED", layer: "PROJECT_MANAGER_HTTP", ok: true,
          sessionCredential: SESSION_CREDENTIAL });
      }
      if (path === "/manager/projects") return projectList();
      return json({ code: "PROJECT_RUNTIME_OPENED", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: true,
        origin: "http://evil.example" });
    };
    const ready = await pending(await connectProjectManager({ fetchImpl })).claim();
    if (!("ok" in ready) || !ready.ok) throw new Error("expected manager");
    expect((await ready.client.startProject("../foreign")).ok).toBe(false);
    const opened = { close: vi.fn(), location: { href: "" }, opener: null };
    expect((await ready.client.openProject(ID, () => opened)).ok).toBe(false);
    expect(opened.close).toHaveBeenCalledOnce();
    expect(calls).not.toContain("/manager/projects/../foreign/start");
  });
});
