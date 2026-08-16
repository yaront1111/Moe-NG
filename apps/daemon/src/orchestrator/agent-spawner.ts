import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 as windowsPath } from "node:path";
import { fileURLToPath } from "node:url";

import { agentSpawnInvocation } from "./agent-spawn-invocation.js";
import type { SpawnRequest } from "./agent-wrapper.js";

/**
 * Spawns one `claude -p` process per staffed work item, wired to the moe-next
 * MCP server through a per-agent config file. That file points at the trusted
 * loopback HTTP host and carries only the agent's scoped bearer — never the
 * operator credential, store path, argv, or mission text — and is removed the
 * moment the agent exits.
 */
const DAEMON_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** Everything the spawner touches outside its own arguments, injectable for tests. */
export interface AgentSpawnerOptions {
  readonly command?: string;
  /** Injectable parent environment; every MOE_* authority variable is stripped from the child. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Injectable POSIX negative-pid signal boundary. */
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  /** Maximum wait for process close after requesting tree termination. */
  readonly killGraceMs?: number;
  readonly log?: (line: string) => void;
  /** Fatal containment failures halt the owning runtime; they are never ordinary agent exits. */
  readonly onFatalContainment?: ((error: AgentProcessContainmentError) => void) | undefined;
  readonly spawn?: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** Hard lifetime for one agent process; a hung agent is killed and its slot freed. */
  readonly timeoutMs?: number;
  /** Platform override for the kill strategy (win32 needs a tree kill). */
  readonly platform?: NodeJS.Platform;
}

export type AgentProcessContainmentReason =
  | "CLOSE_NOT_OBSERVED"
  | "PID_UNAVAILABLE"
  | "TREE_KILL_FAILED";

export class AgentProcessContainmentError extends Error {
  readonly code = "AGENT_PROCESS_CONTAINMENT_FAILED";
  readonly reason: AgentProcessContainmentReason;

  constructor(reason: AgentProcessContainmentReason) {
    super(`AGENT_PROCESS_CONTAINMENT_FAILED:${reason}`);
    this.name = "AgentProcessContainmentError";
    this.reason = reason;
  }
}

export type AgentProcessFailureReason = "EXIT_NONZERO" | "EXIT_SIGNAL" | "SPAWN_ERROR";

export class AgentProcessFailureError extends Error {
  readonly code = "AGENT_PROCESS_FAILED";
  constructor(readonly reason: AgentProcessFailureReason, readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null) {
    super(`AGENT_PROCESS_FAILED:${reason}${exitCode !== null ? `:${String(exitCode)}`
      : signal !== null ? `:${signal}` : ""}`);
    this.name = "AgentProcessFailureError";
  }
}

/** Callable spawn boundary plus explicit ownership of every process it starts. */
export interface AgentSpawner {
  (request: SpawnRequest): Promise<void>;
  readonly activeCount: () => number;
  readonly close: () => Promise<void>;
}

/** Default agent lifetime: the claim TTL, so a hung agent frees its slot no later
 *  than its claim's reap horizon rather than holding a maxAgents slot forever. */
const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const CONFIG_DIRS = new Set<string>();
process.once("exit", () => {
  for (const path of CONFIG_DIRS) rmSync(path, { force: true, recursive: true });
});

const CHAIN_TOOLS = "mcp__moe-next,mcp__moe-next__*";
const CODING_TOOLS = `${CHAIN_TOOLS},Edit,Write,Read,Glob,Grep,Bash`;
const CODING_BUILTIN_TOOLS = "Edit,Write,Read,Glob,Grep,Bash";

