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
const CREDENTIAL = "manager-session-credential-0123456789";
const CREDENTIAL_HEADER = "x-moe-manager-session-credential";

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
          sessionCredential: CREDENTIAL,
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
    // The credential is handed over ONCE in the claim body and then presented on the
    // header. Nothing rides on ambient cookie behaviour any more, so no request opts
    // into it: `credentials` is unset everywhere.
    expect(calls.every(({ init }) => init?.credentials === undefined)).toBe(true);
    const headersOf = (path: string): Record<string, string> =>
      (calls.find((entry) => entry.path === path)?.init?.headers ?? {}) as Record<string, string>;
    expect(headersOf("/manager/bootstrap")[CREDENTIAL_HEADER]).toBeUndefined();
    expect(headersOf("/manager/session/pair/request")[CREDENTIAL_HEADER]).toBeUndefined();
    expect(headersOf("/manager/session/pair/claim")[CREDENTIAL_HEADER]).toBeUndefined();
    expect(headersOf("/manager/projects")[CREDENTIAL_HEADER]).toBe(CREDENTIAL);
    // Closure-private: the credential never reaches the value the caller can render.
    expect(JSON.stringify(ready)).not.toContain(CREDENTIAL);
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

  it("reuses an authenticated HttpOnly cookie without creating a pairing request", async () => {
    const fetchImpl = vi.fn<ProjectManagerFetch>(async (path) => path === "/manager/bootstrap"
      ? bootstrap(true) : projectList());
    const result = await connectProjectManager({ fetchImpl });
    expect("ok" in result && result.ok).toBe(true);
    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual([
      "/manager/bootstrap", "/manager/projects",
    ]);
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
      if (path === "/manager/bootstrap") return bootstrap(true);
      if (path === "/manager/projects") return projectList();
      if (path.endsWith("/open")) {
        return json({ code: "PROJECT_RUNTIME_OPENED", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: true,
          origin: "http://127.0.0.1:43123" });
      }
      throw new Error(path);
    };
    const ready = await connectProjectManager({ fetchImpl });
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
      if (path === "/manager/bootstrap") return bootstrap(true);
      if (path === "/manager/projects") return projectList();
      return json({ code: "PROJECT_RUNTIME_OPENED", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: true,
        origin: "http://evil.example" });
    };
    const ready = await connectProjectManager({ fetchImpl });
    if (!("ok" in ready) || !ready.ok) throw new Error("expected manager");
    expect((await ready.client.startProject("../foreign")).ok).toBe(false);
    const opened = { close: vi.fn(), location: { href: "" }, opener: null };
    expect((await ready.client.openProject(ID, () => opened)).ok).toBe(false);
    expect(opened.close).toHaveBeenCalledOnce();
    expect(calls).not.toContain("/manager/projects/../foreign/start");
  });
});

describe("project manager journey carries no cookie (task-8716a858)", () => {
  it("sees zero set-cookie headers across bootstrap, pair, claim, list and one mutation", async () => {
    const seen: string[] = [];
    const withHeaders = (body: unknown, extra: Record<string, string> = {}): Response => {
      const response = {
        headers: new Headers({ "content-type": "application/json", ...extra }),
        json: async () => body, ok: true, status: 200,
      } as unknown as Response;
      return response;
    };
    const fetchImpl: ProjectManagerFetch = async (path) => {
      const answer = path === "/manager/bootstrap"
        ? withHeaders({
          authenticated: false, csrfToken: CSRF, schemaVersion: PROJECT_MANAGER_SCHEMA_VERSION,
        })
        : path === "/manager/session/pair/request"
          ? withHeaders({ confirmationLabel: "abcd-ef01-2345", ok: true, requestId: REQUEST_ID })
          : path === "/manager/session/pair/claim"
            ? withHeaders({
              code: "PROJECT_MANAGER_PAIRED", layer: "PROJECT_MANAGER_HTTP", ok: true,
              sessionCredential: CREDENTIAL,
            })
            : path === "/manager/projects"
              ? withHeaders({
                projects: [{
                  instanceId: ID, lifecycle: "RUNNING", projectId: "atlas",
                  root: "C:\work\atlas", title: "Atlas",
                }],
                schemaVersion: PROJECT_MANAGER_SCHEMA_VERSION,
              })
              : withHeaders({ code: "PROJECT_MANAGER_ACCEPTED", layer: "PROJECT_MANAGER", ok: true });
      for (const [name] of answer.headers) seen.push(name.toLowerCase());
      return answer;
    };

    const ready = await pending(await connectProjectManager({ fetchImpl })).claim();
    if (!("ok" in ready) || !ready.ok) throw new Error("expected ready manager");
    const mutated = await ready.client.createProject({ root: "C:\work\atlas", title: "Atlas" });
    expect(mutated.ok).toBe(true);
    // Every response of the whole journey was inspected, and none set a cookie.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((name) => name === "set-cookie")).toEqual([]);
  });
});
