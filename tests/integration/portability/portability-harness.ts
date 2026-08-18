/**
 * Process and resource lifecycle for the transport/host portability matrix, and
 * NOTHING semantic: no assertions, no case table, no expected codes.
 *
 * Every subject is reached through an INSTALLED executable under
 * `node_modules/.bin` or through a bare public specifier in a real child Node
 * process. Spawning `apps/daemon/src/mcp-main.ts` directly would prove the module
 * runs and say nothing about the bin the gate task shipped.
 *
 * WINDOWS IS FIRST-CLASS HERE. The `.CMD` shim is the one with Windows paths (the
 * sh shim carries a WSL-stamped NODE_PATH), the shim path is quoted because it is
 * handed to `cmd.exe`, and stdio frames are split on LF with a trailing CR
 * stripped — a splitter that assumes bare LF hangs on a frame that already
 * arrived, which reads as a flaky timeout rather than as a failure.
 *
 * Killing the shim is NOT killing the server: `shell: true` spawns `cmd.exe`,
 * which spawns node, and killing the parent leaves the node process holding the
 * port. Measured live on 2026-08-18: an orphan `mcp-http-main.ts` survived
 * `child.kill()` and kept its ephemeral port bound. `taskkill /T /F` is what
 * actually reaps the tree.
 */

import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const IS_WINDOWS = process.platform === "win32";

export interface JsonRpcMessage {
  readonly error?: { readonly code: number; readonly data?: unknown; readonly message: string };
  readonly id?: number;
  readonly result?: { readonly content?: readonly { readonly text: string }[] };
}

export interface StoreCounts {
  readonly decisions: number;
  readonly events: number;
}

export interface PortabilityWorkspace {
  readonly credential: string;
  readonly directory: string;
  readonly projectId: string;
  readonly storePath: string;
}

/**
 * The temp directory name carries a SPACE deliberately: the store path travels to
 * both executables through the environment and, on Windows, through a `cmd.exe`
 * shim. A path that only ever lacks spaces never exercises that.
 */
export function createWorkspace(projectId: string): PortabilityWorkspace {
  const directory = mkdtempSync(join(tmpdir(), "moe portability-"));
  return Object.freeze({
    credential: `portability-operator-${projectId}`,
    directory,
    projectId,
    storePath: join(directory, "store.db"),
  });
}

export function removeWorkspace(workspace: PortabilityWorkspace): void {
  rmSync(workspace.directory, { force: true, maxRetries: 5, recursive: true });
}

/**
 * Opened, read and CLOSED inside one call. A SQLite handle held across teardown
 * kills the vitest worker with an error that looks unrelated to the test.
 */
export function readStoreCounts(storePath: string): StoreCounts {
  const database = new DatabaseSync(storePath, { readOnly: true });
  const count = (table: string): number =>
    Number((database.prepare(`select count(*) c from ${table}`).get() as { c: number }).c);
  try {
    return Object.freeze({ decisions: count("command_decisions"), events: count("domain_events") });
  } finally {
    database.close();
  }
}

function binaryPath(name: string): string {
  return join(process.cwd(), "node_modules", ".bin", IS_WINDOWS ? `${name}.CMD` : name);
}

export function environmentFor(
  workspace: PortabilityWorkspace,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined),
  );
  return {
    ...base,
    MOE_DAEMON_CREDENTIAL: workspace.credential,
    MOE_PROJECT_ID: workspace.projectId,
    MOE_STORE_PATH: workspace.storePath,
    ...extra,
  };
}

export interface SpawnedBin {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stderr: () => string;
}

/** The INSTALLED shim, quoted because `cmd.exe` splits an unquoted path on spaces. */
export function spawnInstalledBin(
  name: string,
  environment: Readonly<Record<string, string>>,
): SpawnedBin {
  const executable = binaryPath(name);
  const child = spawn(IS_WINDOWS ? `"${executable}"` : executable, [], {
    env: { ...environment },
    shell: IS_WINDOWS,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return { child, stderr: (): string => stderr };
}

export async function killTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (IS_WINDOWS) execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** True when nothing answers on the loopback port, i.e. the listener really went. */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
    setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 2_000);
  });
}

export interface StdioClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly initialize: () => Promise<void>;
  readonly rpc: (method: string, params: unknown) => Promise<JsonRpcMessage>;
  readonly stderr: () => string;
  /** Writes bytes verbatim. Used for frames that are not valid JSON-RPC at all. */
  readonly writeRaw: (text: string) => void;
}

const RPC_TIMEOUT_MS = 20_000;

