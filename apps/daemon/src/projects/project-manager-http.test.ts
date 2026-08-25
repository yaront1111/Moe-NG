import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  PROJECT_MANAGER_HTTP_LAYER,
  PROJECT_MANAGER_PROTOCOL_VERSION,
  startProjectManagerHttp,
} from "./project-manager-http.js";
import type {
  ProjectManagerHttpListener,
  ProjectManagerPort,
  StartProjectManagerHttpOptions,
} from "./project-manager-http.js";

const CSRF = "manager-csrf-0123456789";
const SESSION_SECRET = "manager-session-secret-0123456789";
const INSTANCE_ID = "123e4567-e89b-42d3-a456-426614174000";
const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(scratch.map(async (path) => { await rm(path, { force: true, recursive: true }); }));
});

async function assets(contents = "<!doctype html><p>manager</p>"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "moe-manager-http-"));
  scratch.push(root);
  await writeFile(join(root, "index.html"), contents, "utf8");
  return root;
}

const accepted = Object.freeze({ code: "PROJECT_MANAGER_ACCEPTED", layer: "PROJECT_MANAGER", ok: true });
function manager(overrides: Partial<ProjectManagerPort> = {}): ProjectManagerPort {
  return {
    create: vi.fn(async () => accepted),
    list: vi.fn(async () => ({
      projects: [{
        instanceId: INSTANCE_ID, lifecycle: "RUNNING", projectId: "atlas",
        root: "C:\\work\\atlas", title: "Atlas",
      }],
      schemaVersion: PROJECT_MANAGER_PROTOCOL_VERSION,
    })),
    open: vi.fn(async () => ({ ...accepted, origin: "http://127.0.0.1:43123" })),
    register: vi.fn(async () => accepted),
    start: vi.fn(async () => accepted),
    stop: vi.fn(async () => accepted),
    ...overrides,
  };
}

async function options(overrides: Partial<StartProjectManagerHttpOptions> = {}): Promise<StartProjectManagerHttpOptions> {
  return {
    assetRoot: await assets(),
    csrfToken: CSRF,
    manager: manager(),
    mintSessionSecret: () => SESSION_SECRET,
    pairingRandomBytes: (size) => new Uint8Array(size).fill(size === 32 ? 0xab : 0xcd),
    ...overrides,
  };
}

interface Reply {
  readonly body: Record<string, unknown> | null;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly raw: string;
  readonly status: number;
}

