import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, describe, expect, it } from "vitest";

import { claudeSpawner } from "./agent-spawner.js";
import type { AgentSpawnerOptions } from "./agent-spawner.js";
import type { SpawnRequest } from "./agent-wrapper.js";

/**
 * A fake child: records what it was spawned with, exposes stdin as a real
 * stream so the mission bytes can be read back, and exits when told to.
 */
interface FakeChild {
  readonly args: readonly string[];
  readonly emitter: EventEmitter;
  readonly file: string;
  readonly options: { readonly cwd?: unknown; readonly shell?: unknown };
  readonly stdin: PassThrough;
}

function fakeSpawn(): { calls: FakeChild[]; spawn: NonNullable<AgentSpawnerOptions["spawn"]> } {
  const calls: FakeChild[] = [];
  const spawn: NonNullable<AgentSpawnerOptions["spawn"]> = (file, args, options) => {
    const emitter = new EventEmitter();
    const stdin = new PassThrough();
    calls.push({ args, emitter, file, options, stdin });
    return Object.assign(emitter, { stdin }) as unknown as ReturnType<
      NonNullable<AgentSpawnerOptions["spawn"]>
    >;
  };
  return { calls, spawn };
}

const STORE_ENV = Object.freeze({
  MOE_DAEMON_CREDENTIAL: "operator-secret",
  MOE_PROJECT_ID: "proj-1",
  MOE_STORE_PATH: "D:/tmp/store.sqlite",
});

function request(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    credential: "agent-secret-0001",
    expiresAt: "2026-01-01T00:00:00.000Z",
    kind: "project.register",
    mission: "You hold the claim on project.register@proj-1. Dispatch it.",
    sessionId: "sess-wrap-0001",
    workItemId: "project.register@proj-1",
    workspace: null,
    ...overrides,
  };
}

const configPathOf = (child: FakeChild): string => {
  // On Windows the argv collapses into ONE shell line; on POSIX it stays argv.
  const line = child.args.length === 0 ? child.file : child.args.join(" ");
  const match = /--mcp-config "?([^" ]+)"?/u.exec(line);
  if (match?.[1] === undefined) throw new Error(`no --mcp-config in ${line}`);
  return match[1];
};

const sandboxes: string[] = [];
afterAll(() => {
  for (const sandbox of sandboxes) rmSync(sandbox, { force: true, recursive: true });
});

/**
 * Builds a spawner whose config directory can be READ BACK exactly rather than
 * guessed: `claudeSpawner` mints it with `mkdtempSync(join(tmpdir(), ...))` at
 * construction time and never exposes it, so tmpdir() is pointed at a private
 * sandbox for the duration of the construction call. Node resolves tmpdir()
 * from TMPDIR/TMP/TEMP, so all three move together and are restored after.
 */
function spawnerInSandbox(options: AgentSpawnerOptions): {
  configDir: string;
  spawner: (request: SpawnRequest) => Promise<void>;
} {
  const sandbox = mkdtempSync(join(tmpdir(), "moe-spawner-case-"));
  sandboxes.push(sandbox);
  const keys = ["TMPDIR", "TMP", "TEMP"] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) process.env[key] = sandbox;
  let spawner: (request: SpawnRequest) => Promise<void>;
  try {
    spawner = claudeSpawner(STORE_ENV, options);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const entries = readdirSync(sandbox);
  const only = entries[0];
  // A wrong count means the construction did not mint its directory here, so
  // every later filesystem assertion would be looking at the wrong place.
  if (entries.length !== 1 || only === undefined) {
    throw new Error(`expected one config dir in ${sandbox}, got [${entries.join(", ")}]`);
  }
  return { configDir: join(sandbox, only), spawner };
}

