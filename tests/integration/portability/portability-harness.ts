/**
 * Process and resource lifecycle for the transport/host portability matrix, and
 * NOTHING semantic: no assertions, no case table, no expected codes.
 *
 * Every subject is reached through an INSTALLED executable under
 * `node_modules/.bin`, or a bare public specifier in a real child Node process.
 *
 * THREE WINDOWS FACTS, each measured live rather than assumed:
 *  - the `.CMD` shim is the one carrying Windows paths (the sh shim carries a
 *    WSL-stamped NODE_PATH), and it is quoted because `cmd.exe` splits on spaces;
 *  - stdio frames are split on LF with a trailing CR stripped — a splitter that
 *    assumes bare LF hangs on a frame that already arrived, and reads as a flake;
 *  - `child.kill()` reaps `cmd.exe` and LEAVES the node process holding the port.
 *    Reproduced: an orphan `mcp-http-main.ts` survived kill with its ephemeral
 *    port still bound. `taskkill /T /F` is what actually reaps the tree.
 */

import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const IS_WINDOWS = process.platform === "win32";
const RPC_TIMEOUT_MS = 20_000;

/** Every child this harness spawns, so residue is a MEASURED number, not a hope. */
const spawnedChildren: ChildProcessWithoutNullStreams[] = [];

/** How many spawned children are still running. Zero is the only clean teardown. */
export function liveChildren(): number {
  return spawnedChildren.filter((c) => c.exitCode === null && c.signalCode === null).length;
}

/**
 * Splits a stdio buffer into whole JSON-RPC frames, tolerating CRLF.
 *
 * PLATFORM-NEUTRAL BY CONSTRUCTION, and it is the SAME function `stdioClient`
 * feeds, not a description of it. A splitter that assumes bare LF does not fail on
 * a CRLF frame - it HANGS waiting for one that already arrived, which surfaces as
 * a flaky timeout rather than as a framing bug.
 */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let rest = buffer;
  for (let cut = rest.indexOf("\n"); cut !== -1; cut = rest.indexOf("\n")) {
    const line = rest.slice(0, cut).replace(/\r$/u, "");
    rest = rest.slice(cut + 1);
    if (line.trim() !== "") frames.push(line);
  }
  return { frames, rest };
}

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

/** The name carries a SPACE deliberately: the store path travels to both
 *  executables through the environment and, on Windows, through a `cmd.exe` shim. */
export function createWorkspace(projectId: string): PortabilityWorkspace {
  const directory = mkdtempSync(join(tmpdir(), "moe portability-"));
  return Object.freeze({
    credential: `portability-operator-${projectId}`,
    directory,
    projectId,
    storePath: join(directory, "store.db"),
  });
}

/**
 * THROWS rather than swallowing, and that is the orphan detector: on Windows a
 * live child still holding the store file blocks the removal, so a teardown that
 * leaked a process fails here instead of leaving residue for the next run.
 *
 * Process death and FILE-HANDLE release are separate events on Windows, so this
 * waits for every spawned child to be gone and then lets `rmSync` retry across
 * the handle-release window. Without the wait the detector fires on the lag
 * rather than on a real leak - measured intermittently before the wait existed.
 */
