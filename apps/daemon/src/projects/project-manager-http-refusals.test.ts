// task-e868ea33 — the project-manager HTTP refusal vocabulary. Every arm here
// pins the stable code AND the refusing layer, so loosening any single guard
// changes exactly one arm rather than merely "the system still refuses".
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { PAIRING_APPROVAL_MAX_BODY_BYTES } from "../http/pairing-approval-handshake.js";
import {
  PROJECT_MANAGER_HTTP_LAYER,
  PROJECT_MANAGER_MAX_BODY_BYTES,
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
// The stolen-cookie channel, kept ONLY so an arm can present the real credential on the
// WRONG channel. Production reads no cookie at all.
const COOKIE = `moe_manager_session=${SESSION_SECRET}`;
const CREDENTIAL_HEADER = "x-moe-manager-session-credential";
const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(scratch.map(async (path) => { await rm(path, { force: true, recursive: true }); }));
});

async function assetRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "moe-manager-refusals-"));
  scratch.push(root);
  await writeFile(join(root, "index.html"), "<!doctype html><p>manager</p>", "utf8");
  return root;
}

const accepted = Object.freeze({ code: "PROJECT_MANAGER_ACCEPTED", layer: "PROJECT_MANAGER", ok: true });

function manager(overrides: Partial<ProjectManagerPort> = {}): ProjectManagerPort {
  return {
    create: vi.fn(async () => accepted),
    list: vi.fn(async () => ({ projects: [], schemaVersion: PROJECT_MANAGER_PROTOCOL_VERSION })),
    open: vi.fn(async () => ({ ...accepted, origin: "http://127.0.0.1:43123" })),
    register: vi.fn(async () => accepted),
    start: vi.fn(async () => accepted),
    stop: vi.fn(async () => accepted),
    ...overrides,
  };
}

async function options(port: ProjectManagerPort): Promise<StartProjectManagerHttpOptions> {
  return {
    assetRoot: await assetRoot(),
    csrfToken: CSRF,
    manager: port,
    mintSessionSecret: () => SESSION_SECRET,
    pairingRandomBytes: (size) => new Uint8Array(size).fill(size === 32 ? 0xab : 0xcd),
  };
}

interface Reply {
  readonly body: Record<string, unknown> | null;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly raw: string;
  readonly status: number;
}

// `undefined` keeps the valid default; `null` omits the header entirely. Every
// case below flips exactly ONE field, so no case can trip a neighbour's guard.
interface CallInput {
  readonly body?: string;
  readonly contentType?: string | null;
  /** Omitted by default: nothing authenticates through a cookie any more. */
  readonly cookie?: string | null;
  readonly credential?: string | null;
  readonly csrf?: string | null;
  readonly method?: string;
  readonly origin?: string;
  readonly path: string;
  readonly protocolVersion?: string | null;
}

function headersFor(listener: ProjectManagerHttpListener, input: CallInput): Record<string, string> {
  const headers: Record<string, string> = {
    host: `127.0.0.2:${listener.port}`,
    origin: input.origin ?? listener.origin,
  };
  const contentType = input.contentType === undefined ? "application/json" : input.contentType;
  if (contentType !== null) headers["content-type"] = contentType;
  const cookie = input.cookie ?? null;
  if (cookie !== null) headers.cookie = cookie;
  const credential = input.credential === undefined ? SESSION_SECRET : input.credential;
  if (credential !== null) headers[CREDENTIAL_HEADER] = credential;
  const csrf = input.csrf === undefined ? CSRF : input.csrf;
  if (csrf !== null) headers["x-moe-manager-csrf"] = csrf;
  const protocol = input.protocolVersion === undefined
    ? PROJECT_MANAGER_PROTOCOL_VERSION : input.protocolVersion;
  if (protocol !== null) headers["x-moe-manager-protocol-version"] = protocol;
  return headers;
}

async function call(listener: ProjectManagerHttpListener, input: CallInput): Promise<Reply> {
  const body = input.body ?? "";
  const headers = headersFor(listener, input);
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      headers: { ...headers, "content-length": Buffer.byteLength(body) },
      host: "127.0.0.2",
      method: input.method ?? "POST",
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
  port: ProjectManagerPort,
  run: (listener: ProjectManagerHttpListener) => Promise<void>,
): Promise<void> {
  const listener = await startProjectManagerHttp(await options(port));
  if (!listener.ok) throw new Error(listener.code);
  try { await run(listener); } finally { await listener.close(); }
}

const CREATE = "/manager/projects/create";
const INTAKE = JSON.stringify({ root: "C:\\work\\atlas", title: "Atlas" });

interface RefusalCase {
  readonly code: string;
  readonly input: CallInput;
  readonly status: number;
  readonly title: string;
}

