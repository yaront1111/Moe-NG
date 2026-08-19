import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, expectTypeOf, it } from "vitest";

import {
  DAEMON_ENTRY_LAYER,
  DAEMON_ENTRY_REFUSAL_CODES,
  startDaemon,
} from "./daemon-entry.js";
import type { DaemonDependencyProvider, DaemonStartOptions } from "./daemon-entry.js";
import { fixtureDependencies } from "./daemon-entry-fixtures.js";
import { CONTROL_ROOM_LISTENER_LAYER } from "./http/http-listener.js";

const PACKAGE_DIR = join(import.meta.dirname, "..");

function invalidProvider(value: unknown): DaemonDependencyProvider {
  return { provide: () => value } as unknown as DaemonDependencyProvider;
}

async function occupyPort(): Promise<{ close(): Promise<void>; readonly port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP address");
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    port: address.port,
  };
}

it("refuses incomplete dependency results before binding or invoking subscriptions", async () => {
  expect(DAEMON_ENTRY_REFUSAL_CODES).toContain("DAEMON_ENTRY_DEPENDENCIES_INVALID");
  const occupied = await occupyPort();
  let subscriptions = 0;
  const provider = {
    provide: () => ({ authenticator: {}, decisions: {}, registry: {} }),
    subscriptions: () => {
      subscriptions += 1;
      throw new Error("must not run");
    },
  } as unknown as DaemonDependencyProvider;
  try {
    const result = await startDaemon({ dependencies: provider, port: occupied.port });
    expect(result).toEqual({
      code: "DAEMON_ENTRY_DEPENDENCIES_INVALID",
      layer: DAEMON_ENTRY_LAYER,
      ok: false,
    });
    expect(subscriptions).toBe(0);
  } finally {
    await occupied.close();
  }
});

it("normalizes hostile dependency and subscription shapes to the same closed refusal", async () => {
  const hostile = new Proxy({}, { get: () => { throw new Error("secret getter"); } });
  const invalidSubscriptions = {
    provide: fixtureDependencies,
    subscriptions: () => ({}),
  } as unknown as DaemonDependencyProvider;
  for (const dependencies of [invalidProvider(hostile), invalidSubscriptions]) {
    const result = await startDaemon({ dependencies });
    expect(result).toEqual({
      code: "DAEMON_ENTRY_DEPENDENCIES_INVALID",
      layer: DAEMON_ENTRY_LAYER,
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("secret getter");
  }
});

it("keeps a valid provider's occupied-port refusal at the listener layer", async () => {
  const occupied = await occupyPort();
  try {
    const result = await startDaemon({
      dependencies: { provide: fixtureDependencies },
      port: occupied.port,
    });
    expect(result).toEqual({
      code: "LISTENER_BIND_FAILED",
      layer: CONTROL_ROOM_LISTENER_LAYER,
      ok: false,
    });
  } finally {
    await occupied.close();
  }
});

it("declares the source entry, bin and canonical clean-shell start command", async () => {
  const manifest = JSON.parse(await readFile(join(PACKAGE_DIR, "package.json"), "utf8")) as {
    readonly bin?: Record<string, string>;
    readonly main?: string;
    readonly scripts?: Record<string, string>;
  };
  expect(manifest.main).toBe("./src/index.ts");
  // Closed set on purpose: a new bin is a new supported entry point and must be declared here
  // deliberately. `moe-mcp-http` is the Streamable HTTP MCP host (task-159be643); `moe-mcp-stdio`
  // is the stdio MCP host, published by task-f33028b5 so acceptance drives the installed shim.
  // `moe-up` is the single-command development launcher (task-bc9b4bed): it starts the daemon and
  // the wrapper as children and composes both entries above without modifying either.
  // `moe` is the packaged CLI (task-3ac5c237) whose `start` composes `moe-up`; `moe-wrapper`
  // publishes the wrapper entry the launcher already spawns, so the distributed artifact names
  // an entry point rather than hardcoding a `src/` path.
  expect(manifest.bin).toEqual({
    moe: "./src/cli/moe-cli-main.ts",
    "moe-daemon": "./src/daemon-main.ts",
    "moe-mcp-http": "./src/mcp-http/mcp-http-main.ts",
    "moe-mcp-stdio": "./src/mcp-main.ts",
    "moe-up": "./src/orchestrator/moe-up-main.ts",
    "moe-wrapper": "./src/orchestrator/agent-wrapper-main.ts",
  });
  expect(manifest.scripts?.["start"]).toBe(
    "node ./src/daemon-main.ts --dependencies=./src/daemon-store-dependencies.ts --port=39123",
  );
  type HasCredential = "credential" extends keyof DaemonStartOptions ? true : false;
  expectTypeOf<HasCredential>().toEqualTypeOf<false>();
});

interface Capture {
  text: string;
}

function captureChild(child: ChildProcessWithoutNullStreams): Capture {
  const capture = { text: "" };
  const absorb = (chunk: Buffer): void => { capture.text += chunk.toString("utf8"); };
  child.stdout.on("data", absorb);
  child.stderr.on("data", absorb);
  return capture;
}

async function waitForMatch(capture: Capture, pattern: RegExp): Promise<RegExpMatchArray> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const match = capture.text.match(pattern);
    if (match !== null) return match;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`deadline waiting for ${String(pattern)} in ${capture.text}`);
}

