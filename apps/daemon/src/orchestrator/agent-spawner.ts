import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 as windowsPath } from "node:path";
import { fileURLToPath } from "node:url";

import { CHAIN_TOOLS, CODING_BUILTIN_TOOLS, CODING_TOOLS, agentEnvironment,
  trustedMcpOrigin } from "./agent-spawn-environment.js";
import { AgentProcessContainmentError, AgentProcessFailureError } from "./agent-spawn-contract.js";
import type { AgentProcessContainmentReason, AgentProcessFailureReason, AgentSpawnStartResult,
  AgentSpawnStarter, AgentSpawner, AgentSpawnerOptions, SpawnAttempt } from "./agent-spawn-contract.js";
import { agentSpawnInvocation, SpawnInvocationRefusal, SPAWN_INVOCATION_LAYER } from "./agent-spawn-invocation.js";
import type { SpawnRequest } from "./agent-wrapper.js";

export { AgentProcessContainmentError, AgentProcessFailureError } from "./agent-spawn-contract.js";
export type { AgentProcessContainmentReason, AgentProcessFailureReason, AgentSpawnStart,
  AgentSpawnStartResult, AgentSpawnStarter, AgentSpawner, AgentSpawnerOptions } from "./agent-spawn-contract.js";

/**
 * Spawns one `claude -p` process per staffed work item, wired to the moe-next
 * MCP server through a per-agent config file. That file points at the trusted
 * loopback HTTP host and carries only the agent's scoped bearer — never the
 * operator credential, store path, argv, or mission text — and is removed the
 * moment the agent exits.
 */
const DAEMON_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** Default agent lifetime: the claim TTL, so a hung agent frees its slot no later
 *  than its claim's reap horizon rather than holding a maxAgents slot forever. */
const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const CONFIG_DIRS = new Set<string>();
process.once("exit", () => {
  for (const path of CONFIG_DIRS) rmSync(path, { force: true, recursive: true });
});

