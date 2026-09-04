import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, describe, expect, it, vi } from "vitest";

import * as spawnerModule from "./agent-spawner.js";
import { claudeSpawner } from "./agent-spawner.js";
import type { AgentSpawnerOptions } from "./agent-spawner.js";
import type { SpawnRequest } from "./agent-wrapper.js";

/**
 * Startup admission and process lifetime are different facts, so they are
 * different promises. Resolved through the module NAMESPACE rather than a named
 * import: a missing named import fails the whole file to load and reports ZERO
 * executed tests, which is indistinguishable from a suite that tested nothing.
 */
type AgentSpawnStartResult =
  | { readonly ok: false; readonly code: string; readonly layer: string }
  // `exit` now resolves the seat's exit REPORT (or void on the legacy paths); this
  // mirror stays deliberately loose so a shape change is caught by an arm, not by tsc.
  | { readonly ok: true; readonly exit: Promise<unknown> };
type AgentSpawnStart = (request: SpawnRequest) => Promise<AgentSpawnStartResult>;

function claudeSpawnStarter(origin: string, options: AgentSpawnerOptions): AgentSpawnStart {
  const exported = (spawnerModule as unknown as Record<string, unknown>)["claudeSpawnStarter"];
  expect(typeof exported, "production claudeSpawnStarter export is absent").toBe("function");
  return (exported as (o: string, p: AgentSpawnerOptions) => AgentSpawnStart)(origin, options);
}

/** Every character cmd.exe reinterprets even inside quotes, per agent-spawn-invocation. */
const UNQUOTABLE_TOKENS = Object.freeze(
  ['"', "%", "!", "&", "(", ")", "|", "<", ">", "^", "\r", "\n"] as const,
);

const settledFlag = (promise: Promise<unknown>): { readonly settled: () => boolean } => {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  return { settled: (): boolean => done };
};

const drainMicrotasks = async (): Promise<void> => {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
};

/**
 * A fake child: records what it was spawned with, exposes stdin as a real
 * stream so the mission bytes can be read back, and exits when told to.
 */
interface FakeChild {
  readonly args: readonly string[];
  readonly emitter: EventEmitter;
  readonly file: string;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly options: { readonly cwd?: unknown; readonly env?: NodeJS.ProcessEnv | undefined;
    readonly detached?: unknown; readonly shell?: unknown };
  readonly stderr: PassThrough;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly unref: ReturnType<typeof vi.fn>;
}

function fakeSpawn(pid?: number): {
  calls: FakeChild[];
  spawn: NonNullable<AgentSpawnerOptions["spawn"]>;
} {
  const calls: FakeChild[] = [];
  const spawn: NonNullable<AgentSpawnerOptions["spawn"]> = (file, args, options) => {
    const emitter = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const kill = vi.fn();
    const unref = vi.fn();
    calls.push({ args, emitter, file, kill, options, stderr, stdin, stdout, unref });
    return Object.assign(emitter, { kill, pid, stderr, stdin, stdout, unref }) as unknown as ReturnType<
      NonNullable<AgentSpawnerOptions["spawn"]>
    >;
  };
  return { calls, spawn };
}

const MCP_ORIGIN = "http://127.0.0.1:39124";

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
function inSandbox<Made>(
  construct: (origin: string, options: AgentSpawnerOptions) => Made,
  options: AgentSpawnerOptions,
): { configDir: string; made: Made } {
  const sandbox = mkdtempSync(join(tmpdir(), "moe-spawner-case-"));
  sandboxes.push(sandbox);
  const keys = ["TMPDIR", "TMP", "TEMP"] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) process.env[key] = sandbox;
  let made: Made;
  try {
    made = construct(MCP_ORIGIN, options);
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
  return { configDir: join(sandbox, only), made };
}

function spawnerInSandbox(options: AgentSpawnerOptions): {
  configDir: string;
  spawner: (request: SpawnRequest) => Promise<void>;
} {
  const { configDir, made } = inSandbox(claudeSpawner, options);
  return { configDir, spawner: made };
}