// Refusals that must land BEFORE the manager port is consulted.
const PRE_PORT_REFUSALS: readonly RefusalCase[] = Object.freeze([
  {
    code: "PROJECT_MANAGER_METHOD_INVALID", status: 405, title: "a non-POST mutation verb",
    input: { body: INTAKE, method: "PUT", path: CREATE },
  },
  {
    code: "PROJECT_MANAGER_CSRF_INVALID", status: 403, title: "a mismatched CSRF header",
    input: { body: INTAKE, csrf: "manager-csrf-wrong-9876543210", path: CREATE },
  },
  {
    code: "PROJECT_MANAGER_PROTOCOL_UNSUPPORTED", status: 400, title: "an unsupported protocol version",
    input: { body: INTAKE, path: CREATE, protocolVersion: "moe-project-manager/0" },
  },
  {
    code: "PROJECT_MANAGER_REQUEST_INVALID", status: 400, title: "a non-JSON content type",
    input: { body: INTAKE, contentType: "text/plain", path: CREATE },
  },
  {
    code: "PROJECT_MANAGER_REQUEST_INVALID", status: 400, title: "a malformed intake body",
    input: { body: JSON.stringify({ root: "relative/atlas", title: "Atlas" }), path: CREATE },
  },
  {
    code: "PROJECT_MANAGER_BODY_TOO_LARGE", status: 413, title: "a body past the byte bound",
    input: { body: "a".repeat(PROJECT_MANAGER_MAX_BODY_BYTES + 1), path: CREATE },
  },
]);

// The pairing routes carry their own copy of each guard, on their own lines, so
// a mutation there is invisible to the mutation-route arms above. Measured: a
// code swap at the pairing non-JSON guard left the suite green before these
// existed.
const PAIR_ROUTES = Object.freeze([
  "/manager/session/pair/request",
  "/manager/session/pair/claim",
] as const);

const PAIR_GUARDS = Object.freeze([
  { code: "PROJECT_MANAGER_METHOD_INVALID", patch: { method: "GET" }, status: 405,
    title: "a non-POST verb" },
  { code: "PROJECT_MANAGER_ORIGIN_INVALID", patch: { origin: "http://evil.example" }, status: 403,
    title: "a foreign Origin" },
  { code: "PROJECT_MANAGER_CSRF_INVALID", patch: { csrf: "manager-csrf-wrong-9876543210" },
    status: 403, title: "a mismatched CSRF header" },
  { code: "PROJECT_MANAGER_PROTOCOL_UNSUPPORTED", patch: { protocolVersion: "moe-project-manager/0" },
    status: 400, title: "an unsupported protocol version" },
  { code: "PROJECT_MANAGER_REQUEST_INVALID", patch: { contentType: "text/plain" }, status: 400,
    title: "a non-JSON content type" },
  { code: "PROJECT_MANAGER_BODY_TOO_LARGE", status: 413, title: "a body past the pairing bound",
    patch: { body: `{"x":"${"a".repeat(PAIRING_APPROVAL_MAX_BODY_BYTES)}"}` } },
] as const satisfies readonly {
  readonly code: string; readonly patch: Partial<CallInput>; readonly status: number;
  readonly title: string;
}[]);

const PAIR_REFUSALS: readonly RefusalCase[] = Object.freeze(
  PAIR_ROUTES.flatMap((path) => PAIR_GUARDS.map((guard) => Object.freeze({
    code: guard.code,
    input: { body: "{}", path, ...guard.patch },
    status: guard.status,
    title: `${path} with ${guard.title}`,
  }))),
);

async function sweep(
  listener: ProjectManagerHttpListener, scenarios: readonly RefusalCase[],
): Promise<void> {
  for (const scenario of scenarios) {
    const reply = await call(listener, scenario.input);
    expect(reply.status, scenario.title).toBe(scenario.status);
    expect(reply.body, scenario.title).toEqual({
      code: scenario.code, layer: PROJECT_MANAGER_HTTP_LAYER, ok: false,
    });
    expect(reply.headers["set-cookie"], scenario.title).toBeUndefined();
    expect(reply.raw, scenario.title).not.toContain(SESSION_SECRET);
  }
}