describe("claudeSpawner", () => {
  it("hands the agent's credential to the MCP server via the config file, never argv or mission", async () => {
    const { calls, spawn } = fakeSpawn();
    const logs: string[] = [];
    const spawner = claudeSpawner(STORE_ENV, { command: "claude", log: (l) => logs.push(l), spawn });
    const req = request();
    const done = spawner(req);
    const child = calls[0];
    if (child === undefined) throw new Error("nothing spawned");

    const configPath = configPathOf(child);
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers: { "moe-next": { env: Record<string, string>; command: string } };
    };
    expect(config.mcpServers["moe-next"].command).toBe("node");
    expect(config.mcpServers["moe-next"].env).toEqual({
      ...STORE_ENV,
      MOE_SESSION_CREDENTIAL: req.credential,
    });
    // The credential is not on the command line.
    expect(`${child.file} ${child.args.join(" ")}`).not.toContain(req.credential);
    // The mission travels over stdin, verbatim.
    child.stdin.end();
    const mission = await new Promise<string>((resolve) => {
      let text = "";
      child.stdin.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
      child.stdin.on("end", () => resolve(text));
    });
    expect(mission).toBe(req.mission);

    // Chain agents get the MCP-only tool surface.
    expect(`${child.file} ${child.args.join(" ")}`).toContain("--allowedTools mcp__moe-next,mcp__moe-next__*");
    expect(`${child.file} ${child.args.join(" ")}`).not.toContain("Bash");

    child.emitter.emit("exit", 0);
    await done;
    // The config file — the only place the credential is written — is gone.
    expect(existsSync(configPath)).toBe(false);
    expect(logs).toEqual(["[wrapper] project.register@proj-1 agent exited 0"]);
  });

  it("gives code-node agents file/exec tools and runs them in their workspace", async () => {
    const { calls, spawn } = fakeSpawn();
    const spawner = claudeSpawner(STORE_ENV, { command: "claude", log: () => undefined, spawn });
    const done = spawner(request({ workspace: "D:/ws/node-1" }));
    const child = calls[0];
    if (child === undefined) throw new Error("nothing spawned");
    expect(child.options.cwd).toBe("D:/ws/node-1");
    expect(`${child.file} ${child.args.join(" ")}`).toContain(
      "--allowedTools mcp__moe-next,mcp__moe-next__*,Edit,Write,Read,Glob,Grep,Bash",
    );
    child.emitter.emit("exit", 0);
    await done;
  });

  it("kills a hung agent after its lifetime bound and resolves, freeing the slot", async () => {
    const { calls, spawn } = fakeSpawn();
    const killed: string[] = [];
    const spawner = claudeSpawner(STORE_ENV, {
      command: "claude", log: (l) => killed.push(l), spawn,
      platform: "linux", timeoutMs: 20,
    });
    // The agent process never emits exit or error: only the timeout frees it.
    const done = spawner(request());
    const child = calls[0];
    if (child === undefined) throw new Error("nothing spawned");
    const originalKill = (child.emitter as unknown as { kill?: () => void });
    let killCalls = 0;
    originalKill.kill = () => { killCalls += 1; };
    await done; // resolves via the timeout, not an exit event
    expect(killCalls).toBe(1);
    expect(killed.some((l) => /exceeded 20ms; killing/u.test(l))).toBe(true);
    // The credentialed config file is gone even though the agent never exited.
    expect(existsSync(configPathOf(child))).toBe(false);
  });

  it("does not kill an agent that exits before its lifetime bound", async () => {
    const { calls, spawn } = fakeSpawn();
    const spawner = claudeSpawner(STORE_ENV, {
      command: "claude", log: () => undefined, spawn, platform: "linux", timeoutMs: 10_000,
    });
    const done = spawner(request());
    const child = calls[0];
    if (child === undefined) throw new Error("nothing spawned");
    let killCalls = 0;
    (child.emitter as unknown as { kill?: () => void }).kill = () => { killCalls += 1; };
    child.emitter.emit("exit", 0);
    await done;
    expect(killCalls).toBe(0);
  });

  it("removes the config file on the error path too", async () => {
    const { calls, spawn } = fakeSpawn();
    const spawner = claudeSpawner(STORE_ENV, { command: "claude", log: () => undefined, spawn });
    const done = spawner(request());
    const child = calls[0];
    if (child === undefined) throw new Error("nothing spawned");
    const configPath = configPathOf(child);
    expect(existsSync(configPath)).toBe(true);
    child.emitter.emit("error", new Error("ENOENT"));
    await done;
    expect(existsSync(configPath)).toBe(false);
  });

  it("refuses an unquotable command line without ever writing the credential to disk", async () => {
    const { calls, spawn } = fakeSpawn();
    // `"` cannot be quoted for cmd.exe, and the command is the FIRST piece of
    // the line, so building the invocation refuses before anything else. The
    // real-world trigger needs no hostile input: an ordinary Windows account
    // name carrying & ^ % < > | or " puts tmpdir() itself beyond quoting.
    // `platform` is explicit because agentSpawnInvocation returns early for
    // every non-win32 platform — without it this case would reach no guard at
    // all on a Linux or macOS runner and pass while testing nothing.
    const { configDir, spawner } = spawnerInSandbox({
      command: 'claude"evil', log: () => undefined, platform: "win32", spawn,
    });
    const req = request();

    // The refusal must arrive as a REJECTION. The wrapper calls
    // `spawnAgent(...).catch(...)` WITHOUT await (agent-wrapper.ts:226), so a
    // synchronous throw would escape the poll tick entirely.
    let returned: Promise<void> | undefined;
    expect(() => { returned = spawner(req); }).not.toThrow();
    await expect(returned).rejects.toMatchObject({
      code: "SPAWN_ARGUMENT_UNQUOTABLE",
      layer: "agent-spawn-invocation",
    });

    expect(calls).toEqual([]);
    // The credential never reached disk: the whole config directory is empty,
    // not merely the one named path removed.
    expect(existsSync(join(configDir, `${req.sessionId}.json`))).toBe(false);
    expect(readdirSync(configDir)).toEqual([]);
  });
});