export function stdioClient(name: string, environment: Record<string, string>): StdioClient {
  const spawned = spawnInstalledBin(name, environment);
  const pending = new Map<number, (message: JsonRpcMessage) => void>();
  let buffer = "";
  let nextId = 0;
  spawned.child.stdout.setEncoding("utf8");
  spawned.child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (let cut = buffer.indexOf("\n"); cut !== -1; cut = buffer.indexOf("\n")) {
      // CRLF tolerance: the trailing CR is stripped rather than assumed absent.
      const line = buffer.slice(0, cut).replace(/\r$/u, "");
      buffer = buffer.slice(cut + 1);
      if (line.trim() === "") continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      const resolve = message.id === undefined ? undefined : pending.get(message.id);
      if (resolve !== undefined && message.id !== undefined) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });

  const rpc = (method: string, params: unknown): Promise<JsonRpcMessage> => {
    nextId += 1;
    const id = nextId;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`stdio rpc timed out: ${method}`));
      }, RPC_TIMEOUT_MS);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      spawned.child.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`);
    });
  };

  return {
    child: spawned.child,
    initialize: async (): Promise<void> => {
      await rpc("initialize", {
        capabilities: {},
        clientInfo: { name: "portability-matrix", version: "0" },
        protocolVersion: "2025-06-18",
      });
      spawned.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
    },
    rpc,
    stderr: spawned.stderr,
    writeRaw: (text: string): void => {
      spawned.child.stdin.write(`${text}\n`);
    },
  };
}

export interface HttpResponse {
  readonly body: string;
  readonly status: number;
}

export interface HttpClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly initialize: () => Promise<void>;
  readonly origin: string;
  readonly port: number;
  readonly post: (body: string, headers?: Readonly<Record<string, string>>) => Promise<HttpResponse>;
  readonly request: (
    method: string,
    headers: Readonly<Record<string, string>>,
    body: string | null,
    query?: string,
  ) => Promise<HttpResponse>;
  readonly rpc: (method: string, params: unknown) => Promise<JsonRpcMessage>;
  readonly sessionId: () => string | null;
}

/** Reads the bound origin from the child's own first stdout line; never guesses a port. */
export async function httpClient(
  environment: Record<string, string>,
  credential: string,
): Promise<HttpClient> {
  const spawned = spawnInstalledBin("moe-mcp-http", environment);
  spawned.child.stdout.setEncoding("utf8");
  let stdout = "";
  const origin = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no origin from moe-mcp-http: ${spawned.stderr()}`)),
      30_000,
    );
    spawned.child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const cut = stdout.indexOf("\n");
      if (cut === -1) return;
      clearTimeout(timer);
      resolve(stdout.slice(0, cut).replace(/\r$/u, ""));
    });
  });

  let sessionId: string | null = null;
  let nextId = 0;

  const request = async (
    method: string,
    headers: Readonly<Record<string, string>>,
    body: string | null,
    query = "",
  ): Promise<HttpResponse> => {
    const response = await fetch(`${origin}/mcp${query}`, {
      ...(body === null ? {} : { body }),
      headers: { ...headers },
      method,
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const bound = response.headers.get("mcp-session-id");
    if (bound !== null) sessionId = bound;
    return { body: await response.text(), status: response.status };
  };

  const post = (body: string, extra: Readonly<Record<string, string>> = {}): Promise<HttpResponse> =>
    request(
      "POST",
      {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
        ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
        ...extra,
      },
      body,
    );

  const rpc = async (method: string, params: unknown): Promise<JsonRpcMessage> => {
    nextId += 1;
    const answer = await post(JSON.stringify({ id: nextId, jsonrpc: "2.0", method, params }));
    return JSON.parse(answer.body) as JsonRpcMessage;
  };

  return {
    child: spawned.child,
    initialize: async (): Promise<void> => {
      await rpc("initialize", {
        capabilities: {},
        clientInfo: { name: "portability-matrix", version: "0" },
        protocolVersion: "2025-06-18",
      });
    },
    origin,
    port: Number(new URL(origin).port),
    post,
    request,
    rpc,
    sessionId: (): string | null => sessionId,
  };
}

/**
 * Runs a real child Node process with an explicit cwd and reports its JSON stdout.
 * The JetBrains half needs this: vitest rewrites a `./x.js` specifier back to
 * `x.ts` while Node does not, so only a child proves the shipped `.js` bridge and
 * the package `exports` map are what actually resolve.
 */
export function runNodeChild(cwd: string, source: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      err += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("node child timed out"));
    }, 60_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`node child exited ${String(code)}: ${err.slice(0, 800)}`));
    });
  });
}