describe("claudeSpawner", () => {
  it.each([
    "https://127.0.0.1:39124",
    "http://example.test:39124",
    "http://operator:secret@127.0.0.1:39124",
    "http://127.0.0.1:39124/untrusted-path",
  ])("refuses a non-loopback or authority-bearing MCP origin: %s", (origin) => {
    expect(() => claudeSpawner(origin)).toThrowError("MCP_HTTP_ORIGIN_INVALID");
  });

  it("hands only the scoped credential to loopback MCP, never the operator store authority", async () => {
    const { calls, spawn } = fakeSpawn();
    const logs: string[] = [];
    const spawner = claudeSpawner(MCP_ORIGIN, {
      command: "claude",
      environment: {
        ANTHROPIC_API_KEY: "provider-key-is-preserved",
        GITHUB_TOKEN: "unrelated-secret-must-not-reach-agent",
        MOE_DAEMON_CREDENTIAL: "operator-secret-must-not-reach-agent",
        MOE_PROJECT_ID: "proj-1",
        MOE_SESSION_CREDENTIAL: "stale-session-must-not-reach-agent",
        MOE_STORE_PATH: "D:/tmp/store.sqlite",
        moe_daemon_credential: "mixed-case-secret-must-not-reach-agent",
      },
      log: (l) => logs.push(l),
      // POSIX argv semantics: on win32 the argv collapses into ONE shell line
      // and `child.args` is empty, so the argv assertions below would be
      // unreachable on a Windows runner and would pass while testing nothing.
      platform: "linux",
      spawn,
    });
    const req = request();
    const done = spawner(req);
    const child = calls[0];
    if (child === undefined) throw new Error("nothing spawned");

    const configPath = configPathOf(child);
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers: { "moe-next": {
        headers: Record<string, string>; type: string; url: string;
      } };
    };
    expect(config.mcpServers["moe-next"]).toEqual({
      headers: { Authorization: `Bearer ${req.credential}` },
      type: "http",
      url: MCP_ORIGIN,
    });
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain("operator-secret-must-not-reach-agent");
    expect(serialized).not.toContain("store.sqlite");
    expect(serialized).not.toContain("MOE_");
    expect(child.options.env).toEqual({
      ANTHROPIC_API_KEY: "provider-key-is-preserved",
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      MAX_MCP_OUTPUT_TOKENS: "120000",
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
    });
    // The credential is not on the command line.
    expect(`${child.file} ${child.args.join(" ")}`).not.toContain(req.credential);
    // Bare mode would refuse the operator's sign-in; isolation is restated flag by flag.
    expect(`${child.file} ${child.args.join(" ")}`).not.toContain("--bare");
    const sources = child.args.indexOf("--setting-sources");
    expect(child.args.slice(sources, sources + 2)).toEqual(["--setting-sources", ""]);
    expect(`${child.file} ${child.args.join(" ")}`).toContain("--disable-slash-commands");
    expect(`${child.file} ${child.args.join(" ")}`).toContain("--strict-mcp-config");
    expect(`${child.file} ${child.args.join(" ")}`).toContain("--no-session-persistence");
    expect(child.args).toContain("");
    expect(child.args.slice(child.args.indexOf("--tools"), child.args.indexOf("--tools") + 2))
      .toEqual(["--tools", ""]);
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

    child.emitter.emit("close", 0, null);
    await done;
    // The config file — the only place the credential is written — is gone.
    expect(existsSync(configPath)).toBe(false);
    expect(logs).toEqual(["[wrapper] project.register@proj-1 agent exited 0"]);
  });

  it("gives code-node agents file/exec tools and runs them in their workspace", async () => {
    const { calls, spawn } = fakeSpawn();
    // POSIX argv semantics are what this case asserts: on win32 the whole argv
    // collapses into ONE shell line and `child.args` is empty, so without an
    // explicit platform these assertions are unreachable on a Windows runner.
    const spawner = claudeSpawner(MCP_ORIGIN, {
      command: "claude", log: () => undefined, platform: "linux", spawn,
    });
    const done = spawner(request({ workspace: "D:/ws/node-1" }));
    const child = calls[0];
    if (child === undefined) throw new Error("nothing spawned");
    expect(child.options.cwd).toBe("D:/ws/node-1");
    expect(`${child.file} ${child.args.join(" ")}`).toContain(
      "--allowedTools mcp__moe-next,mcp__moe-next__*,Edit,Write,Read,Glob,Grep,Bash",
    );
    expect(child.args.slice(child.args.indexOf("--tools"), child.args.indexOf("--tools") + 2))
      .toEqual(["--tools", "Edit,Write,Read,Glob,Grep,Bash"]);
    child.emitter.emit("close", 0, null);
    await done;
  });

  it("gives a CODEX seat the exec invocation, env-borne bearer and NO config file", async () => {
    const { calls, spawn } = fakeSpawn();
    const { configDir, made: spawner } = inSandbox(claudeSpawner, {
      command: "codex", log: () => undefined, platform: "linux", spawn,
    });
    const done = spawner(request({ workspace: "D:/ws/node-1" }));
    const child = calls[0];
    if (child === undefined) throw new Error("nothing spawned");
    // The measured codex-cli 0.151.0 surface: mission on stdin via `-`, host
    // config out, MCP as a streamable-HTTP override, sandbox from the seat kind.
    expect(child.file).toBe("codex");
    expect(child.args).toEqual([
      "exec",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox", "workspace-write",
      "-c", `mcp_servers.moe-next.url=${MCP_ORIGIN}`,
      "-c", "mcp_servers.moe-next.bearer_token_env_var=MOE_AGENT_MCP_BEARER",
      "-",
    ]);
    // The scoped bearer rides the child's OWN environment, never argv or disk;
    // no credential-bearing MCP config file exists for a codex seat.
    expect(child.options.env?.["MOE_AGENT_MCP_BEARER"]).toBe("agent-secret-0001");
    expect(`${child.file} ${child.args.join(" ")}`).not.toContain("agent-secret-0001");
    expect(readdirSync(configDir)).toEqual([]);
    // The mission still arrives on stdin.
    const mission = new Promise<string>((resolve) => {
      let text = "";
      child.stdin.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
      child.stdin.on("end", () => { resolve(text); });
    });
    expect(await mission).toContain("You hold the claim");
    child.emitter.emit("close", 0, null);
    await done;
  });

  it("keeps a chain-step CODEX seat read-only sandboxed", async () => {
    const { calls, spawn } = fakeSpawn();
    const { made: spawner } = inSandbox(claudeSpawner, {
      command: "codex", log: () => undefined, platform: "linux", spawn,
    });
    const done = spawner(request());
    const child = calls[0];
    if (child === undefined) throw new Error("nothing spawned");
    expect(child.args.slice(child.args.indexOf("--sandbox"), child.args.indexOf("--sandbox") + 2))
      .toEqual(["--sandbox", "read-only"]);
    child.emitter.emit("close", 0, null);
    await done;
  });

  it("preserves an enterprise proxy while forcing loopback MCP to bypass it", async () => {
    const { calls, spawn } = fakeSpawn();
    const spawner = claudeSpawner(MCP_ORIGIN, {
      command: "claude",
      environment: {
        HTTPS_PROXY: "http://proxy.example.test:8080",
        NO_PROXY: "internal.example.test",
        no_proxy: "legacy.example.test,localhost",
      },
      log: () => undefined,
      spawn,
    });
    const done = spawner(request());
    const child = calls[0];
    if (child === undefined) throw new Error("nothing spawned");

    expect(child.options.env).toMatchObject({
      HTTPS_PROXY: "http://proxy.example.test:8080",
      NO_PROXY: "internal.example.test,legacy.example.test,localhost,127.0.0.1,::1",
      no_proxy: "internal.example.test,legacy.example.test,localhost,127.0.0.1,::1",
    });
    child.emitter.emit("close", 0, null);
    await done;
  });

  it("kills a timed-out POSIX process group and waits for close before freeing the slot", async () => {
    vi.useFakeTimers();
    const { calls, spawn } = fakeSpawn(4321);
    const killed: string[] = [];
    const groupKills: { pid: number; signal: NodeJS.Signals }[] = [];
    const spawner = claudeSpawner(MCP_ORIGIN, {
      command: "claude",
      killProcessGroup: (pid, signal) => { groupKills.push({ pid, signal }); },
      killGraceMs: 30,
      log: (l) => killed.push(l),
      spawn,
      platform: "linux", timeoutMs: 20,
    });
    try {
      const done = spawner(request());
      const child = calls[0];
      if (child === undefined) throw new Error("nothing spawned");
      const configPath = configPathOf(child);
      let resolved = false;
      void done.then(() => { resolved = true; });

      expect(child.options.detached).toBe(true);
      await vi.advanceTimersByTimeAsync(20);
      expect(groupKills).toEqual([{ pid: -4321, signal: "SIGKILL" }]);
      expect(killed.some((l) => /exceeded 20ms; killing/u.test(l))).toBe(true);
      expect(resolved).toBe(false);
      expect(existsSync(configPath)).toBe(true);

      child.emitter.emit("close", null, "SIGKILL");
      await done;
      expect(resolved).toBe(true);
      expect(existsSync(configPath)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces fatal containment failure when close never confirms POSIX tree death", async () => {
    vi.useFakeTimers();
    const { calls, spawn } = fakeSpawn(4321);
    const groupKills: number[] = [];
    const spawner = claudeSpawner(MCP_ORIGIN, {
      command: "claude",
      killGraceMs: 30,
      killProcessGroup: (pid) => { groupKills.push(pid); },
      log: () => undefined,
      platform: "linux",
      spawn,
      timeoutMs: 20,
    });
    try {
      const done = spawner(request());
      const child = calls[0];
      if (child === undefined) throw new Error("nothing spawned");
      let settled = false;
      void done.finally(() => { settled = true; }).catch(() => undefined);

      await vi.advanceTimersByTimeAsync(49);
      expect(groupKills).toEqual([-4321]);
      expect(settled).toBe(false);
      expect(existsSync(configPathOf(child))).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      await expect(done).rejects.toMatchObject({
        code: "AGENT_PROCESS_CONTAINMENT_FAILED",
        reason: "CLOSE_NOT_OBSERVED",
      });
      expect(settled).toBe(true);
      expect(existsSync(configPathOf(child))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pins Windows taskkill and surfaces its failure despite agent close", async () => {
    vi.useFakeTimers();
    const agent = fakeSpawn(8765);
    const killer = fakeSpawn(9876);
    const calls: FakeChild[] = [];
    const spawn: NonNullable<AgentSpawnerOptions["spawn"]> = (file, args, options) => {
      const selected = calls.length === 0 ? agent : killer;
      const child = selected.spawn(file, args, options);
      const call = selected.calls[0];
      if (call === undefined) throw new Error("spawn was not recorded");
      calls.push(call);
      return child;
    };
    const spawner = claudeSpawner(MCP_ORIGIN, {
      command: "claude", killGraceMs: 30, log: () => undefined,
      environment: { SYSTEMROOT: "C:\\Windows" },
      platform: "win32", spawn, timeoutMs: 20,
    });
    try {
      const done = spawner(request());
      const configPath = configPathOf(agent.calls[0] as FakeChild);
      let resolved = false;
      void done.then(() => { resolved = true; }, () => undefined);
      await vi.advanceTimersByTimeAsync(20);

      expect(calls[0]?.options.detached).toBe(false);
      expect(calls[1]).toMatchObject({
        args: ["/pid", "8765", "/T", "/F"],
        file: "C:\\Windows\\System32\\taskkill.exe",
      });
      expect(killer.calls[0]?.unref).toHaveBeenCalledTimes(1);
      expect(() => killer.calls[0]?.emitter.emit("error", new Error("taskkill unavailable")))
        .not.toThrow();
      expect(killer.calls[0]?.kill).toHaveBeenCalledWith("SIGKILL");
      expect(() => agent.calls[0]?.emitter.emit("error", new Error("direct kill failed")))
        .not.toThrow();
      expect(resolved).toBe(false);
      expect(existsSync(configPath)).toBe(false);

      agent.calls[0]?.emitter.emit("close", 1, null);
      await expect(done).rejects.toMatchObject({
        code: "AGENT_PROCESS_CONTAINMENT_FAILED",
        reason: "TREE_KILL_FAILED",
      });
      expect(resolved).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats taskkill's no-running-instance exit as confirmed containment, not an escape", async () => {
    vi.useFakeTimers();
    const agent = fakeSpawn(8765);
    const killer = fakeSpawn(9876);
    const followUp = fakeSpawn(7654);
    const order = [agent, killer, followUp];
    const spawn: NonNullable<AgentSpawnerOptions["spawn"]> = (file, args, options) => {
      const selected = order.shift();
      if (selected === undefined) throw new Error("unexpected extra spawn");
      return selected.spawn(file, args, options);
    };
    const spawner = claudeSpawner(MCP_ORIGIN, {
      command: "claude", killGraceMs: 30, log: () => undefined,
      environment: { SYSTEMROOT: "C:\\Windows" },
      platform: "win32", spawn, timeoutMs: 20,
    });
    try {
      const done = spawner(request());
      await vi.advanceTimersByTimeAsync(20);

      // The agent exits naturally in the same instant the killer lands, so
      // taskkill finds no running instance and reports 128 instead of 0. An
      // already-dead tree is the terminated outcome containment was asked
      // for, not a containment failure.
      agent.calls[0]?.emitter.emit("close", 0, null);
      killer.calls[0]?.emitter.emit("close", 128, null);
      await expect(done).resolves.toBeUndefined();

      // The spawner stayed open: the next spawn is admitted, not refused closed.
      const later = spawner(request({ sessionId: "sess-wrap-0002" }));
      followUp.calls[0]?.emitter.emit("close", 0, null);
      await expect(later).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats any nonzero taskkill exit as confirmed containment once the child provably closed", async () => {
    vi.useFakeTimers();
    const agent = fakeSpawn(8765);
    const killer = fakeSpawn(9876);
    const followUp = fakeSpawn(7654);
    const order = [agent, killer, followUp];
    const spawn: NonNullable<AgentSpawnerOptions["spawn"]> = (file, args, options) => {
      const selected = order.shift();
      if (selected === undefined) throw new Error("unexpected extra spawn");
      return selected.spawn(file, args, options);
    };
    const spawner = claudeSpawner(MCP_ORIGIN, {
      command: "claude", killGraceMs: 30, log: () => undefined,
      environment: { SYSTEMROOT: "C:\\Windows" },
      platform: "win32", spawn, timeoutMs: 20,
    });
    try {
      const done = spawner(request());
      await vi.advanceTimersByTimeAsync(20);

      // Not the 128 arm: taskkill reports a garden-variety failure, but the
      // direct child has already provably closed — the same proof of an
      // already-dead tree. Only a LIVE child turns a failed killer fatal.
      agent.calls[0]?.emitter.emit("close", 0, null);
      killer.calls[0]?.emitter.emit("close", 1, null);
      await expect(done).resolves.toBeUndefined();

      // The spawner stayed open: the next spawn is admitted, not refused closed.
      const later = spawner(request({ sessionId: "sess-wrap-0002" }));
      followUp.calls[0]?.emitter.emit("close", 0, null);
      await expect(later).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a POSIX group-kill failure even when the direct child closes", async () => {
    vi.useFakeTimers();
    const { calls, spawn } = fakeSpawn(4321);
    const spawner = claudeSpawner(MCP_ORIGIN, {
      command: "claude",
      killGraceMs: 30,
      killProcessGroup: () => { throw new Error("EPERM"); },
      log: () => undefined,
      platform: "linux",
      spawn,
      timeoutMs: 20,
    });
    try {
      const done = spawner(request());
      const rejected = done.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20);
      calls[0]?.emitter.emit("close", null, "SIGKILL");
      expect(await rejected).toMatchObject({
        code: "AGENT_PROCESS_CONTAINMENT_FAILED",
        reason: "TREE_KILL_FAILED",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats an ESRCH group kill as an already-dead tree, not a tree-kill failure", async () => {
    vi.useFakeTimers();
    const { calls, spawn } = fakeSpawn(4321);
    const spawner = claudeSpawner(MCP_ORIGIN, {
      command: "claude",
      killGraceMs: 30,
      // The group leader exited before the signal landed: the kernel reports
      // ESRCH, which proves the tree is gone rather than out of reach.
      killProcessGroup: () => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      },
      log: () => undefined,
      platform: "linux",
      spawn,
      timeoutMs: 20,
    });
    try {
      const done = spawner(request());
      await vi.advanceTimersByTimeAsync(20);
      calls[0]?.emitter.emit("close", null, "SIGKILL");
      await expect(done).resolves.toBeUndefined();

      // The spawner stayed open: the next spawn is admitted, not refused closed.
      const later = spawner(request({ sessionId: "sess-wrap-0002" }));
      calls[1]?.emitter.emit("close", 0, null);
      await expect(later).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the containment rejection authoritative when a fatal observer throws", async () => {
    vi.useFakeTimers();
    const { spawn } = fakeSpawn(4321);
    const spawner = claudeSpawner(MCP_ORIGIN, {
      command: "claude",
      killProcessGroup: () => { throw new Error("EPERM"); },
      log: () => undefined,
      onFatalContainment: () => { throw new Error("observer failed"); },
      platform: "linux",
      spawn,
      timeoutMs: 20,
    });
    try {
      const done = spawner(request());
      const rejected = done.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20);
      expect(await rejected).toMatchObject({
        code: "AGENT_PROCESS_CONTAINMENT_FAILED",
        reason: "TREE_KILL_FAILED",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("close cancels owned agents and waits for confirmed process-tree death", async () => {
    vi.useFakeTimers();
    const { calls, spawn } = fakeSpawn(4321);
    const groupKills: number[] = [];
    const spawner = claudeSpawner(MCP_ORIGIN, {
      command: "claude",
      killGraceMs: 30,
      killProcessGroup: (pid) => { groupKills.push(pid); },
      log: () => undefined,
      platform: "linux",
      spawn,
      timeoutMs: 10_000,
    });
    try {
      const running = spawner(request());
      let closed = false;
      const closing = spawner.close();
      void closing.then(() => { closed = true; });

      expect(groupKills).toEqual([-4321]);
      expect(closed).toBe(false);
      await expect(spawner(request({ sessionId: "sess-late" })))
        .rejects.toThrowError("AGENT_SPAWNER_CLOSED");

      calls[0]?.emitter.emit("close", null, "SIGKILL");
      await expect(running).resolves.toBeUndefined();
      await expect(closing).resolves.toBeUndefined();
      expect(closed).toBe(true);
      expect(spawner.activeCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not kill an agent that exits before its lifetime bound", async () => {
    const { calls, spawn } = fakeSpawn();
    const spawner = claudeSpawner(MCP_ORIGIN, {
      command: "claude", log: () => undefined, spawn, platform: "linux", timeoutMs: 10_000,
    });
    const done = spawner(request());
    const child = calls[0];
    if (child === undefined) throw new Error("nothing spawned");
    let killCalls = 0;
    (child.emitter as unknown as { kill?: () => void }).kill = () => { killCalls += 1; };
    child.emitter.emit("close", 0, null);
    await done;
    expect(killCalls).toBe(0);
  });

  it("rejects a natural nonzero child exit with a stable process failure", async () => {
    const { calls, spawn } = fakeSpawn(4321);
    const spawner = claudeSpawner(MCP_ORIGIN, {
      command: "claude", log: () => undefined, spawn,
    });
    const done = spawner(request());
    const child = calls[0];
    if (child === undefined) throw new Error("nothing spawned");
    const configPath = configPathOf(child);

    child.emitter.emit("close", 1, null);

    await expect(done).rejects.toMatchObject({
      code: "AGENT_PROCESS_FAILED",
      exitCode: 1,
      message: "AGENT_PROCESS_FAILED:EXIT_NONZERO:1",
      reason: "EXIT_NONZERO",
      signal: null,
    });
    expect(spawner.activeCount()).toBe(0);
    expect(existsSync(configPath)).toBe(false);
  });

  it("rejects a spawn error without a pid and removes the config file", async () => {
    const { calls, spawn } = fakeSpawn();
    const spawner = claudeSpawner(MCP_ORIGIN, {
      command: "claude", log: () => undefined, spawn,
    });
    const done = spawner(request());
    const child = calls[0];
    if (child === undefined) throw new Error("nothing spawned");
    const configPath = configPathOf(child);
    expect(existsSync(configPath)).toBe(true);
    child.emitter.emit("error", new Error("ENOENT"));
    await expect(done).rejects.toMatchObject({
      code: "AGENT_PROCESS_FAILED",
      exitCode: null,
      message: "AGENT_PROCESS_FAILED:SPAWN_ERROR",
      reason: "SPAWN_ERROR",
      signal: null,
    });
    expect(spawner.activeCount()).toBe(0);
    expect(existsSync(configPath)).toBe(false);
  });

  it("removes the credentialed config when process creation throws", async () => {
    const { configDir, spawner } = spawnerInSandbox({
      command: "claude",
      spawn: () => { throw new Error("spawn refused"); },
    });

    await expect(spawner(request())).rejects.toThrowError("spawn refused");
    expect(readdirSync(configDir)).toEqual([]);
  });

  it("contains a fast-exiting agent's EPIPE instead of crashing the wrapper", async () => {
    vi.useFakeTimers();
    const { calls, spawn } = fakeSpawn(4321);
    const groupKills: number[] = [];
    const spawner = claudeSpawner(MCP_ORIGIN, {
      command: "claude",
      killGraceMs: 30,
      killProcessGroup: (pid) => { groupKills.push(pid); },
      log: () => undefined,
      // The POSIX negative-pid group kill this case asserts; win32 takes the
      // taskkill path instead and records nothing here.
      platform: "linux",
      spawn,
    });
    try {
      const done = spawner(request());
      const child = calls[0];
      if (child === undefined) throw new Error("nothing spawned");
      const configPath = configPathOf(child);
      let resolved = false;
      void done.then(() => { resolved = true; });

      expect(() => child.stdin.emit("error", Object.assign(new Error("write EPIPE"), {
        code: "EPIPE",
      }))).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);

      expect(groupKills).toEqual([-4321]);
      expect(resolved).toBe(false);
      expect(existsSync(configPath)).toBe(true);

      child.emitter.emit("close", 1, null);
      await done;
      expect(existsSync(configPath)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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

    // The refusal must arrive as a REJECTION. The wrapper observes the returned
    // promise without awaiting inside the poll tick, so a synchronous throw
    // would escape that tick entirely.
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

  it("converts the daemon module URL to a filesystem path for the default cwd", async () => {
    const decodedDaemonDirectory = "/tmp/moe daemon/שלום";
    vi.resetModules();
    vi.doMock("node:url", () => ({
      fileURLToPath: () => decodedDaemonDirectory,
    }));
    try {
      const dynamicallyLoaded = await import("./agent-spawner.js");
      const { calls, spawn } = fakeSpawn();
      const spawner = dynamicallyLoaded.claudeSpawner(MCP_ORIGIN, {
        command: "claude", log: () => undefined, spawn,
      });
      const done = spawner(request());
      const child = calls[0];
      if (child === undefined) throw new Error("nothing spawned");

      expect(child.options.cwd).toBe(decodedDaemonDirectory);
      child.emitter.emit("close", 0, null);
      await done;
    } finally {
      vi.doUnmock("node:url");
      vi.resetModules();
    }
  });
});

describe("claudeSpawnStarter", () => {
  it("refuses every cmd-unquotable token with the exact code and layer, before any credential exists", async () => {
    // Pinned by length so a silently emptied table cannot pass, and driven
    // through the production starter rather than through the quoting helper.
    expect(UNQUOTABLE_TOKENS.length, "the token table generated no cases").toBe(12);
    let executed = 0;
    for (const token of UNQUOTABLE_TOKENS) {
      const { calls, spawn } = fakeSpawn();
      // `platform` is explicit because agentSpawnInvocation returns early off
      // win32 — without it every case would reach no guard at all and pass.
      const { configDir, made: start } = inSandbox(claudeSpawnStarter, {
        command: `claude${token}`, log: () => undefined, platform: "win32", spawn,
      });
      const req = request();
      const result = await start(req);

      expect(result, `token ${JSON.stringify(token)} was not refused exactly`).toStrictEqual({
        code: "SPAWN_ARGUMENT_UNQUOTABLE",
        layer: "agent-spawn-invocation",
        ok: false,
      });
      expect(calls, `token ${JSON.stringify(token)} reached process creation`).toEqual([]);
      expect(existsSync(join(configDir, `${req.sessionId}.json`))).toBe(false);
      expect(readdirSync(configDir), "a refused start left the credential directory non-empty").toEqual([]);
      executed += 1;
    }
    expect(executed).toBe(UNQUOTABLE_TOKENS.length);
  });

  it("admits a start on the spawn event and hands back a still-pending exit", async () => {
    const { calls, spawn } = fakeSpawn(4242);
    const { configDir, made: start } = inSandbox(claudeSpawnStarter, {
      command: "claude", log: () => undefined, spawn,
    });
    const req = request();
    const pending = start(req);
    const startState = settledFlag(pending);
    const child = calls[0];
    if (child === undefined) throw new Error("nothing spawned");
    const configPath = join(configDir, `${req.sessionId}.json`);

    // Admission is NOT the synchronous return of spawn(): the child is alive and
    // has emitted nothing, so a start that resolved here would be guessing.
    await drainMicrotasks();
    expect(startState.settled(), "start settled before the child was admitted").toBe(false);

    child.emitter.emit("spawn");
    const started = await pending;
    if (!started.ok) throw new Error(`expected an accepted start, got ${started.code}`);

    // The child is still held open: its lifetime is a SEPARATE fact, and the
    // credential it needs is still on disk.
    const exitState = settledFlag(started.exit);
    await drainMicrotasks();
    expect(exitState.settled(), "exit settled while the child was still running").toBe(false);
    expect(existsSync(configPath)).toBe(true);

    child.emitter.emit("close", 0, null);
    await started.exit;
    expect(existsSync(configPath), "the credential outlived its agent").toBe(false);
  });

  it("rejects a pre-admission child error with the original error, never the coded refusal", async () => {
    const { calls, spawn } = fakeSpawn();
    const { configDir, made: start } = inSandbox(claudeSpawnStarter, {
      command: "claude", log: () => undefined, spawn,
    });
    const pending = start(request());
    const child = calls[0];
    if (child === undefined) throw new Error("nothing spawned");
    // Shaped like the coded refusal on purpose: a structural lookalike must not
    // be able to enter the coded arm, which only `instanceof` can decide.
    const spoof = Object.assign(new Error("ENOENT"), {
      code: "SPAWN_ARGUMENT_UNQUOTABLE",
      layer: "agent-spawn-invocation",
    });

    child.emitter.emit("error", spoof);
    await expect(pending).rejects.toBe(spoof);
    expect(readdirSync(configDir), "a denied start left the credential behind").toEqual([]);
  });

  it("rejects a synchronous spawn failure unchanged and leaves no credential", async () => {
    const boom = new Error("EACCES");
    const { configDir, made: start } = inSandbox(claudeSpawnStarter, {
      command: "claude",
      log: () => undefined,
      spawn: () => { throw boom; },
    });

    await expect(start(request())).rejects.toBe(boom);
    expect(readdirSync(configDir)).toEqual([]);
  });

  it("admits a child that spawns and exits in the same tick", async () => {
    const { calls, spawn } = fakeSpawn();
    const { configDir, made: start } = inSandbox(claudeSpawnStarter, {
      command: "claude", log: () => undefined, spawn,
    });
    const req = request();
    const pending = start(req);
    const child = calls[0];
    if (child === undefined) throw new Error("nothing spawned");

    // Back to back, with no await between them: every listener is attached in
    // the same synchronous block as process creation, so admission cannot be
    // outrun by the exit that follows it.
    child.emitter.emit("spawn");
    child.emitter.emit("close", 0, null);

    const started = await pending;
    if (!started.ok) throw new Error(`expected an accepted start, got ${started.code}`);
    await started.exit;
    expect(existsSync(join(configDir, `${req.sessionId}.json`))).toBe(false);
  });

  it("denies a start uncoded when the lifetime ends before admission", async () => {
    const { calls, spawn } = fakeSpawn();
    const { configDir, made: start } = inSandbox(claudeSpawnStarter, {
      command: "claude", log: () => undefined, spawn,
    });
    const pending = start(request());
    const child = calls[0];
    if (child === undefined) throw new Error("nothing spawned");

    // A child that dies without ever emitting `spawn` was never admitted. The
    // start must REJECT — hanging would strand the caller, and a stable code
    // would claim a refusal no layer made.
    child.emitter.emit("close", 0, null);
    await expect(pending).rejects.toThrowError("AGENT_SPAWN_NOT_ADMITTED");
    await expect(pending).rejects.not.toMatchObject({ code: "SPAWN_ARGUMENT_UNQUOTABLE" });
    expect(readdirSync(configDir)).toEqual([]);
  });

  it("keeps an admitted start accepted when the child fails afterwards", async () => {
    const { calls, spawn } = fakeSpawn();
    const { configDir, made: start } = inSandbox(claudeSpawnStarter, {
      command: "claude", log: () => undefined, spawn,
    });
    const req = request();
    const pending = start(req);
    const child = calls[0];
    if (child === undefined) throw new Error("nothing spawned");

    child.emitter.emit("spawn");
    const started = await pending;
    if (!started.ok) throw new Error(`expected an accepted start, got ${started.code}`);

    // A post-admission failure settles the LIFETIME. It cannot retroactively
    // turn an observed admission into a refusal.
    child.emitter.emit("error", new Error("died later"));
    await expect(started.exit).rejects.toMatchObject({ code: "AGENT_PROCESS_FAILED" });
    expect(started.ok).toBe(true);
    expect(existsSync(join(configDir, `${req.sessionId}.json`))).toBe(false);
  });
});

/**
 * The seat output TEE.
 *
 * The wrapper's console is the operator's only view of a running seat, so teeing
 * must be additive: the same bytes still reach the console, and a bounded copy is
 * retained so the exit can be READ (a provider announces a limit in its output,
 * never in its exit code).
 *
 * LIMIT_LINE is copied verbatim from child 1's committed fixture
 * (seat-exit-classifier.test.ts, CLAUDE_SESSION_LIMIT) — never retyped from memory.
 * `·` is the MIDDLE DOT the claude CLI composes with.
 */
const LIMIT_LINE = "You've hit your session limit · resets 12:10am Asia/Jerusalem";

/** A sink that keeps every Buffer it was handed, so byte identity can be proven. */
function collectingSink(): { chunks: Buffer[]; sink: PassThrough } {
  const chunks: Buffer[] = [];
  const sink = new PassThrough();
  sink.on("data", (chunk: Buffer) => { chunks.push(Buffer.from(chunk)); });
  return { chunks, sink };
}

describe("seat output tee", () => {
  const teedStart = (): {
    calls: FakeChild[];
    errChunks: Buffer[];
    outChunks: Buffer[];
    start: AgentSpawnStart;
  } => {
    const { calls, spawn } = fakeSpawn(7311);
    const { chunks: outChunks, sink: stdout } = collectingSink();
    const { chunks: errChunks, sink: stderr } = collectingSink();
    const { made: start } = inSandbox(claudeSpawnStarter, {
      command: "claude",
      log: () => undefined,
      output: { stderr, stdout },
      platform: "linux",
      spawn,
    });
    return { calls, errChunks, outChunks, start };
  };

  const admit = async (start: AgentSpawnStart, calls: FakeChild[]): Promise<{
    child: FakeChild;
    exit: Promise<unknown>;
  }> => {
    const pending = start(request());
    const child = calls[0];
    if (child === undefined) throw new Error("nothing spawned");
    child.emitter.emit("spawn");
    const started = await pending;
    if (!started.ok) throw new Error(`expected an accepted start, got ${started.code}`);
    return { child, exit: started.exit };
  };

  it("forwards the seat's bytes unchanged and carries the tail on a nonzero exit", async () => {
    const { calls, errChunks, outChunks, start } = teedStart();
    const { child, exit } = await admit(start, calls);
    // The lifetime rejects; nothing may observe it as an unhandled rejection.
    const settled = exit.then(() => null, (error: unknown) => error);

    child.stdout.write(Buffer.from("hello\n"));
    child.stderr.write(Buffer.from(`${LIMIT_LINE}\n`));
    await drainMicrotasks();
    child.emitter.emit("close", 1, null);

    const error = await settled;
    expect(error).toMatchObject({
      code: "AGENT_PROCESS_FAILED",
      exitCode: 1,
      message: "AGENT_PROCESS_FAILED:EXIT_NONZERO:1",
      reason: "EXIT_NONZERO",
      tail: ["hello", LIMIT_LINE],
    });
    // BYTE equality, not string equality: the operator's console is unchanged.
    expect(Buffer.concat(outChunks).equals(Buffer.from("hello\n"))).toBe(true);
    expect(Buffer.concat(errChunks).equals(Buffer.from(`${LIMIT_LINE}\n`))).toBe(true);
  });

  it("resolves a clean exit with the seat report and the same tail", async () => {
    const { calls, errChunks, outChunks, start } = teedStart();
    const { child, exit } = await admit(start, calls);

    child.stdout.write(Buffer.from("hello\n"));
    child.stderr.write(Buffer.from(`${LIMIT_LINE}\n`));
    await drainMicrotasks();
    child.emitter.emit("close", 0, null);

    expect(await exit).toEqual({ exitCode: 0, signal: null, tail: ["hello", LIMIT_LINE] });
    expect(Buffer.concat(outChunks).equals(Buffer.from("hello\n"))).toBe(true);
    expect(Buffer.concat(errChunks).equals(Buffer.from(`${LIMIT_LINE}\n`))).toBe(true);
  });

  it("forwards the RAW buffer, so a character split across two chunks survives", async () => {
    const { calls, outChunks, start } = teedStart();
    const { child, exit } = await admit(start, calls);
    // U+20AC EURO SIGN is 3 UTF-8 bytes; a per-chunk toString() would decode each
    // half separately and emit U+FFFD twice, corrupting the console AND the tail.
    const head = Buffer.from([0xE2, 0x82]);
    const rest = Buffer.from([0xAC, 0x0A]);

    child.stdout.write(head);
    child.stdout.write(rest);
    await drainMicrotasks();
    child.emitter.emit("close", 0, null);

    const report = await exit as { readonly tail: readonly string[] };
    expect(Buffer.concat(outChunks).equals(Buffer.concat([head, rest]))).toBe(true);
    expect(report.tail).toEqual(["€"]);
  });
});