const RUNTIME_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  "ALL_PROXY", "APPDATA", "COLORTERM", "COMSPEC", "FORCE_COLOR", "HOMEDRIVE",
  "HOMEPATH", "HOME", "HTTP_PROXY", "HTTPS_PROXY", "LANG", "LC_ALL", "LOCALAPPDATA",
  "NODE_EXTRA_CA_CERTS", "NO_COLOR", "PATH", "PATHEXT", "PROGRAMDATA", "SHELL",
  "SSL_CERT_DIR", "SSL_CERT_FILE", "SYSTEMROOT", "TEMP", "TERM", "TMP", "TMPDIR",
  "USERPROFILE", "WINDIR",
]);
const PROVIDER_ENVIRONMENT_PREFIXES = Object.freeze([
  "ANTHROPIC_", "AWS_", "AZURE_", "CLAUDE_", "GOOGLE_", "VERTEX_",
] as const);
const LOOPBACK_NO_PROXY = Object.freeze(["127.0.0.1", "localhost", "::1"] as const);

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);

function trustedMcpOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("MCP_HTTP_ORIGIN_INVALID");
  }
  if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname)
    || parsed.username !== "" || parsed.password !== "" || parsed.origin !== value) {
    throw new Error("MCP_HTTP_ORIGIN_INVALID");
  }
  return parsed.origin;
}

function agentEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toUpperCase();
    if (normalized.startsWith("MOE_") || value === undefined) continue;
    if (RUNTIME_ENVIRONMENT_KEYS.has(normalized)
      || PROVIDER_ENVIRONMENT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
      environment[key] = value;
    }
  }
  // Claude keeps provider credentials for its own API call but strips them
  // from Bash, hooks and subprocess MCP servers. Scripted sessions also leave
  // no resumable transcript containing mission or tool output.
  environment["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"] = "1";
  environment["CLAUDE_CODE_SKIP_PROMPT_HISTORY"] = "1";
  // Claude honors standard proxy variables. Force its loopback MCP connection
  // around any enterprise proxy so the scoped bearer never leaves this host.
  const bypass = [source["NO_PROXY"], source["no_proxy"]]
    .flatMap((value) => value?.split(/[\s,]+/u) ?? [])
    .filter((value, index, values) => value !== "" && values.indexOf(value) === index);
  for (const host of LOOPBACK_NO_PROXY) {
    if (!bypass.includes(host)) bypass.push(host);
  }
  environment["NO_PROXY"] = bypass.join(",");
  environment["no_proxy"] = bypass.join(",");
  return environment;
}

export function claudeSpawner(
  mcpOrigin: string,
  options: AgentSpawnerOptions = {},
): AgentSpawner {
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
  // `async` makes every invocation refusal a rejection rather than escaping the poll tick.
  const spawnAgent = async (request: SpawnRequest): Promise<void> => {
    if (closed) throw new Error("AGENT_SPAWNER_CLOSED");
    const mcpConfigPath = join(configDir, `${request.sessionId}.json`);
    // Code-node agents get coding tools; chain-step agents keep the MCP-only surface.
    const coding = request.workspace !== null;
    // Build before writing the credential: Windows shell quoting can refuse the invocation.
    const invocation = agentSpawnInvocation(command, [
      "-p",
      "--bare",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--mcp-config", mcpConfigPath,
      "--tools", coding ? CODING_BUILTIN_TOOLS : "",
      "--allowedTools", coding ? CODING_TOOLS : CHAIN_TOOLS,
    ], platform);
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
      timer = setTimeout(() => {
        log(`[wrapper] ${request.workItemId} agent exceeded ${String(timeoutMs)}ms; killing`);
        beginTermination();
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      child.on("close", (code, signal) => {
        log(`[wrapper] ${request.workItemId} agent exited ${String(code)}`);
        childClosed = true;
        if (terminating) maybeFinishTermination();
        else if (code === 0) finish();
        else failProcess(code === null ? "EXIT_SIGNAL" : "EXIT_NONZERO", code, signal);
      });
      child.on("error", () => {
        if (settled || terminating) return;
        // A missing pid proves no owned process exists; otherwise contain its tree.
        if (child.pid === undefined) failProcess("SPAWN_ERROR", null, null);
        else beginTermination();
      });
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
    return done;
  };

  const callable = spawnAgent as AgentSpawner;
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
}
