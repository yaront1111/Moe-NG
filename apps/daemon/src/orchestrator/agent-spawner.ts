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
  AgentSpawnStarter, AgentSpawner, AgentSpawnerOptions, SeatExitReport,
  SpawnAttempt } from "./agent-spawn-contract.js";
import { agentSpawnInvocation, SpawnInvocationRefusal, SPAWN_INVOCATION_LAYER } from "./agent-spawn-invocation.js";
import { createOutputTail } from "./seat-output-tail.js";
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
/** The env var a codex seat reads its scoped MCP bearer from (never argv, never
 *  a file); injected per child, invisible to the claude seat's config path. */
export const CODEX_BEARER_VARIABLE = "MOE_AGENT_MCP_BEARER";
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
    readonly done: Promise<SeatExitReport | void>;
    readonly terminate: () => void;
  }>();
  const containmentFailures: AgentProcessContainmentError[] = [];
  let closed = false;
  let closing: Promise<void> | undefined;
  // The seat's PROVIDER decides the invocation shape. `codex exec` (measured
  // against codex-cli 0.151.0): the mission arrives on stdin via `-`, the MCP
  // server is a streamable-HTTP config override, and the scoped bearer travels
  // through an env var codex reads by name (`bearer_token_env_var`) — never
  // through argv or a file. `--ignore-user-config` keeps the HOST's codex
  // config (and any MCP servers it names) out, the parallel of claude's
  // `--strict-mcp-config`; its help states auth still uses CODEX_HOME.
  // Config values stay QUOTE-FREE on purpose: codex parses each `-c` value as
  // TOML and falls back to the raw literal, and a quote-free arg is what the
  // Windows cmd quoting fence admits.
  const codexSeat = /(?:^|[\\/])codex(?:\.[a-z]+)?$/iu.test(command);
  const attemptSpawn = (request: SpawnRequest): SpawnAttempt => {
    if (closed) throw new Error("AGENT_SPAWNER_CLOSED");
    const mcpConfigPath = join(configDir, `${request.sessionId}.json`);
    // Code-node agents get coding tools; chain-step agents keep the MCP-only surface.
    const coding = request.workspace !== null;
    // Build before writing the credential: Windows shell quoting can refuse the invocation.
    let invocation;
    try {
      invocation = agentSpawnInvocation(command, codexSeat ? [
        "exec",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox", coding ? "workspace-write" : "read-only",
        "-c", `mcp_servers.moe-next.url=${trustedOrigin}`,
        "-c", `mcp_servers.moe-next.bearer_token_env_var=${CODEX_BEARER_VARIABLE}`,
        "-",
      ] : [
        "-p",
        // Not `--bare`: bare mode authenticates from the environment only and
        // never reads the operator's `claude` sign-in. The isolation bare mode
        // gave is restated flag by flag — no user/project/local settings (so no
        // hooks or plugins), no skills, no session file, only the per-agent MCP
        // config. Measured 2026-09-03 on claude 2.1.x: `--setting-sources ""`
        // drops the user-settings hook a default `claude -p` injects, and a
        // child with no ANTHROPIC_* variable answers from the sign-in file.
        "--setting-sources", "",
        "--disable-slash-commands",
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
    // The codex seat carries its credential in the child's OWN environment; only
    // the claude seat needs the on-disk MCP config file.
    if (!codexSeat) {
      writeFileSync(mcpConfigPath, JSON.stringify({
        mcpServers: {
          "moe-next": {
            headers: { Authorization: `Bearer ${request.credential}` },
            type: "http",
            url: trustedOrigin,
          },
        },
      }), "utf8");
    }
    let owned: { readonly done: Promise<SeatExitReport | void>; readonly terminate: () => void }
      | undefined;
    let terminateOwned: () => void = () => undefined;
    let completedBeforeRegistration = false;
    // Captured out of the `done` executor's scope so an accepted start can report
    // the CHILD's pid to the durable staffing fence. Read only after `admitted`.
    let childPid: number | undefined;
    // Admission is only ever RESOLVED by the child's own `spawn` event. Every
    // settlement reached while it is still pending denies it uncoded, so a start
    // can neither hang nor acquire a stable code it did not earn.
    let admit: () => void = () => undefined;
    let denyStart: (error: unknown) => void = () => undefined;
    const admitted = new Promise<void>((resolve, reject) => {
      admit = resolve;
      denyStart = reject;
    });
    const done = new Promise<SeatExitReport | void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(invocation.file, [...invocation.args], {
          cwd: request.workspace ?? DAEMON_DIR,
          detached: platform !== "win32",
          env: codexSeat
            ? {
              ...agentEnvironment(options.environment ?? process.env),
              [CODEX_BEARER_VARIABLE]: request.credential,
            }
            : agentEnvironment(options.environment ?? process.env),
          shell: invocation.shell,
          // All three PIPED: the seat's output is teed below, byte for byte, to the
          // wrapper's own console AND to a bounded tail the exit is read from.
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        rmSync(mcpConfigPath, { force: true });
        denyStart(error);
        reject(error);
        return;
      }
      childPid = child.pid;
      // Attached in the SAME TICK as the spawn: a chunk emitted before a listener
      // exists is lost, and an unread pipe eventually blocks the child.
      const tail = createOutputTail();
      const sinks = options.output ?? { stderr: process.stderr, stdout: process.stdout };
      const tee = (sink: NodeJS.WritableStream) => (chunk: Buffer): void => {
        sink.write(chunk);
        tail.push(chunk);
      };
      child.stdout?.on("data", tee(sinks.stdout));
      child.stderr?.on("data", tee(sinks.stderr));
      // The config file carries the agent's credential; it must not outlive the
      // owned process. Every settlement path removes it; a missing file is fine.
      let settled = false;
      let terminating = false;
      let childClosed = false;
      /** The close facts, captured before settling so every arm reports the same exit. */
      let lastClose: { code: number | null; signal: NodeJS.Signals | null }
        = { code: null, signal: null };
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
        resolve({ exitCode: lastClose.code, signal: lastClose.signal, tail: tail.lines() });
      };
      const failProcess = (
        reason: AgentProcessFailureReason,
        exitCode: number | null,
        signal: NodeJS.Signals | null,
      ): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new AgentProcessFailureError(reason, exitCode, signal, tail.lines()));
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
              // 128 is taskkill's "no running instance": the tree is ALREADY
              // dead, which is the outcome containment exists to reach, not an
              // escape from it. A closed direct child is the same proof for any
              // other nonzero exit — an agent that dies in the same instant the
              // killer lands must not shut the whole wrapper down.
              if (code !== 0 && code !== 128 && !childClosed) {
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
        } catch (error) {
          // ESRCH means the group is already gone — the exact state the signal
          // was sent to reach — so an agent that exits as the kill lands is
          // confirmed containment, never a failure of it.
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            killDirectBestEffort();
            failContainment("TREE_KILL_FAILED");
            return;
          }
        }
        treeKillConfirmed = true;
        maybeFinishTermination();
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
        lastClose = { code, signal };
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
    return { admitted, done, pid: () => childPid };
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
    return Object.freeze({ ok: true as const, exit: attempt.done, pid: attempt.pid() });
  };

  const runAgent = async (request: SpawnRequest): Promise<void> => {
    const attempt = attemptSpawn(request);
    // The legacy contract is the process LIFETIME, so admission is deliberately
    // not awaited here: a child that exits without ever emitting `spawn` still
    // settles exactly as this caller has always observed.
    if (!("admitted" in attempt)) throw new SpawnInvocationRefusal(attempt.code);
    void attempt.admitted.catch(() => undefined);
    // The legacy contract answers VOID; the seat report the lifetime now carries is
    // handed to `startAgent`'s caller, not to this one.
    await attempt.done;
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
