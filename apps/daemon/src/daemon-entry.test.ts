import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  DAEMON_ENTRY_LAYER,
  DAEMON_ENTRY_REFUSAL_CODES,
  startDaemon,
} from "./daemon-entry.js";
import type { DaemonDependencyProvider, StartedDaemon } from "./daemon-entry.js";
import { CONTROL_ROOM_LISTENER_LAYER } from "./http/http-listener.js";
import provider from "./daemon-entry-fixtures.js";

const PACKAGE_DIR = join(import.meta.dirname, "..");

interface SpawnResult {
  readonly code: number | null;
  readonly output: string;
}

function manifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

function binPath(): string {
  const bin = manifest()["bin"] as Record<string, string>;
  return join(PACKAGE_DIR, bin["moe-daemon"] ?? "");
}

/**
 * Runs the declared bin AS A PROCESS. Killed on every exit path, because a
 * surviving child keeps its port and surfaces later on Windows as EBUSY rather
 * than as the real error.
 */
async function runBin(args: readonly string[]): Promise<SpawnResult> {
  const child = spawn(process.execPath, [binPath(), ...args], { cwd: PACKAGE_DIR });
  let output = "";
  try {
    return await new Promise<SpawnResult>((resolve, reject) => {
      const absorb = (chunk: Buffer): void => {
        output += chunk.toString("utf8");
      };
      child.stdout.on("data", absorb);
      child.stderr.on("data", absorb);
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
    });
  } finally {
    child.kill();
  }
}

/** Every started daemon is shut down, including when the body throws. */
async function withDaemon(run: (daemon: StartedDaemon) => Promise<void>): Promise<void> {
  const started = await startDaemon({ dependencies: provider });
  if (!started.ok) throw new Error(`daemon refused to start: ${started.code}`);
  try {
    await run(started);
  } finally {
    await started.shutdown();
  }
}

it("declares every refusal code it can emit in one frozen vocabulary", () => {
  expect(Object.isFrozen(DAEMON_ENTRY_REFUSAL_CODES)).toBe(true);
  expect(new Set(DAEMON_ENTRY_REFUSAL_CODES).size).toBe(DAEMON_ENTRY_REFUSAL_CODES.length);
  expect(DAEMON_ENTRY_LAYER).toBe("DAEMON_ENTRY");
});

it("starts, binds an ephemeral loopback port, reports it, and shuts down", async () => {
  await withDaemon(async (daemon) => {
    expect(daemon.port).toBeGreaterThan(0);
    expect(daemon.origin).toBe(`http://127.0.0.1:${daemon.port}`);
  });
});

it("refuses to start with no dependency provider, by its own specific code", async () => {
  const started = await startDaemon({});
  expect(started).toMatchObject({
    code: "DAEMON_ENTRY_NO_DEPENDENCY_PROVIDER",
    layer: DAEMON_ENTRY_LAYER,
    ok: false,
  });
  // Nothing may be left listening behind a refused start.
  expect(started).not.toHaveProperty("port");
});

it("refuses with a DISTINCT code when the provider itself throws", async () => {
  const exploding: DaemonDependencyProvider = {
    provide() {
      throw new Error("provider exploded");
    },
  };
  const started = await startDaemon({ dependencies: exploding });
  expect(started).toMatchObject({
    code: "DAEMON_ENTRY_PROVIDER_THREW",
    layer: DAEMON_ENTRY_LAYER,
    ok: false,
  });
  expect(started).not.toHaveProperty("port");
});

it("surfaces a non-loopback refusal with the LISTENER's own code and layer, unflattened", async () => {
  // PortRefusal's contract: the entry holds no translation table. Two layers can
  // refuse here, so the test names which one did — collapsing this into a
  // DAEMON_ENTRY code would hide that the listener made the security decision.
  const started = await startDaemon({ dependencies: provider, host: "0.0.0.0" });
  expect(started).toMatchObject({
    code: "LISTENER_NON_LOOPBACK_BIND",
    layer: CONTROL_ROOM_LISTENER_LAYER,
    ok: false,
  });
  expect((DAEMON_ENTRY_REFUSAL_CODES as readonly string[])).not.toContain(
    "LISTENER_NON_LOOPBACK_BIND",
  );
});

it("refuses a second shutdown with its own code and genuinely releases the port", async () => {
  const started = await startDaemon({ dependencies: provider });
  if (!started.ok) throw new Error("expected a started daemon");
  expect(await started.shutdown()).toMatchObject({ ok: true });
  expect(await started.shutdown()).toMatchObject({
    code: "DAEMON_ENTRY_ALREADY_STOPPED",
    layer: DAEMON_ENTRY_LAYER,
    ok: false,
  });

  const reused = await startDaemon({ dependencies: provider, port: started.port });
  expect(reused.ok).toBe(true);
  if (reused.ok) await reused.shutdown();
});

it("mints a CSRF token in process and never writes it to a log line", async () => {
  const lines: string[] = [];
  const started = await startDaemon({ dependencies: provider, log: (l) => lines.push(l) });
  if (!started.ok) throw new Error("expected a started daemon");
  try {
    expect(started.csrfToken.length).toBeGreaterThan(0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(started.csrfToken);
  } finally {
    await started.shutdown();
  }
});

it("declares an entry point in its manifest and both files exist", () => {
  const declared = manifest();
  expect(typeof declared["main"]).toBe("string");
  expect(declared["bin"]).toMatchObject({ "moe-daemon": expect.any(String) as unknown as string });
  expect(readFileSync(join(PACKAGE_DIR, declared["main"] as string), "utf8").length).toBeGreaterThan(0);
  expect(readFileSync(binPath(), "utf8")).toContain("#!");
});

it("runs as a process and fails closed, naming the code, when given no provider", async () => {
  // A real child process, not an in-process call: the whole claim under test is
  // that the declared bin is executable by Node at all, which in-process code
  // cannot show. It fails CLOSED rather than serving an invented registry.
  const result = await runBin([]);
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("DAEMON_ENTRY_NO_DEPENDENCY_PROVIDER");
  expect(result.output).toContain(DAEMON_ENTRY_LAYER);
  // The token is minted per start and must never reach process output.
  expect(result.output).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
}, 30_000);
