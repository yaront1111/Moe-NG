import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { PAIRING_APPROVAL_LAYER } from "../http/pairing-approval-contract.js";
import {
  PROJECT_MANAGER_CREDENTIAL_HEADER,
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
  readonly body?: string; readonly cookie?: string; readonly credential?: string;
  readonly host?: string; readonly method?: string; readonly origin?: string;
  readonly path: string;
}): Promise<Reply> {
  const body = input.body ?? "";
  const headers: Record<string, string> = {
    host: input.host ?? `127.0.0.2:${listener.port}`,
  };
  if (body !== "" || input.method === "POST") headers["content-type"] = "application/json";
  // `cookie` remains available ONLY so an arm can present the credential on the wrong
  // channel; production no longer reads it.
  if (input.cookie !== undefined) headers.cookie = input.cookie;
  if (input.credential !== undefined) headers[PROJECT_MANAGER_CREDENTIAL_HEADER] = input.credential;
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

const mutation = (listener: ProjectManagerHttpListener, credential: string) => ({
  credential, method: "POST", origin: listener.origin,
});

describe.runIf(process.platform !== "darwin")("manager plain-origin request/approve/claim", () => {
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

  it("hands over the credential in the claim body only after matching operator approval", async () => {
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
      // The pairing window is the refusing layer here, not the HTTP layer.
      expect(early.body).toEqual({
        code: "PAIRING_APPROVAL_REQUIRED", layer: PAIRING_APPROVAL_LAYER, ok: false,
      });
      expect(early.headers["set-cookie"]).toBeUndefined();

      expect(listener.approvePairing("cdcd-cdcd-cdcd")).toEqual({ ok: true, state: "APPROVED" });
      const claimed = await call(listener, claimInput);
      expect(claimed.body).toEqual({
        code: "PROJECT_MANAGER_PAIRED", layer: PROJECT_MANAGER_HTTP_LAYER, ok: true,
        sessionCredential: SESSION_SECRET,
      });
      expect(claimed.headers["set-cookie"]).toBeUndefined();
      const replay = await call(listener, claimInput);
      expect(replay.status).toBe(410);
      expect(replay.body).toEqual({
        code: "PAIRING_REQUEST_ALREADY_CLAIMED", layer: PAIRING_APPROVAL_LAYER, ok: false,
      });
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
      expect(legacy.body).toEqual({
        code: "PROJECT_MANAGER_ROUTE_UNKNOWN", layer: PROJECT_MANAGER_HTTP_LAYER, ok: false,
      });
      expect(legacy.body).not.toHaveProperty("sessionCredential");
      const foreign = await call(listener, {
        body: "{}", host: `127.0.0.1:${listener.port}`, method: "POST",
        origin: listener.origin, path: "/manager/session/pair/request",
      });
      expect(foreign.status).toBe(403);
      expect(foreign.body).toEqual({
        code: "PROJECT_MANAGER_HOST_INVALID", layer: PROJECT_MANAGER_HTTP_LAYER, ok: false,
      });
    });
  });
});