async function call(listener: ProjectManagerHttpListener, input: {
  readonly body?: string; readonly cookie?: string; readonly host?: string;
  readonly method?: string; readonly origin?: string; readonly path: string;
}): Promise<Reply> {
  const body = input.body ?? "";
  const headers: Record<string, string> = {
    host: input.host ?? `127.0.0.2:${listener.port}`,
  };
  if (body !== "" || input.method === "POST") headers["content-type"] = "application/json";
  if (input.cookie !== undefined) headers.cookie = input.cookie;
  if (input.origin !== undefined) headers.origin = input.origin;
  if (input.method === "POST") {
    headers["x-moe-manager-csrf"] = CSRF;
    headers["x-moe-manager-protocol-version"] = PROJECT_MANAGER_PROTOCOL_VERSION;
  }
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      headers: { ...headers, "content-length": Buffer.byteLength(body) },
      host: "127.0.0.2",
      method: input.method ?? "GET",
      path: input.path,
      port: listener.port,
      setHost: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({
          body: raw === "" || !response.headers["content-type"]?.startsWith("application/json")
            ? null : JSON.parse(raw) as Record<string, unknown>,
          headers: response.headers,
          raw,
          status: response.statusCode ?? 0,
        });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function withListener(
  configured: StartProjectManagerHttpOptions,
  run: (listener: ProjectManagerHttpListener) => Promise<void>,
): Promise<void> {
  const listener = await startProjectManagerHttp(configured);
  if (!listener.ok) throw new Error(listener.code);
  try { await run(listener); } finally { await listener.close(); }
}

const mutation = (listener: ProjectManagerHttpListener, cookie: string) => ({
  cookie, method: "POST", origin: listener.origin,
});

describe("manager plain-origin request/approve/claim", () => {
  it("binds 127.0.0.2 and exposes no authority in its URL or bootstrap", async () => {
    await withListener(await options(), async (listener) => {
      expect(listener.origin).toBe(`http://127.0.0.2:${listener.port}`);
      expect(listener.origin).not.toMatch(/[?#]/u);
      const bootstrap = await call(listener, { path: "/manager/bootstrap" });
      expect(bootstrap.body).toEqual({
        authenticated: false, csrfToken: CSRF, schemaVersion: PROJECT_MANAGER_PROTOCOL_VERSION,
      });
      expect(bootstrap.raw).not.toContain(SESSION_SECRET);
    });
  });

  it("sets a hardened cookie only after matching in-process operator approval", async () => {
    await withListener(await options(), async (listener) => {
      const created = await call(listener, {
        body: "{}", method: "POST", origin: listener.origin,
        path: "/manager/session/pair/request",
      });
      expect(created.status).toBe(200);
      expect(created.body).toEqual({
        confirmationLabel: "cdcd-cdcd-cdcd", ok: true, requestId: "ab".repeat(32),
      });
      const claimInput = {
        body: JSON.stringify({ requestId: "ab".repeat(32) }), method: "POST",
        origin: listener.origin, path: "/manager/session/pair/claim",
      };
      const early = await call(listener, claimInput);
      expect(early.status).toBe(409);
      expect(early.body).toMatchObject({ code: "PAIRING_APPROVAL_REQUIRED", ok: false });
      expect(early.headers["set-cookie"]).toBeUndefined();

      expect(listener.approvePairing("cdcd-cdcd-cdcd")).toEqual({ ok: true, state: "APPROVED" });
      const claimed = await call(listener, claimInput);
      expect(claimed.body).toEqual({
        code: "PROJECT_MANAGER_PAIRED", layer: PROJECT_MANAGER_HTTP_LAYER, ok: true,
      });
      expect(claimed.raw).not.toContain(SESSION_SECRET);
      expect(claimed.headers["set-cookie"]).toEqual([
        `moe_manager_session=${SESSION_SECRET}; HttpOnly; SameSite=Strict; Path=/manager`,
      ]);
      const replay = await call(listener, claimInput);
      expect(replay.status).toBe(410);
      expect(replay.headers["set-cookie"]).toBeUndefined();
    });
  });

  it("rejects the removed bearer route and full mutation guard failures", async () => {
    await withListener(await options(), async (listener) => {
      const legacy = await call(listener, {
        body: JSON.stringify({ pairingToken: "legacy-secret-bearer" }), method: "POST",
        origin: listener.origin, path: "/manager/session/pair",
      });
      expect(legacy.status).toBe(404);
      expect(legacy.body).not.toHaveProperty("sessionCredential");
      const foreign = await call(listener, {
        body: "{}", host: `127.0.0.1:${listener.port}`, method: "POST",
        origin: listener.origin, path: "/manager/session/pair/request",
      });
      expect(foreign.body).toMatchObject({ code: "PROJECT_MANAGER_HOST_INVALID", ok: false });
    });
  });
});

describe("authenticated manager API", () => {
  const cookie = `moe_manager_session=${SESSION_SECRET}`;

  it("lists exact isolated projects only behind the host-only cookie", async () => {
    await withListener(await options(), async (listener) => {
      expect((await call(listener, { path: "/manager/projects" })).status).toBe(401);
      const listed = await call(listener, { cookie, path: "/manager/projects" });
      expect(listed.status).toBe(200);
      expect(listed.body).toMatchObject({ schemaVersion: PROJECT_MANAGER_PROTOCOL_VERSION });
    });
  });

  it("opens a project with a validated plain origin and no fragment", async () => {
    const port = manager();
    await withListener(await options({ manager: port }), async (listener) => {
      const opened = await call(listener, {
        ...mutation(listener, cookie), path: `/manager/projects/${INSTANCE_ID}/open`,
      });
      expect(opened.body).toEqual({ ...accepted, origin: "http://127.0.0.1:43123" });
      expect(opened.raw).not.toMatch(/#pair|pairingToken|credential/u);
      expect(port.open).toHaveBeenCalledWith(INSTANCE_ID);
    });
  });

  it("rejects a hostile open origin and never forwards it", async () => {
    const port = manager({ open: vi.fn(async () => ({ ...accepted,
      origin: "http://evil.example/#pair=secret" })) });
    await withListener(await options({ manager: port }), async (listener) => {
      const opened = await call(listener, {
        ...mutation(listener, cookie), path: `/manager/projects/${INSTANCE_ID}/open`,
      });
      expect(opened.status).toBe(500);
      expect(opened.body).toEqual({
        code: "PROJECT_MANAGER_PORT_RESULT_INVALID", layer: PROJECT_MANAGER_HTTP_LAYER, ok: false,
      });
      expect(opened.raw).not.toContain("secret");
    });
  });

  it("routes start and stop by exact instance and enforces Origin", async () => {
    const port = manager();
    await withListener(await options({ manager: port }), async (listener) => {
      for (const kind of ["start", "stop"] as const) {
        const result = await call(listener, {
          ...mutation(listener, cookie), path: `/manager/projects/${INSTANCE_ID}/${kind}`,
        });
        expect(result.body).toEqual(accepted);
        expect(port[kind]).toHaveBeenCalledWith(INSTANCE_ID);
      }
      const denied = await call(listener, {
        ...mutation(listener, cookie), origin: "http://evil.example",
        path: `/manager/projects/${INSTANCE_ID}/start`,
      });
      expect(denied.body).toMatchObject({ code: "PROJECT_MANAGER_ORIGIN_INVALID", ok: false });
    });
  });
});

it("refuses a bundle containing the only runtime session secret before binding", async () => {
  const root = await assets(`secret=${SESSION_SECRET}`);
  const refused = await startProjectManagerHttp(await options({ assetRoot: root }));
  expect(refused).toEqual({
    code: "LISTENER_ASSET_ROOT_LEAKS_SECRET", layer: PROJECT_MANAGER_HTTP_LAYER, ok: false,
  });
});