export async function removeWorkspace(workspace: PortabilityWorkspace): Promise<void> {
  for (let attempt = 0; attempt < 40 && liveChildren() > 0; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  rmSync(workspace.directory, { maxRetries: 40, recursive: true, retryDelay: 250 });
}

/**
 * Opened, read and CLOSED inside one call: a SQLite handle held across teardown
 * kills the vitest worker with an error that looks unrelated to the test.
 *
 * NOT read-only, and that is a fix rather than laxity. A `taskkill`ed child can
 * leave a hot journal behind, and SQLite must WRITE to roll one back — a
 * read-only connection cannot, and fails with a bare `disk I/O error` that reads
 * like a broken test. Measured: 1 run in 4 failed exactly that way. The retry
 * covers the window where Windows has not yet released the dead child's handle.
 */
export async function readStoreCounts(storePath: string): Promise<StoreCounts> {
  let last: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(storePath);
      const open = database;
      const count = (table: string): number =>
        Number((open.prepare(`select count(*) c from ${table}`).get() as { c: number }).c);
      return Object.freeze({
        decisions: count("command_decisions"),
        events: count("domain_events"),
      });
    } catch (error) {
      last = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    } finally {
      database?.close();
    }
  }
  throw new Error(`store counts unreadable: ${String(last)}`);
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
  const executable = join(process.cwd(), "node_modules", ".bin", IS_WINDOWS ? `${name}.CMD` : name);
  const child = spawn(IS_WINDOWS ? `"${executable}"` : executable, [], {
    env: { ...environment },
    shell: IS_WINDOWS,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  spawnedChildren.push(child);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return { child, stderr: (): string => stderr };
}

const exited = (child: ChildProcessWithoutNullStreams, ms: number): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

/**
 * GRACEFUL FIRST, then the tree. Closing stdin lets the MCP stdio server shut down
 * and release its SQLite handle; only then is `taskkill /T /F` needed, and only
 * while the `cmd.exe` shim is still alive to name the tree. Killing the shim first
 * re-parents the node process beyond any PID we hold — measured: exactly one
 * `mcp-main.ts` survived four suite runs that way.
 */
export async function killTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid === undefined) return;
  if (child.exitCode === null && child.stdin.writable) child.stdin.end();
  if (await exited(child, 2_000)) return;
  try {
    if (IS_WINDOWS) {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await exited(child, 3_000);
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
  /** True when the child really exited within the bound. */
  readonly waitForExit: (ms: number) => Promise<boolean>;
  /** Writes bytes verbatim, with NO frame terminator: used to truncate a frame. */
  readonly writeRaw: (text: string) => void;
}

export function stdioClient(name: string, environment: Record<string, string>): StdioClient {
  const spawned = spawnInstalledBin(name, environment);
  const pending = new Map<number, (message: JsonRpcMessage) => void>();
  let buffer = "";
  let nextId = 0;
  spawned.child.stdout.setEncoding("utf8");
  spawned.child.stdout.on("data", (chunk: string) => {
    // THE live client feeds `splitFrames`; the CRLF property is therefore asserted
    // against the function that actually frames these bytes, not a copy of it.
    const split = splitFrames(buffer + chunk);
    buffer = split.rest;
    for (const frame of split.frames) {
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(frame) as JsonRpcMessage;
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

  /**
   * A child that DIES rejects its pending calls immediately, naming its exit code
   * and stderr. Waiting out the timeout instead turns a missing shim into a 20s
   * hang that reads as flakiness rather than as the resolution failure it is —
   * measured while drilling the installed bin away.
   */
  const failures: ((error: Error) => void)[] = [];
  spawned.child.once("exit", (code) => {
    const reason = new Error(
      `${name} exited ${String(code)} before answering: ${spawned.stderr().slice(0, 400)}`,
    );
    for (const fail of failures.splice(0)) fail(reason);
    pending.clear();
  });

  const rpc = (method: string, params: unknown): Promise<JsonRpcMessage> => {
    nextId += 1;
    const id = nextId;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`stdio rpc timed out: ${method}`));
      }, RPC_TIMEOUT_MS);
      const settle = (outcome: (value: JsonRpcMessage) => void) => (message: JsonRpcMessage) => {
        clearTimeout(timer);
        outcome(message);
      };
      failures.push((error) => {
        clearTimeout(timer);
        reject(error);
      });
      pending.set(id, settle(resolve));
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
    waitForExit: (ms: number): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        if (spawned.child.exitCode !== null) {
          resolve(true);
          return;
        }
        const timer = setTimeout(() => resolve(false), ms);
        spawned.child.once("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      }),
    writeRaw: (text: string): void => {
      spawned.child.stdin.write(text);
    },
  };
}

export interface HttpClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly initialize: () => Promise<void>;
  readonly port: number;
  readonly post: (body: string) => Promise<{ body: string; status: number }>;
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

  const post = async (body: string): Promise<{ body: string; status: number }> => {
    const response = await fetch(`${origin}/mcp`, {
      body,
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
        ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
      },
      method: "POST",
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const bound = response.headers.get("mcp-session-id");
    if (bound !== null) sessionId = bound;
    return { body: await response.text(), status: response.status };
  };

  return {
    child: spawned.child,
    initialize: async (): Promise<void> => {
      nextId += 1;
      await post(JSON.stringify({
        id: nextId, jsonrpc: "2.0", method: "initialize",
        params: { capabilities: {}, clientInfo: { name: "portability-matrix", version: "0" },
          protocolVersion: "2025-06-18" },
      }));
    },
    port: Number(new URL(origin).port),
    post,
  };
}

/** Declares a body far larger than what is sent, then drops the connection: the
 *  listener must neither answer it nor wedge. */
export function truncateHttpBody(port: number, credential: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.write(
        `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${credential}\r\n` +
          'Content-Type: application/json\r\nContent-Length: 5000\r\n\r\n{"jsonrpc":"2.0"',
      );
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 250);
    });
    socket.once("error", () => resolve());
  });
}

/** Raw POST outside the client's session, for refusals the screen answers first. */
export async function rawPost(
  port: number,
  bearer: string,
  body: string,
): Promise<{ body: string; status: number }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
    body,
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  return { body: await response.text(), status: response.status };
}

export type Reply = { readonly message: JsonRpcMessage; readonly status: number | null };

/** One transport, driven the same way regardless of how its bytes are framed. */
export interface Driver {
  readonly call: (name: string, args: Readonly<Record<string, unknown>>) => Promise<Reply>;
  readonly raw: (method: string, params: unknown) => Promise<Reply>;
  readonly stop: () => Promise<void>;
}

export async function stdioDriver(workspace: PortabilityWorkspace, credential: string): Promise<Driver> {
  const env = environmentFor(workspace, { MOE_SESSION_CREDENTIAL: credential });
  const client = stdioClient("moe-mcp-stdio", env);
  await client.initialize();
  const raw = async (method: string, params: unknown): Promise<Reply> =>
    ({ message: await client.rpc(method, params), status: null });
  return {
    call: (name, args) => raw("tools/call", { arguments: args, name }),
    raw,
    stop: () => killTree(client.child),
  };
}

export async function httpDriver(
  workspace: PortabilityWorkspace,
  credential: string,
): Promise<Driver & { readonly port: number }> {
  const client = await httpClient(environmentFor(workspace), credential);
  await client.initialize();
  let nextId = 100;
  const raw = async (method: string, params: unknown): Promise<Reply> => {
    nextId += 1;
    const answer = await client.post(JSON.stringify({ id: nextId, jsonrpc: "2.0", method, params }));
    return { message: JSON.parse(answer.body) as JsonRpcMessage, status: answer.status };
  };
  return {
    call: (name, args) => raw("tools/call", { arguments: args, name }),
    port: client.port,
    raw,
    stop: async (): Promise<void> => {
      await killTree(client.child);
    },
  };
}

/**
 * A real child Node process with an explicit cwd, reporting JSON on stdout. The
 * JetBrains half needs this: vitest rewrites a `./x.js` specifier back to `x.ts`
 * and Node does not, so only a child proves the shipped `.js` bridge and the
 * package `exports` map are what actually resolve.
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
    }, 90_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`node child exited ${String(code)}: ${err.slice(0, 800)}`));
    });
  });
}
