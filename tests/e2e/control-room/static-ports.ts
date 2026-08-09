/**
 * Real effects behind the injected ports in `harness.ts`.
 *
 * The harness itself is pure: every effect is a port, so its reason codes are
 * provable in the Node lane without building a bundle or binding a socket. This
 * module is the other half — the actual `vite build`, the actual static server,
 * the actual HTTP probe — and is loaded ONLY by the browser lane.
 *
 * WHAT IS SERVED. `apps/control-room` renders COMMITTED FIXTURES through
 * ControlRoomScaffold. No daemon is attached and no transport exists in this
 * repository. Nothing here may be named or reported as a connected system.
 */
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ServedBundle, StaticHarnessPorts } from "./harness.js";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const BUNDLE_DIR = join(REPO_ROOT, "apps", "control-room", "dist");
const BUNDLE_ENTRY = join(BUNDLE_DIR, "index.html");

const POLL_INTERVAL_MS = 50;
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Explicit rather than inferred. A module served as `application/octet-stream`
 * is refused by the browser, the app never mounts, and the smoke journey then
 * fails as a missing element instead of as a wrong header.
 */
const CONTENT_TYPES = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
]);

/** `stat` THROWS on a missing path; it does not return a falsy handle. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function runViteBuild(): Promise<number> {
  return new Promise((done) => {
    // On Windows `pnpm` is a .cmd, and Node refuses to spawn one without a
    // shell. Passed as ONE fixed command string rather than as an argv array,
    // which is the form that avoids DEP0190; nothing here is interpolated.
    const child = spawn("pnpm --filter @moe/control-room build", {
      cwd: REPO_ROOT,
      shell: true,
      stdio: "ignore",
    });
    child.once("error", () => done(-1));
    child.once("close", (code) => done(code ?? -1));
  });
}

/**
 * Fails closed on BOTH a non-zero build and a build that produced no entry —
 * the second also catches `REPO_ROOT` having been resolved by hop count against
 * a directory that has since moved, which would otherwise serve nothing while
 * reporting success.
 */
export async function buildBundle(): Promise<boolean> {
  if ((await runViteBuild()) !== 0) return false;
  return await isFile(BUNDLE_ENTRY);
}

/** Returns null when the request escapes the bundle directory. */
function resolveRequested(rawUrl: string): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, "http://127.0.0.1").pathname);
  } catch {
    return null;
  }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/u, "");
  const target = resolve(BUNDLE_DIR, relative);
  return target === BUNDLE_DIR || target.startsWith(BUNDLE_DIR + sep) ? target : null;
}

/**
 * Deliberately NO single-page-app fallback. Rewriting every miss to index.html
 * would serve HTML for a missing asset, and a bundle with a broken script tag
 * would then still render a blank page that answers 200.
 */
async function respond(rawUrl: string, response: ServerResponse): Promise<void> {
  const target = resolveRequested(rawUrl);
  if (target === null || !(await isFile(target))) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
  const contentType = CONTENT_TYPES.get(extname(target)) ?? "application/octet-stream";
  response.writeHead(200, { "content-type": contentType });
  createReadStream(target).pipe(response);
}

/**
 * `close` alone waits for keep-alive connections to drain, which a just-loaded
 * page still holds. On Windows a surviving child keeps file handles open and
 * resurfaces later as EBUSY rather than as the failure that happened.
 */
function stopServer(server: Server): Promise<void> {
  return new Promise((done, failed) => {
    server.close((error) => (error ? failed(error) : done()));
    server.closeAllConnections();
  });
}

/** Binds an EPHEMERAL port so parallel runs cannot collide. Null on bind failure. */
function startServer(): Promise<ServedBundle | null> {
  return new Promise((served) => {
    const server = createServer((request, response) => {
      void respond(request.url ?? "/", response);
    });
    server.once("error", () => served(null));
    server.listen(0, "127.0.0.1", () => {
      const address: AddressInfo | string | null = server.address();
      if (address === null || typeof address === "string") {
        void stopServer(server).catch(() => undefined);
        served(null);
        return;
      }
      served({
        baseUrl: `http://127.0.0.1:${String(address.port)}/`,
        stop: () => stopServer(server),
      });
    });
  });
}

/** One poll attempt. Never a fixed sleep; the harness owns the bounded budget. */
async function probe(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

export function createStaticControlRoomPorts(): StaticHarnessPorts {
  return Object.freeze({
    buildBundle,
    now: () => performance.now(),
    probe,
    startServer,
    waitTick: () =>
      new Promise<void>((tick) => {
        setTimeout(tick, POLL_INTERVAL_MS);
      }),
  });
}