describe.runIf(process.platform !== "darwin")("project manager HTTP refusal vocabulary", () => {
  it("refuses each hostile mutation with its own code and layer, touching no port", async () => {
    // A sweep that generates zero cases would otherwise pass silently.
    expect(PRE_PORT_REFUSALS).toHaveLength(6);
    const port = manager();
    await withListener(port, async (listener) => {
      await sweep(listener, PRE_PORT_REFUSALS);
    });
    // No launch or session residue: nothing reached the runtime behind the route.
    for (const kind of ["create", "open", "register", "start", "stop"] as const) {
      expect(port[kind], kind).not.toHaveBeenCalled();
    }
  });

  it("refuses each pairing-route guard failure with its own code and layer", async () => {
    // Two routes times six guards; a sweep that generated nothing would pass.
    expect(PAIR_REFUSALS).toHaveLength(12);
    const port = manager();
    await withListener(port, async (listener) => {
      await sweep(listener, PAIR_REFUSALS);
    });
  });

  it("refuses a mismatched CSRF header even on a valid instance route", async () => {
    const port = manager();
    await withListener(port, async (listener) => {
      const reply = await call(listener, {
        csrf: "manager-csrf-wrong-9876543210", path: `/manager/projects/${INSTANCE_ID}/start`,
      });
      expect(reply.status).toBe(403);
      expect(reply.body).toEqual({
        code: "PROJECT_MANAGER_CSRF_INVALID", layer: PROJECT_MANAGER_HTTP_LAYER, ok: false,
      });
    });
    expect(port.start).not.toHaveBeenCalled();
  });

  // The closest "unavailable runtime" refusal this layer can emit: the manager
  // port itself throws, and the route must fail closed without leaking why.
  it("refuses with REQUEST_FAILED when the manager runtime throws", async () => {
    const port = manager({
      list: vi.fn(async () => { throw new Error("manager runtime unavailable"); }),
    });
    await withListener(port, async (listener) => {
      const reply = await call(listener, { method: "GET", path: "/manager/projects" });
      expect(reply.status).toBe(500);
      expect(reply.body).toEqual({
        code: "PROJECT_MANAGER_REQUEST_FAILED", layer: PROJECT_MANAGER_HTTP_LAYER, ok: false,
      });
      expect(reply.raw).not.toContain("unavailable");
      expect(reply.raw).not.toContain(SESSION_SECRET);
      expect(reply.headers["set-cookie"]).toBeUndefined();
    });
    expect(port.list).toHaveBeenCalledTimes(1);
  });
});

/**
 * task-8716a858967a4348b63dc87ab90082ce, DoD-2 - the stolen-credential replay.
 *
 * DIVERGENCE (epic rail 7A): this attacker presents a VALID Host, a VALID Origin, the
 * real CSRF token - read from an UNAUTHENTICATED GET /manager/bootstrap, because that
 * token is public by design - and the correct protocol header. It also holds the
 * genuinely minted credential. The ONLY thing wrong is the CHANNEL it arrives on: a
 * Cookie header. Every other fence in this route is therefore satisfied, so the
 * credential channel is the one and only mechanism that can refuse, and this arm cannot
 * pass because some neighbouring guard answered first.
 */
describe.runIf(process.platform !== "darwin")(
  "stolen manager credential replayed on the cookie channel (task-8716a858)", () => {
  const MUTATIONS = Object.freeze([
    "/manager/projects/create",
    "/manager/projects/register",
    `/manager/projects/${INSTANCE_ID}/open`,
    `/manager/projects/${INSTANCE_ID}/start`,
    `/manager/projects/${INSTANCE_ID}/stop`,
  ]);

  it("refuses every route at the credential channel and touches no port", async () => {
    expect(MUTATIONS).toHaveLength(5);
    const port = manager();
    await withListener(port, async (listener) => {
      // The CSRF token really is public: no credential on this read.
      const bootstrap = await call(listener, {
        contentType: null, credential: null, method: "GET", path: "/manager/bootstrap",
      });
      expect(bootstrap.status).toBe(200);
      expect(bootstrap.body).toMatchObject({ authenticated: false, csrfToken: CSRF });

      for (const path of MUTATIONS) {
        const reply = await call(listener, {
          body: JSON.stringify({ root: "C:\work\atlas", title: "Atlas" }),
          cookie: COOKIE, credential: null, path,
        });
        expect(reply.status, path).toBe(401);
        expect(reply.body, path).toEqual({
          code: "PROJECT_MANAGER_AUTHENTICATION_REQUIRED", layer: "PROJECT_MANAGER_HTTP",
          ok: false,
        });
        expect(reply.headers["set-cookie"], path).toBeUndefined();
      }
      const listed = await call(listener, {
        contentType: null, cookie: COOKIE, credential: null, method: "GET",
        path: "/manager/projects",
      });
      expect(listed.status).toBe(401);
      expect(listed.body).toEqual({
        code: "PROJECT_MANAGER_AUTHENTICATION_REQUIRED", layer: "PROJECT_MANAGER_HTTP", ok: false,
      });
      // The bootstrap read is not fooled either: a cookie is not a session.
      const stillAnonymous = await call(listener, {
        contentType: null, cookie: COOKIE, credential: null, method: "GET",
        path: "/manager/bootstrap",
      });
      expect(stillAnonymous.body).toMatchObject({ authenticated: false });
    });
    for (const kind of ["create", "open", "register", "start", "stop"] as const) {
      expect(port[kind], kind).not.toHaveBeenCalled();
    }
  });
  },
);
