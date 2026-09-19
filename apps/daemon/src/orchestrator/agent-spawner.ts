import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describeThrown } from "@moe/contracts";

import { agentEnvironment, codexResultSizeArgs,
  trustedMcpOrigin } from "./agent-spawn-environment.js";
import { agentRoleForWorkspace } from "./agent-role-contract.js";
import { AGENT_SPAWNER_LAYER, AgentProcessContainmentError, AgentProcessFailureError } from "./agent-spawn-contract.js";
import type { AgentProcessContainmentReason, AgentProcessFailureReason, AgentSpawnStartResult,
  AgentSpawnStarter, AgentSpawnerOptions, SeatExitReport,
  SpawnAttempt } from "./agent-spawn-contract.js";
import { agentSpawnInvocation, SpawnInvocationRefusal, SPAWN_INVOCATION_LAYER } from "./agent-spawn-invocation.js";
import { spawnSeatFor } from "./agent-provider-resolve.js";
import { createSeatLiveness, formatDuration } from "./seat-liveness.js";
import type { SeatLivenessTick } from "./seat-liveness.js";
import { createSeatOutput } from "./seat-output-tail.js";
import { spawnWindowsTreeKill } from "./seat-tree-kill.js";
import type { SpawnRequest } from "./agent-wrapper.js";

export { AgentProcessContainmentError, AgentProcessFailureError } from "./agent-spawn-contract.js";
export type { AgentProcessContainmentReason, AgentProcessFailureReason, AgentSpawnStart,
  AgentSpawnStartResult, AgentSpawnStarter, AgentSpawnerOptions } from "./agent-spawn-contract.js";

/**
 * Spawns one `claude -p` process per staffed work item, wired to the moe-next
 * MCP server through a per-agent config file. That file points at the trusted
 * loopback HTTP host and carries only the agent's scoped bearer — never the
 * operator credential, store path, argv, or mission text — and is removed the
 * moment the agent exits.
 */
const DAEMON_DIR = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The ABSOLUTE cap, mirrored in wrapper-knobs.ts (MOE_AGENT_TIMEOUT_MS). Two hours, not the
 * claim TTL it used to equal: this bounds a seat that is still ACTIVE and not finishing (a
 * tool loop that never converges, or a hung codex seat that still burns CPU). A working node's
 * verification lane runs far longer than 30 minutes (UnAI 2026-09-18: node 6 killed at exactly
 * 30 min with a tool child alive, node 5 done with 59 s to spare). Observed stillness is the
 * silence watch; a hung NON-streaming (codex) seat that still burns CPU lives until this cap.
 */
const DEFAULT_AGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/**
 * The SILENCE cap, mirrored in wrapper-knobs.ts (MOE_AGENT_SILENCE_MS): no output and no tool
 * child for a whole observed window, and for a codex seat no CPU growth either (a streaming
 * claude seat prints an event while it works). Twenty minutes clears the longest single model
 * turn seen live with room to spare, and is short of the old 30-minute cap that ended a hang.
 */
const DEFAULT_AGENT_SILENCE_MS = 20 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5_000;
/**
 * The liveness cadence: how often a LIVE seat is probed, judged for silence, and, when it has
 * printed nothing for a whole interval, reported.
 *
 * A seat used to be observed exactly once in its whole life — the lifetime `setTimeout` below,
 * 30 minutes by default. A hung seat therefore spent half an hour in total silence and then
 * produced one line saying it had timed out, which is the recorded live symptom. `outputSeen`
 * was computed on every chunk and read only at settlement, so the silence was knowable at every
 * instant and observed at none. The notice then said "0 bytes seen" for every seat's whole
 * life: a TEXT-mode `claude -p` prints nothing until it finishes (seat-liveness-probe.ts).
 */
