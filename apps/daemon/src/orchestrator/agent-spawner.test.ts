import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

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
});