describe.runIf(process.platform !== "darwin")("authenticated manager API", () => {
  const cookie = `moe_manager_session=${SESSION_SECRET}`;

  it("lists exact isolated projects only behind the port-bound credential header", async () => {
    await withListener(await options(), async (listener) => {
      const anonymous = await call(listener, { path: "/manager/projects" });
      expect(anonymous.status).toBe(401);
      expect(anonymous.body).toEqual({
        code: "PROJECT_MANAGER_AUTHENTICATION_REQUIRED", layer: PROJECT_MANAGER_HTTP_LAYER,
        ok: false,
      });
      // The same secret on the WRONG channel is still anonymous: production reads no cookie.
      const viaCookie = await call(listener, { cookie, path: "/manager/projects" });
      expect(viaCookie.status).toBe(401);
      expect(viaCookie.body).toEqual({
        code: "PROJECT_MANAGER_AUTHENTICATION_REQUIRED", layer: PROJECT_MANAGER_HTTP_LAYER,
        ok: false,
      });
      const listed = await call(listener, {
        credential: SESSION_SECRET, path: "/manager/projects",
      });
      expect(listed.status).toBe(200);
      expect(listed.body).toMatchObject({ schemaVersion: PROJECT_MANAGER_PROTOCOL_VERSION });
    });
  });

  it("opens a project with a validated plain origin and no fragment", async () => {
    const port = manager();
    await withListener(await options({ manager: port }), async (listener) => {
      const opened = await call(listener, {
        ...mutation(listener, SESSION_SECRET), path: `/manager/projects/${INSTANCE_ID}/open`,
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
        ...mutation(listener, SESSION_SECRET), path: `/manager/projects/${INSTANCE_ID}/open`,
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
          ...mutation(listener, SESSION_SECRET), path: `/manager/projects/${INSTANCE_ID}/${kind}`,
        });
        expect(result.body).toEqual(accepted);
        expect(port[kind]).toHaveBeenCalledWith(INSTANCE_ID);
      }
      const denied = await call(listener, {
        ...mutation(listener, SESSION_SECRET), origin: "http://evil.example",
        path: `/manager/projects/${INSTANCE_ID}/start`,
      });
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual({
        code: "PROJECT_MANAGER_ORIGIN_INVALID", layer: PROJECT_MANAGER_HTTP_LAYER, ok: false,
      });
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

/**
 * task-8716a858967a4348b63dc87ab90082ce, DoD-1 - the cross-port reproduction.
 *
 * RFC 6265 gives a cookie NO port scope. A browser stores it under HOST + PATH and
 * replays it to EVERY port on that host, so a same-user process that binds another
 * 127.0.0.2 port receives the manager credential. This jar is therefore deliberately
 * PORT-BLIND: a port-aware jar would be a fixed point that cannot go red against the
 * cookie transport, and would prove nothing. Nothing here asserts a cookie ATTRIBUTE -
 * SameSite/HttpOnly/Path/__Host- cannot establish a port boundary, so an assertion
 * about them is not evidence. The only assertion is what the other port RECEIVED.
 */
interface JarEntry {
  readonly host: string;
  readonly name: string;
  readonly path: string;
  readonly value: string;
}

function absorbSetCookie(
  jar: JarEntry[], host: string, headers: Reply["headers"],
): void {
  const raw = headers["set-cookie"];
  const lines = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  for (const line of lines) {
    const [pair = "", ...attributes] = line.split(";");
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    // Path is read for STORAGE, exactly as a browser stores it; it is never asserted.
    const path = attributes.map((attribute) => attribute.trim())
      .find((attribute) => attribute.toLowerCase().startsWith("path="))?.slice(5) ?? "/";
    jar.push({ host, name: pair.slice(0, at).trim(), path, value: pair.slice(at + 1).trim() });
  }
}

/** The browser's replay rule: same host, path under the stored path, ANY port. */
function cookieHeaderFor(jar: readonly JarEntry[], host: string, path: string): string | undefined {
  const matched = jar.filter((entry) => entry.host === host && path.startsWith(entry.path));
  return matched.length === 0
    ? undefined
    : matched.map((entry) => `${entry.name}=${entry.value}`).join("; ");
}

interface CapturedRequest { readonly body: string; readonly headers: string }

/** A second, ordinary listener on another 127.0.0.2 port in this same non-elevated process. */
async function withAttackerListener(
  run: (port: number, captured: readonly CapturedRequest[]) => Promise<void>,
): Promise<void> {
  const captured: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      captured.push({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: JSON.stringify(request.headers),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.2", () => { resolve(); }); });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try { await run(port, captured); } finally {
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  }
}

async function getThroughJar(port: number, path: string, cookie: string | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.2:${String(port)}` };
    if (cookie !== undefined) headers.cookie = cookie;
    const outgoing = httpRequest({
      headers, host: "127.0.0.2", method: "GET", path, port, setHost: false,
    }, (response) => {
      response.on("data", () => undefined);
      response.on("end", () => { resolve(); });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe.runIf(process.platform !== "darwin")(
  "manager credential channel is port-bound (task-8716a858)", () => {
  it("hands a second 127.0.0.2 port no byte of the manager credential", async () => {
    await withListener(await options(), async (listener) => {
      const jar: JarEntry[] = [];
      const host = "127.0.0.2";
      absorbSetCookie(jar, host, (await call(listener, { path: "/manager/bootstrap" })).headers);
      const created = await call(listener, {
        body: "{}", method: "POST", origin: listener.origin,
        path: "/manager/session/pair/request",
      });
      expect(created.status).toBe(200);
      absorbSetCookie(jar, host, created.headers);
      expect(listener.approvePairing("cdcd-cdcd-cdcd")).toEqual({ ok: true, state: "APPROVED" });
      const claimed = await call(listener, {
        body: JSON.stringify({ requestId: "ab".repeat(32) }), method: "POST",
        origin: listener.origin, path: "/manager/session/pair/claim",
      });
      expect(claimed.status).toBe(200);
      absorbSetCookie(jar, host, claimed.headers);

      await withAttackerListener(async (attackerPort, captured) => {
        expect(attackerPort).not.toBe(listener.port);
        await getThroughJar(
          attackerPort, "/manager/projects", cookieHeaderFor(jar, host, "/manager/projects"),
        );
        // The request must actually have arrived, or the arm would pass vacuously.
        expect(captured).toHaveLength(1);
        const received = `${captured[0]?.headers ?? ""}${captured[0]?.body ?? ""}`;
        expect(received).not.toContain(SESSION_SECRET);
      });
    });
  });
  },
);