const DEFAULT_QUIET_NOTICE_MS = 60_000;
/**
 * A lenient env read for callers that hand over no option. This is NOT the refusing site: the
 * wrapper (agent-wrapper-main.ts) reads MOE_AGENT_TIMEOUT_MS and MOE_AGENT_SILENCE_MS through
 * wrapper-knobs.ts, which refuses a malformed value BY NAME (WRAPPER_ENV_INVALID) before this
 * runtime exists, and hands the parsed numbers over as options. Only a direct caller that names
 * no option reaches this read (tests, tests/security hostile cases), and for such a caller the
 * default is the right answer to an environment it never asked to be read. Coercing here rather
 * than refusing is the pre-existing MOE_AGENT_TIMEOUT_MS shape, kept on purpose so this layer
 * cannot grow a second, drifting spelling of the knob contract.
 */
function positiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? "");
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
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
): AgentSpawnStarter {
  const trustedOrigin = trustedMcpOrigin(mcpOrigin);
  const configDir = mkdtempSync(join(tmpdir(), "moe-wrapper-"));
  CONFIG_DIRS.add(configDir);
  const spawn = options.spawn ?? nodeSpawn;
  const log = options.log ?? ((line: string): void => { process.stdout.write(`${line}\n`); });
  // A warning-level line (a broken liveness probe); the wrapper tees it at "warn", a direct
  // caller sees it beside every other line.
  const warn = options.warn ?? log;
  const timeoutMs = options.timeoutMs ?? positiveIntegerEnv("MOE_AGENT_TIMEOUT_MS", DEFAULT_AGENT_TIMEOUT_MS);
  const silenceMs = options.silenceMs ?? positiveIntegerEnv("MOE_AGENT_SILENCE_MS", DEFAULT_AGENT_SILENCE_MS);
  const platform = options.platform ?? process.platform;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  // INJECTED so the quiet notice is testable without waiting a real minute.
  const now = options.now ?? ((): number => Date.now());
  const quietNoticeMs = options.quietNoticeMs ?? DEFAULT_QUIET_NOTICE_MS;
  // THE TICK IS NOT THE NOTICE. quietNoticeMs 0 silences the notice; it must not also disarm the
  // silence kill (it did: the tick ran only when a notice was wanted). The liveness tick runs at
  // the notice cadence, or the default cadence when the notice is off, and never slower than
  // the silence threshold itself, so a kill is never late by a whole interval.
  const tickMs = Math.min(quietNoticeMs > 0 ? quietNoticeMs : DEFAULT_QUIET_NOTICE_MS,
    silenceMs > 0 ? silenceMs : Number.POSITIVE_INFINITY);
  const killProcessGroup = options.killProcessGroup ?? process.kill.bind(process);
  const active = new Set<{
    readonly done: Promise<SeatExitReport | void>;
    readonly terminate: () => void;
  }>();
  const containmentFailures: AgentProcessContainmentError[] = [];
  let closed = false;
  let closing: Promise<void> | undefined;
  // EACH SEAT's PROVIDER decides its own invocation shape, resolved per spawn from
  // the request (see agent-provider-resolve.ts). `codex exec` (measured
  // 2026-09-07 against codex-cli 0.153.4 on host Yaron-PC, superseding an earlier reading of
  // 0.151.0 — this surface is unchanged between them): the mission arrives on stdin via `-`,
  // the MCP server is a streamable-HTTP config override, and the scoped bearer travels through
  // an env var codex reads by name (`bearer_token_env_var`) — never through argv or a file.
  // `--ignore-user-config` keeps the HOST's codex config (and any MCP servers it names) out,
  // the parallel of claude's `--strict-mcp-config`; its help states auth still
  // uses CODEX_HOME. Config values carry NO DOUBLE QUOTE AND NO WHITESPACE: codex parses each
  // `-c` value as TOML and falls back to the raw literal, and that is what the cmd fence admits
  // (`UNQUOTABLE` in agent-spawn-invocation.ts refuses `"`). The roster value must be a TOML
  // SEQUENCE, so it uses single-quoted literals — agent-codex-roster.ts owns that measurement.
  // THE APPROVAL PAIR (measured 2026-09-07, codex-cli 0.153.4, host Yaron-PC, graded on whether
  // a real MCP server RECORDED a `tools/call` — the banner disagrees with argv here and grades
  // nothing). Without it `exec` defaults to `approval_policy = never` and REFUSES every MCP tool
  // call — `MCP tool call requires approval, but approval policy is never` — so no codex seat
  // could reach `work_get_context`, hence none could deliver. `approval_policy=on-request` ALONE
  // DOES NOT FIX IT: the parser accepts the key and the banner still reads `never`, because the
  // policy is discarded until a NON-INTERACTIVE reviewer is named (`user | auto_review |
  // guardian_subagent`). Narrower tiers were measured, not assumed: there is NO per-server
  // approval knob (9 `mcp_servers.<name>.*` spellings answer `unknown configuration field` under
  // `--strict-config`, which validates `-c` overrides — `enabled_tools` accepted in the same
  // sweep proves the oracle discriminates), `--ask-for-approval` is not an `exec` flag, and
  // `--approve-for-me` is this same mechanism but MUTUALLY EXCLUSIVE with `--sandbox`, so it
  // would delete the role's sandbox from this argv.
  //
  // SECURITY NOTE — THIS WIDENS THE SEAT. Under `on-request` + `auto_review` the sandbox stops
  // containing: a seat spawned `--sandbox read-only` was measured WRITING OUTSIDE ITS WORKSPACE,
  // banner still `sandbox: read-only`. The model requests escalation, `auto_review` grants it
  // with no human, and the escalated command runs unsandboxed — so `role.sandbox` below is now
  // ADVISORY. Every tier that completes an MCP call also loses containment, so this is not a
  // safe-vs-wide choice. `--ignore-user-config` still earns its place: it keeps the host's
  // config and its MCP servers off the seat, which is what stops a seat reaching the real board.
  //
  // SEPARATE codex-cli 0.153.4 BEHAVIOUR, NOT A DEFECT IN THIS FILE — the flag is passed
  // correctly, and reading "argv says workspace-write, banner says read-only" as a bug HERE is
  // the obvious inference and it is FALSE; only the controls below separate the two. Measured:
  // `--sandbox` CANNOT RAISE the mode above the `read-only` default when no config.toml supplies
  // `sandbox_mode`. Controls: bare `--sandbox workspace-write` -> workspace-write; + `--ignore-
  // user-config` -> read-only with NO error; + `--ephemeral` -> read-only (so `--ephemeral` is
  // EXONERATED); + `danger-full-access` -> honoured. `--ignore-user-config` is NOT the cause
  // either — a scratch CODEX_HOME with no config.toml downgrades identically; the host config
  // sets `sandbox_mode = "danger-full-access"`, so control one was the flag NARROWING that.
  // Moot for containment while the pair above makes the mode advisory anyway. Full table:
  // `mem:gotcha-codex-exec-approval-pair-and-the-sandbox-mode-floor`.
  const attemptSpawn = (request: SpawnRequest): SpawnAttempt => {
    // A coded refusal, never a throw: answered before any child, so the caller reverts its own
    // pre-spawn transitions (a throw here left a delivery reservation BLOCKED, 2026-09-13).
    if (closed) return Object.freeze({ ok: false as const, code: "AGENT_SPAWNER_CLOSED" as const, layer: AGENT_SPAWNER_LAYER });
    const { codex: codexSeat, command } = spawnSeatFor(request.provider, options.command);
    const mcpConfigPath = join(configDir, `${request.sessionId}.json`);
    // Code-node agents get coding tools; chain-step agents keep the MCP-only surface.
    const role = agentRoleForWorkspace(request.workspace);
    // Build before writing the credential: Windows shell quoting can refuse the invocation.
    let invocation;
    try {
      invocation = agentSpawnInvocation(command, codexSeat ? [
        "exec",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox", role.sandbox,
        // BOTH halves or neither: the policy is discarded unless a non-interactive
        // reviewer is named, and without the policy every MCP tool call is refused.
        "-c", "approval_policy=on-request",
        "-c", "approvals_reviewer=auto_review",
        "-c", `mcp_servers.moe-next.url=${trustedOrigin}`,
        "-c", `mcp_servers.moe-next.bearer_token_env_var=${CODEX_BEARER_VARIABLE}`,
        ...role.codexRosterArgs, ...codexResultSizeArgs(options.environment ?? process.env),
        "-",
      ] : [
        "-p",
        // 2.1.277 refuses stream-json under -p without --verbose; partial messages make one long
        // message speak as it is written (task-815f803d comment-7c263f1c).
        "--output-format", "stream-json", "--verbose", "--include-partial-messages",
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
        "--tools", role.builtinTools,
        "--allowedTools", role.allowedTools,
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
          // All three PIPED: the seat's output is teed below to the wrapper's own console AND
          // to a bounded tail the exit is read from.
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        rmSync(mcpConfigPath, { force: true });
        // NAMED, NOT SWALLOWED. A mistyped MOE_AGENT_COMMAND or a missing claude.cmd reached the
        // operator as `AGENT_SPAWN_FAILED:UNADMITTED` and then wedged the wrapper through its
        // halt latch, with the word ENOENT appearing nowhere. ENOENT (not installed), EACCES
        // (not executable) and EMFILE (out of handles) are three different repairs.
        const facts = describeThrown(error);
        log(`[wrapper] ${request.workItemId} spawn failed: ${facts.code ?? facts.name}`
          + ` ${invocation.file} (cwd ${String(request.workspace ?? DAEMON_DIR)}): ${facts.message}`);
        denyStart(error);
        reject(error);
        return;
      }
      childPid = child.pid;
      // Output, tool children and (codex only) CPU growth feed one account of when the seat was
      // last seen doing anything; the silence kill below reads it, the absolute cap ignores it.
      const startedAt = now();
      const liveness = createSeatLiveness({ now, pid: child.pid, probe: options.probeActivity, streaming: !codexSeat });
      // Attached in the SAME TICK as the spawn: a chunk emitted before a listener exists is lost,
      // and an unread pipe eventually blocks the child. Every raw byte is activity; the console
      // and the tail get what a text-mode seat printed (seat-output-tail.ts).
      const output = createSeatOutput({ onBytes: liveness.noteOutput,
        sinks: options.output ?? { stderr: process.stderr, stdout: process.stdout }, streamJson: !codexSeat });
      child.stdout?.on("data", output.stdout);
      child.stderr?.on("data", output.stderr);
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
      let quietTimer: ReturnType<typeof setInterval> | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        if (quietTimer !== undefined) clearInterval(quietTimer);
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
        resolve({
          exitCode: lastClose.code, outputSeen: output.seen(), signal: lastClose.signal, tail: output.tail(),
          // `terminating` is set by beginTermination alone, from its four callers below: the
          // lifetime timer, failInput (an stdin error or a throwing write), a child `error`
          // event after a pid was assigned, and close() through terminateOwned.
          terminatedByWrapper: terminating,
        });
      };
      const failProcess = (
        reason: AgentProcessFailureReason,
        exitCode: number | null,
        signal: NodeJS.Signals | null,
      ): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new AgentProcessFailureError(reason, exitCode, signal, output.tail(), output.seen()));
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
      const killTree = (): void => {
        if (child.pid === undefined) {
          killDirectBestEffort();
          failContainment("PID_UNAVAILABLE");
          return;
        }
        if (platform === "win32") {
          // The killer is kept so cleanup can SIGKILL and unref it; undefined means the helper
          // already reported the failure through onFailed before returning.
          killHelper = spawnWindowsTreeKill({
            childClosed: () => childClosed,
            environment: options.environment ?? process.env,
            onConfirmed: () => { treeKillConfirmed = true; maybeFinishTermination(); },
            onFailed: () => { killDirectBestEffort(); failContainment("TREE_KILL_FAILED"); },
            pid: child.pid,
            spawn,
          });
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
        // FIRST: the pipes are closed, so a report line the seat never ended is settled before
        // anything reads the output. The line names what the durable record carries: a seat
        // killed at its timeout after printing nothing must read differently from one that failed.
        output.close();
        log(`[wrapper] ${request.workItemId} agent exited ${String(code)}`
          + ` (signal ${signal ?? "none"}, output ${output.seen() ? "seen" : "none"}`
          + `, ${terminating ? "terminated by wrapper" : "closed on its own"})`);
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
      // THE ABSOLUTE CAP fires whatever the seat is doing; the line says so, and says what it was
      // doing, so a kill of a working seat reads differently from a kill of a hung one.
      timer = setTimeout(() => {
        log(`[wrapper] ${request.workItemId} agent exceeded ${String(timeoutMs)}ms; killing:`
          + ` absolute cap ${formatDuration(timeoutMs)} reached (last activity: ${liveness.lastActivity()})`);
        beginTermination();
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      // THE LIVENESS TICK: one probe, one silence verdict, and (when warranted) one notice. The
      // tick runs synchronously when the probe answers synchronously, so a fake clock drives it.
      let probeFailureWarned = false;
      const judge = (tick: SeatLivenessTick): void => {
        // A seat already being terminated is judged no further: one kill, one line.
        if (settled || terminating) return;
        const age = now() - startedAt;
        // A broken probe (PowerShell timing out, WMI down, `ps` missing) cannot see the tree, so
        // those ticks count no silence; only the absolute cap can kill until a tick sees it again.
        // Say so ONCE, at warning, on the first failed tick, while the seat is still alive.
        if (tick.probeFailure !== undefined && !probeFailureWarned) {
          probeFailureWarned = true;
          warn(`[wrapper] ${request.workItemId} liveness probe failed: ${tick.probeFailure};`
            + " the tree is unobserved, so no silence is counted until the probe sees it again, and until then only"
            + ` the absolute cap (${formatDuration(timeoutMs)}) can kill this seat`);
        }
        if (silenceMs > 0 && tick.silentMs >= silenceMs) {
          log(`[wrapper] ${request.workItemId} killing: silent ${formatDuration(tick.silentMs)}`
            + ` (${liveness.stillness()}); absolute cap ${formatDuration(timeoutMs)} not reached`
            + ` (age ${formatDuration(age)})`);
          beginTermination();
          return;
        }
        // Only when a notice was asked for, and only when the seat has actually printed nothing
        // for a whole interval. A seat producing output says nothing here, so these lines mean
        // exactly one thing when they do appear.
        if (quietNoticeMs <= 0 || tick.quietMs < quietNoticeMs) return;
        log(`[wrapper] ${request.workItemId} seat quiet: ${String(tick.quietMs)}ms since last output`
          + ` (age ${String(age)}ms, ${String(Math.max(0, silenceMs - tick.silentMs))}ms to silence kill,`
          + ` ${String(timeoutMs - age)}ms to absolute cap, pid ${String(child.pid ?? "none")};`
          + ` ${tick.detail})`);
      };
      let probing = false;
      if (Number.isFinite(tickMs)) {
        quietTimer = setInterval(() => {
          if (probing || settled) return;
          const outcome = liveness.tick();
          if (!(outcome instanceof Promise)) { judge(outcome); return; }
          probing = true;
          void outcome.then((tick) => { probing = false; judge(tick); });
        }, tickMs);
        if (typeof quietTimer.unref === "function") quietTimer.unref();
      }
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

  return own(startAgent as AgentSpawnStarter);
}

/** The admission-shaped boundary: a coded refusal, or a start with a separate exit. */
export function claudeSpawnStarter(
  mcpOrigin: string,
  options: AgentSpawnerOptions = {},
): AgentSpawnStarter {
  return spawnRuntime(mcpOrigin, options);
}