async function waitForClose(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
}

async function postUnknownRoute(port: number): Promise<{ readonly body: string; readonly status: number }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", method: "POST", path: "/not-a-route", port },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({
          body: Buffer.concat(chunks).toString("utf8"),
          status: response.statusCode ?? 0,
        }));
      },
    );
    request.on("error", reject);
    request.end("{}");
  });
}

async function proveRebind(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function wrapperSource(entryUrl: string): string {
  return `import { runDaemonMain } from ${JSON.stringify(entryUrl)};
let shutdown;
process.stdin.setEncoding("utf8");
process.stdin.once("data", async () => {
  if (shutdown === undefined) process.exit(3);
  const result = await shutdown();
  console.log("SHUTDOWN " + JSON.stringify(result));
  process.exit(result.ok ? 0 : 4);
});
const code = await runDaemonMain(process.argv.slice(2), {
  log: (line) => console.log(line),
  onStarted: (callback) => { shutdown = callback; console.log("STARTED"); },
});
if (code !== 0) process.exit(code);
`;
}

const PROVIDER_SOURCE = `export default {
  provide() {
    return {
      authenticator: { authenticate() { return { verdict: "UNAUTHENTICATED" }; } },
      decisions: { decide() { throw new Error("unreachable"); } },
      registry: new Map(),
    };
  },
};
`;

it("starts in a clean child, serves a real socket, shuts down and releases the port", async () => {
  const temp = await mkdtemp(join(tmpdir(), "moe-daemon-probe-"));
  const providerPath = join(temp, "provider.mjs");
  const wrapperPath = join(temp, "wrapper.mjs");
  const entryUrl = pathToFileURL(join(PACKAGE_DIR, "src", "daemon-main.ts")).href;
  await writeFile(providerPath, PROVIDER_SOURCE, "utf8");
  await writeFile(wrapperPath, wrapperSource(entryUrl), "utf8");

  const child = spawn(process.execPath, [wrapperPath, `--dependencies=${providerPath}`, "--port=0"], {
    cwd: PACKAGE_DIR,
  });
  const output = captureChild(child);
  try {
    const started = await waitForMatch(output, /listening on http:\/\/127\.0\.0\.1:(\d+)/u);
    const port = Number(started[1]);
    const reply = await postUnknownRoute(port);
    expect(reply).toEqual({
      body: JSON.stringify({ code: "LISTENER_ROUTE_UNKNOWN", layer: CONTROL_ROOM_LISTENER_LAYER }),
      status: 404,
    });
    child.stdin.write("shutdown\n");
    await waitForMatch(output, /SHUTDOWN \{"ok":true\}/u);
    const exit = await waitForClose(child);
    expect(exit).toBe(0);
    await proveRebind(port);
    console.log(`REAL_SOCKET_PROBE status=${reply.status} body=${reply.body} shutdown=ok exit=${String(exit)} rebind=ok`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitForClose(child);
    }
    await rm(temp, { force: true, recursive: true });
  }
}, 30_000);