function spawnRuntime(
  mcpOrigin: string,
  options: AgentSpawnerOptions,
): { readonly spawner: AgentSpawner; readonly starter: AgentSpawnStarter } {
  const trustedOrigin = trustedMcpOrigin(mcpOrigin);
  const configDir = mkdtempSync(join(tmpdir(), "moe-wrapper-"));
  CONFIG_DIRS.add(configDir);
  const command = options.command ?? process.env["MOE_AGENT_COMMAND"] ?? "claude";
  const spawn = options.spawn ?? nodeSpawn;
  const log = options.log ?? ((line: string): void => { process.stdout.write(`${line}\n`); });
  const envTimeout = Number(process.env["MOE_AGENT_TIMEOUT_MS"] ?? "");
  const timeoutMs = options.timeoutMs
    ?? (Number.isSafeInteger(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_AGENT_TIMEOUT_MS);
  const platform = options.platform ?? process.platform;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const killProcessGroup = options.killProcessGroup ?? process.kill.bind(process);
  const active = new Set<{
    readonly done: Promise<void>;
    readonly terminate: () => void;
  }>();
  const containmentFailures: AgentProcessContainmentError[] = [];
  let closed = false;
  let closing: Promise<void> | undefined;
  const attemptSpawn = (request: SpawnRequest): SpawnAttempt => {
    if (closed) throw new Error("AGENT_SPAWNER_CLOSED");
    const mcpConfigPath = join(configDir, `${request.sessionId}.json`);
    // Code-node agents get coding tools; chain-step agents keep the MCP-only surface.
    const coding = request.workspace !== null;
    // Build before writing the credential: Windows shell quoting can refuse the invocation.
    let invocation;
    try {
      invocation = agentSpawnInvocation(command, [
        "-p",
        "--bare",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--mcp-config", mcpConfigPath,
        "--tools", coding ? CODING_BUILTIN_TOOLS : "",
        "--allowedTools", coding ? CODING_TOOLS : CHAIN_TOOLS,
      ], platform);
    } catch (error) {
      // ONLY the landed typed refusal owns a stable code. Anything else — an
      // unknown throw, or a structural lookalike — escapes unchanged rather than
      // being relabelled as a refusal this layer never made.
      if (!(error instanceof SpawnInvocationRefusal)) throw error;
      return Object.freeze({ ok: false as const, code: error.code, layer: SPAWN_INVOCATION_LAYER });
    }
    writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        "moe-next": {
          headers: { Authorization: `Bearer ${request.credential}` },
          type: "http",
          url: trustedOrigin,
        },
      },
    }), "utf8");
    let owned: { readonly done: Promise<void>; readonly terminate: () => void } | undefined;
    let terminateOwned: () => void = () => undefined;
    let completedBeforeRegistration = false;
    // Admission is only ever RESOLVED by the child's own `spawn` event. Every
    // settlement reached while it is still pending denies it uncoded, so a start
    // can neither hang nor acquire a stable code it did not earn.
    let admit: () => void = () => undefined;
    let denyStart: (error: unknown) => void = () => undefined;
    const admitted = new Promise<void>((resolve, reject) => {
      admit = resolve;
      denyStart = reject;
    });
    const done = new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(invocation.file, [...invocation.args], {
          cwd: request.workspace ?? DAEMON_DIR,
          detached: platform !== "win32",
          env: agentEnvironment(options.environment ?? process.env),
          shell: invocation.shell,
          stdio: ["pipe", "inherit", "inherit"],
        });
      } catch (error) {
        rmSync(mcpConfigPath, { force: true });
        denyStart(error);
        reject(error);
        return;
      }
      // The config file carries the agent's credential; it must not outlive the
      // owned process. Every settlement path removes it; a missing file is fine.
      let settled = false;
      let terminating = false;
      let childClosed = false;
      let treeKillConfirmed = false;
      let killHelper: ChildProcess | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (killHelper !== undefined) {
          try { killHelper.kill("SIGKILL"); } catch { /* already gone */ }
          try { killHelper.unref(); } catch { /* optional for injected children */ }
          killHelper = undefined;
        }
        rmSync(mcpConfigPath, { force: true });
        // Reaching any settlement with admission still pending denies it. A
        // resolved admission ignores this, so an accepted start is never rewritten.
        denyStart(new Error("AGENT_SPAWN_NOT_ADMITTED"));
        if (owned !== undefined) active.delete(owned);
        else completedBeforeRegistration = true;
      };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const failProcess = (
        reason: AgentProcessFailureReason,
        exitCode: number | null,
        signal: NodeJS.Signals | null,
      ): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new AgentProcessFailureError(reason, exitCode, signal));
      };
      const failContainment = (reason: AgentProcessContainmentReason): void => {
        if (settled) return;
        settled = true;
        const error = new AgentProcessContainmentError(reason);
        containmentFailures.push(error);
        closed = true;
        cleanup();
        try {
          options.onFatalContainment?.(error);
        } catch { /* an observer cannot replace or suppress the containment failure */ }
        reject(error);
      };
      const killDirectBestEffort = (): void => {
        try { child.kill("SIGKILL"); } catch { /* containment failure is reported separately */ }
      };
      const maybeFinishTermination = (): void => {
        if (terminating && treeKillConfirmed && childClosed) finish();
      };
      const systemRoot = (): string | null => {
        const environment = options.environment ?? process.env;
        const entry = Object.entries(environment).find(([key, value]) =>
          key.toUpperCase() === "SYSTEMROOT" && typeof value === "string" && value !== "");
        const value = entry?.[1];
        return value !== undefined && windowsPath.isAbsolute(value) ? value : null;
      };
      const killTree = (): void => {
        if (child.pid === undefined) {
          killDirectBestEffort();
          failContainment("PID_UNAVAILABLE");
          return;
        }
        if (platform === "win32") {
          const root = systemRoot();
          if (root === null) {
            killDirectBestEffort();
            failContainment("TREE_KILL_FAILED");
            return;
          }
          try {
            const killer = spawn(
              windowsPath.join(root, "System32", "taskkill.exe"),
              ["/pid", String(child.pid), "/T", "/F"],
              { stdio: "ignore", windowsHide: true },
            );
            killHelper = killer;
            try { killer.unref(); } catch { /* injected children may omit it */ }
            let killerSettled = false;
            const failKiller = (): void => {
              if (killerSettled) return;
              killerSettled = true;
              killDirectBestEffort();
              failContainment("TREE_KILL_FAILED");
            };
            killer.once("error", failKiller);
            killer.once("close", (code) => {
              if (killerSettled) return;
              killerSettled = true;
              if (code !== 0) {
                killDirectBestEffort();
                failContainment("TREE_KILL_FAILED");
                return;
              }
              treeKillConfirmed = true;
              maybeFinishTermination();
            });
          } catch {
            killDirectBestEffort();
            failContainment("TREE_KILL_FAILED");
          }
          return;
        }
        try {
          // detached:true makes the shell the group leader. An accepted
          // negative-pid SIGKILL reaches it and every ordinary descendant.
          // This is lifecycle containment, not hermetic isolation: a hostile
          // same-UID process can still escape into a new session/process group.
          killProcessGroup(-child.pid, "SIGKILL");
          treeKillConfirmed = true;
          maybeFinishTermination();
        } catch {
          killDirectBestEffort();
          failContainment("TREE_KILL_FAILED");
        }
      };
      const beginTermination = (): void => {
        if (settled || terminating) return;
        terminating = true;
        // Arm before signalling so a synchronous close can cancel this timer.
        killTimer = setTimeout(() => {
          failContainment(treeKillConfirmed ? "CLOSE_NOT_OBSERVED" : "TREE_KILL_FAILED");
        }, killGraceMs);
        if (typeof killTimer.unref === "function") killTimer.unref();
        killTree();
      };
      terminateOwned = beginTermination;
      const failInput = (): void => { beginTermination(); };
      child.on("close", (code, signal) => {
        log(`[wrapper] ${request.workItemId} agent exited ${String(code)}`);
        childClosed = true;
        if (terminating) maybeFinishTermination();
        else if (code === 0) finish();
        else failProcess(code === null ? "EXIT_SIGNAL" : "EXIT_NONZERO", code, signal);
      });
      child.on("spawn", admit);
      child.on("error", (error: unknown) => {
        // Denied FIRST, so a start that was never admitted rejects with the
        // error the runtime actually raised rather than a summary of it.
        denyStart(error);
        if (settled || terminating) return;
        // A missing pid proves no owned process exists; otherwise contain its tree.
        if (child.pid === undefined) failProcess("SPAWN_ERROR", null, null);
        else beginTermination();
      });
      timer = setTimeout(() => {
        log(`[wrapper] ${request.workItemId} agent exceeded ${String(timeoutMs)}ms; killing`);
        beginTermination();
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      // A child can exit after spawn() succeeds but before stdin is written.
      // Writable streams surface that race as an asynchronous EPIPE; without
      // a listener it escapes the promise and crashes the whole wrapper.
      child.stdin?.on("error", failInput);
      try {
        child.stdin?.write(request.mission);
        child.stdin?.end();
      } catch {
        failInput();
      }
    });
    owned = { done, terminate: terminateOwned };
    if (!completedBeforeRegistration) active.add(owned);
    return { admitted, done };
  };

  // `async` makes every refusal a rejection rather than escaping the poll tick.
  const startAgent = async (request: SpawnRequest): Promise<AgentSpawnStartResult> => {
    const attempt = attemptSpawn(request);
    if (!("admitted" in attempt)) return attempt;
    try {
      await attempt.admitted;
    } catch (error) {
      // Nothing will await a lifetime that was never admitted.
      void attempt.done.catch(() => undefined);
      throw error;
    }
    return Object.freeze({ ok: true as const, exit: attempt.done });
  };

  const runAgent = async (request: SpawnRequest): Promise<void> => {
    const attempt = attemptSpawn(request);
    // The legacy contract is the process LIFETIME, so admission is deliberately
    // not awaited here: a child that exits without ever emitting `spawn` still
    // settles exactly as this caller has always observed.
    if (!("admitted" in attempt)) throw new SpawnInvocationRefusal(attempt.code);
    void attempt.admitted.catch(() => undefined);
    return await attempt.done;
  };

  const own = <Callable extends object>(callable: Callable): Callable => {
    Object.defineProperties(callable, {
    activeCount: { value: (): number => active.size },
    close: {
      value: (): Promise<void> => {
        if (closing !== undefined) return closing;
        closed = true;
        closing = (async (): Promise<void> => {
          const current = [...active];
          for (const process of current) process.terminate();
          await Promise.allSettled(current.map((process) => process.done));
          rmSync(configDir, { force: true, recursive: true });
          CONFIG_DIRS.delete(configDir);
          if (containmentFailures.length === 1) throw containmentFailures[0];
          if (containmentFailures.length > 1) {
            throw new AggregateError(containmentFailures, "AGENT_PROCESS_CONTAINMENT_FAILED");
          }
        })();
        return closing;
      },
    },
  });
    return callable;
  };

  return {
    spawner: own(runAgent as AgentSpawner),
    starter: own(startAgent as AgentSpawnStarter),
  };
}

/** The lifetime-shaped boundary every current caller already holds. */
export function claudeSpawner(mcpOrigin: string, options: AgentSpawnerOptions = {}): AgentSpawner {
  return spawnRuntime(mcpOrigin, options).spawner;
}

/** The admission-shaped boundary: a coded refusal, or a start with a separate exit. */
export function claudeSpawnStarter(
  mcpOrigin: string,
  options: AgentSpawnerOptions = {},
): AgentSpawnStarter {
  return spawnRuntime(mcpOrigin, options).starter;
}
