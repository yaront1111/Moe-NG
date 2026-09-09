#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describeLaunchVariables, resolveLaunchEnv } from "./moe-up-env.js";
import type { FileExists } from "./moe-up-env.js";
import {
  NODE_TRANSFORM_TYPES_FLAG, controlRoomAssetRoot, createProcessSpawn, launchEntryPaths,
} from "./moe-up-spawn.js";
import type { LaunchChildProcess, LaunchEntryPaths, LaunchSpawn } from "./moe-up-spawn.js";
import { WRAPPER_STDIN_STOP_TOKEN } from "./process-runner-lifecycle.js";
import { consumePairingOperatorLines } from "../http/pairing-operator-channel.js";
import type { CancellablePairingOperatorInput } from "../http/pairing-operator-channel.js";

/**
 * `moe up`: the one command that starts the whole development stack.
 *
 * It composes the two existing entries — the daemon and the agent wrapper — as
 * child processes and owns nothing else. Neither entry is modified, and neither
 * learns it is being supervised.
 *
 * WINDOWS: an external `SIGTERM` never reaches a Node handler here, so it is not
 * a teardown trigger this launcher can rely on. The two triggers that DO fire on
 * Windows are console Ctrl-C (delivered as SIGINT to the whole console process
 * group) and a child exiting; both cascade into `stopEverything` below. Killing
 * the wrapper is NOT enough for its `claude` grandchildren: libuv's implicit job
 * covers only the `cmd.exe` shim, and the seat process breaks away from it. The
 * wrapper's own exit path (`shutdownWrapperRuntime` -> `taskkill /T` per seat
 * tree) is what retires them, so the launcher asks the wrapper to stop over its
 * stdin first and terminates it only after a grace.
 */

export const MOE_UP_DAEMON_EXITED_BEFORE_LISTENING
  = "MOE_UP_DAEMON_EXITED_BEFORE_LISTENING" as const;
export const MOE_UP_DAEMON_ORIGIN_TIMEOUT = "MOE_UP_DAEMON_ORIGIN_TIMEOUT" as const;
export const MOE_UP_STORE_DIR_UNWRITABLE = "MOE_UP_STORE_DIR_UNWRITABLE" as const;
export const MOE_UP_WRAPPER_START_FAILED = "MOE_UP_WRAPPER_START_FAILED" as const;

/** The daemon announces one canonical IPv4-loopback origin; no URL component may follow it. */
const ORIGIN_LINE = /^listening on (?<origin>http:\/\/127\.0\.0\.1:(?<port>[1-9][0-9]{0,4}))\r?$/mu;
const SENSITIVE_DAEMON_LINE = /(?:pair(?:ing)?[-_ ]?(?:token|ticket)|#(?:pair|manager)=|(?:pairing[-_ ]?)?request[-_ ]?id|confirmation[-_ ]?label|(?:session[-_ ]?)?credential)/iu;
// The private channel yields printable ASCII only, so trim/lowercase have no Unicode ambiguity.
const CONFIRMATION_LABEL = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u;
const DEFAULT_ORIGIN_TIMEOUT_MS = 60_000;
const CHILD_OUTPUT_MAX_LINE_CHARS = 16 * 1_024;

function plainLoopbackOrigin(text: string): string | null {
  const match = ORIGIN_LINE.exec(text);
  const origin = match?.groups?.["origin"];
  const port = Number(match?.groups?.["port"]);
  return origin !== undefined && Number.isInteger(port) && port >= 1 && port <= 65_535
    ? origin : null;
}

function suppressDaemonLine(line: string): boolean {
  return SENSITIVE_DAEMON_LINE.test(line)
    || (line.startsWith("listening on ") && plainLoopbackOrigin(line) === null);
}

export interface MoeUpOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The sign-in lookup; injected so a test never reads the host's home directory. */
  readonly fileExists?: FileExists;
  readonly log: (line: string) => void;
  /** Registers the console interrupt handler; injected so a test can fire it. */
  readonly onSignal: (handler: () => void) => void;
  readonly originTimeoutMs?: number;
  /** Present only for an interactive foreground operator; absence fails closed. */
  readonly operatorInput?: CancellablePairingOperatorInput | undefined;
  readonly randomHex?: (bytes: number) => string;
  readonly repoRoot: string;
  readonly spawn: LaunchSpawn;
  /** How long the wrapper gets to retire its seats after the stop line before it is killed. */
  readonly wrapperStopGraceMs?: number;
}

/** Mirrors a child's output onto ours, and offers each line to a watcher. */
function pipeOutput(
  child: LaunchChildProcess, label: string, log: (line: string) => void,
  watch?: (chunk: string) => void,
  suppress?: (line: string) => boolean,
): void {
  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    let discarding = false;
    const emit = (raw: string): void => {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line === "") return;
      watch?.(line);
      if (!suppress?.(line)) log(`[${label}] ${line}`);
    };
    stream?.on("data", (chunk) => {
      const text = chunk.toString();
      let offset = 0;
      while (offset < text.length) {
        const newline = text.indexOf("\n", offset);
        const terminated = newline !== -1;
        const end = terminated ? newline : text.length;
        const segment = text.slice(offset, end);
        if (!discarding) {
          if (pending.length + segment.length <= CHILD_OUTPUT_MAX_LINE_CHARS) {
            pending += segment;
          } else {
            pending = "";
            discarding = true;
          }
        }
        if (terminated) {
          if (!discarding) emit(pending);
          pending = "";
          discarding = false;
          offset = newline + 1;
        } else {
          offset = text.length;
        }
      }
    });
    (stream as null | { on(event: "end", listener: () => void): unknown })
      ?.on("end", () => {
        if (!discarding) emit(pending);
        pending = "";
        discarding = false;
      });
  }
}

/** The sole startup datum admitted from daemon stdout. */
interface DaemonSignals { readonly origin: string; }

interface OriginWatch {
  readonly settle: (value: DaemonSignals | null) => void;
  readonly signals: Promise<DaemonSignals | null>;
}

function watchForOrigin(): OriginWatch {
  let settle!: (value: DaemonSignals | null) => void;
  const signals = new Promise<DaemonSignals | null>((resolve) => {
    let done = false;
    settle = (value): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
  });
  return { settle, signals };
}

/** The line the wrapper reads on its stdin as "stop": its stop signal treats it like Ctrl-C. */
export const WRAPPER_STOP_TOKEN = WRAPPER_STDIN_STOP_TOKEN;
/** How long a wrapper gets to retire its seats before the launcher hard-kills it. */
export const WRAPPER_STOP_GRACE_MS = 10_000;

interface TrackOptions {
  /** Written to the child's stdin on stop; the kill follows only after the grace. */
  readonly stopToken?: string;
}

interface Fleet {
  /** Did a child exit? Distinguishes a crashed daemon from a merely silent one. */
  readonly childExited: () => boolean;
  readonly firstFailure: () => number | null;
  readonly stopEverything: () => void;
  readonly track: (child: LaunchChildProcess, options?: TrackOptions) => Promise<void>;
}

/**
 * The teardown cascade. One latch for every trigger: a second Ctrl-C during an
 * in-flight stop must not double-kill, and a child that is already gone must not
 * be signalled again.
 *
 * A child tracked with a `stopToken` is asked first and killed later: `child.kill()` on
 * Windows is TerminateProcess, which gives the wrapper no chance to run its exit path
 * (`shutdownWrapperRuntime` -> `agentSpawner.close()` -> `taskkill /T` per seat tree). Killing
 * it outright left every `claude` seat alive with its claim and session, fencing its item at the
 * next boot. The token reaches the wrapper's own stop signal; only a wrapper that has not
 * exited within the grace is terminated. The daemon carries no token and is killed as before.
 */
function createFleet(onStop: () => void, graceMs: number = WRAPPER_STOP_GRACE_MS): Fleet {
  const alive = new Map<LaunchChildProcess, TrackOptions>();
  let failure: number | null = null;
  let exited = false;
  let stopping = false;

  const stopEverything = (): void => {
    if (stopping) return;
    stopping = true;
    onStop();
    for (const [child, options] of alive) {
      const token = options.stopToken;
      let asked = false;
      if (token !== undefined && child.stdin !== null && child.stdin !== undefined) {
        try {
          child.stdin.write(`${token}\n`);
          asked = true;
        } catch { /* a closed pipe: fall back to the kill below */ }
      }
      if (!asked) {
        child.kill();
        continue;
      }
      const timer = setTimeout(() => {
        if (alive.has(child)) child.kill();
      }, graceMs);
      timer.unref();
    }
  };

  const track = async (child: LaunchChildProcess, options: TrackOptions = {}): Promise<void> => {
    alive.set(child, options);
    await new Promise<void>((resolve) => {
      child.once("exit", (code) => {
        alive.delete(child);
        exited = true;
        if (failure === null && code !== null && code !== 0) failure = code;
        stopEverything();
        resolve();
      });
    });
  };

  return {
    childExited: (): boolean => exited,
    firstFailure: (): number | null => failure,
    stopEverything,
    track,
  };
}

function startDaemonChild(
  options: MoeUpOptions, paths: LaunchEntryPaths,
  childEnv: Readonly<Record<string, string | undefined>>, watch: OriginWatch,
  assetRoot: string | null,
): LaunchChildProcess {
  // No --port: `daemon-main` deliberately binds an ephemeral port, and a fixed
  // one is exactly how a second stack collides with a live transport.
  // `--asset-root` ONLY when a built bundle was found: absent, the daemon hosts
  // nothing and behaves exactly as it did before the static host existed. The
  // daemon still proves the root itself (a bundle, and no baked-in secret) and
  // refuses to start otherwise; this launcher only decides whether to ask.
  const child = options.spawn(
    process.execPath,
    [
      NODE_TRANSFORM_TYPES_FLAG, paths.daemonEntry, `--dependencies=${paths.dependencies}`,
      ...(assetRoot === null ? [] : [`--asset-root=${assetRoot}`]),
      ...(options.operatorInput === undefined ? [] : ["--operator-stdin"]),
    ],
    { cwd: options.repoRoot, env: childEnv },
  );
  // A child can close its pipe just before its exit event reaches the fleet.
  // An EPIPE in that window is a refused approval, not an uncaught launcher error.
  child.stdin?.on?.("error", () => undefined);
  // `pipeOutput` reconstructs split lines inside a fixed bound, then releases
  // each one. No daemon-controlled pre-origin accumulator grows with uptime.
  pipeOutput(child, "daemon", options.log, (line) => {
    const origin = plainLoopbackOrigin(line);
    if (origin === null) return;
    watch.settle({ origin });
  }, suppressDaemonLine);
  return child;
}

/**
 * The first line is read by the packaged smoke (`tools/packaging/
 * smoke-windows-artifact.ps1`) and its wording is fixed. After it, ONE story:
 * with a hosted bundle the operator opens the daemon's own origin - the literal
 * loopback IP the daemon printed, because its Host check refuses `localhost` -
 * with a browser-requested, operator-confirmed session handshake; without a bundle, an honest
 * build-and-restart instruction because v2 cannot pair to an unhosted daemon. The plain origin
 * is printed for manual open and is never handed to a browser process by this launcher.
 */
function announce(
  signals: DaemonSignals,
  assetRoot: string | null,
  log: (line: string) => void,
): void {
  log(`moe up: daemon listening on ${signals.origin}`);
  if (assetRoot === null) {
    log("moe up: control room unavailable - no built bundle is hosted");
    log("moe up: ctrl-c, run pnpm --filter @moe/control-room build, then restart pnpm start");
    return;
  }
  log(`moe up: control room -> open ${signals.origin} (hosted by the daemon from ${assetRoot})`);
  log("moe up: ctrl-c here stops both children");
}

export async function runMoeUp(options: MoeUpOptions): Promise<number> {
  const resolution = resolveLaunchEnv({
    env: options.env,
    ...(options.fileExists === undefined ? {} : { fileExists: options.fileExists }),
    ...(options.randomHex === undefined ? {} : { randomHex: options.randomHex }),
    repoRoot: options.repoRoot,
  });
  if (!resolution.ok) {
    // Named per variable, and BEFORE any process exists: a launcher that spawns
    // first and refuses second leaves the operator a half-started stack.
    for (const refusal of resolution.refusals) options.log(refusal.message);
    return 1;
  }
  options.log("moe up: launching with");
  for (const line of describeLaunchVariables(resolution.variables)) options.log(line);
  try {
    mkdirSync(dirname(resolution.storePath), { recursive: true });
  } catch (error) {
    // A crash is not a refusal. An unwritable store directory is an operator
    // fault with an obvious fix, so it earns a code and a clean exit rather than
    // a raw ENOTDIR stack out of a launcher that has spawned nothing yet.
    options.log(`${MOE_UP_STORE_DIR_UNWRITABLE}: ${(error as Error).message}`);
    return 1;
  }

  const paths = launchEntryPaths(options.repoRoot);
  // Decided ONCE, here, so the argv the daemon gets and the lines the operator
  // reads cannot disagree about whether a bundle is hosted.
  const assetRoot = controlRoomAssetRoot(options.repoRoot);
  const childEnv = { ...options.env, ...resolution.env };
  const watch = watchForOrigin();
  const operatorAbort = new AbortController();
  const fleet = createFleet(() => {
    operatorAbort.abort();
    watch.settle(null);
  }, options.wrapperStopGraceMs);
  options.onSignal(() => { fleet.stopEverything(); });

  const daemonChild = startDaemonChild(options, paths, childEnv, watch, assetRoot);
  const daemonExit = fleet.track(daemonChild);
  let operatorConsumption: Promise<void> = Promise.resolve();
  if (options.operatorInput !== undefined && daemonChild.stdin !== null
    && daemonChild.stdin !== undefined) {
    operatorConsumption = consumePairingOperatorLines(options.operatorInput, (line) => {
      const label = line.trim().toLowerCase();
      if (!operatorAbort.signal.aborted && CONFIRMATION_LABEL.test(label)) {
        try {
          daemonChild.stdin?.write(`${label}\n`, () => undefined);
        } catch {
          // A synchronously broken private handoff is permanently closed. Continuing to consume
          // could let a later label cross a pipe that recovered after the first failed write.
          operatorAbort.abort();
        }
      }
    }, { signal: operatorAbort.signal });
  }
  const timeoutMs = options.originTimeoutMs ?? DEFAULT_ORIGIN_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => { resolve(null); }, timeoutMs);
  });
  const signals = await Promise.race([watch.signals, timedOut]);
  clearTimeout(timer);

  if (signals === null) {
    // Two different faults, reported apart: the operator fixes a daemon that
    // died and a daemon that is merely silent by reading different things.
    options.log(fleet.childExited()
      ? MOE_UP_DAEMON_EXITED_BEFORE_LISTENING
      : MOE_UP_DAEMON_ORIGIN_TIMEOUT);
    fleet.stopEverything();
    await daemonExit;
    await operatorConsumption;
    return fleet.firstFailure() ?? 1;
  }

  announce(signals, assetRoot, options.log);
  let wrapper: LaunchChildProcess;
  try {
    wrapper = options.spawn(process.execPath, [NODE_TRANSFORM_TYPES_FLAG, paths.wrapperEntry], {
      cwd: options.repoRoot, env: childEnv,
    });
  } catch (error) {
    // The daemon is ALREADY RUNNING at this point. Letting this throw would
    // leave it alive with nothing supervising it — the exact orphan the whole
    // teardown cascade exists to prevent.
    options.log(`${MOE_UP_WRAPPER_START_FAILED}: ${(error as Error).message}`);
    fleet.stopEverything();
    await daemonExit;
    await operatorConsumption;
    return fleet.firstFailure() ?? 1;
  }
  pipeOutput(wrapper, "wrapper", options.log);
  // A closed wrapper stdin is a refused stop request, not a launcher fault; the grace kill follows.
  wrapper.stdin?.on?.("error", () => undefined);
  await Promise.all([daemonExit, fleet.track(wrapper, { stopToken: WRAPPER_STOP_TOKEN })]);
  await operatorConsumption;
  return fleet.firstFailure() ?? 0;
}

const meta = import.meta as ImportMeta & { readonly main?: boolean };
if (meta.main === true) {
  const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
  process.exitCode = await runMoeUp({
    env: process.env,
    log: (line) => process.stdout.write(`${line}\n`),
    // SIGINT is the console Ctrl-C. SIGTERM is registered too because it costs
    // nothing and does fire on POSIX; on Windows it simply never arrives.
    onSignal: (handler) => {
      process.on("SIGINT", handler);
      process.on("SIGTERM", handler);
    },
    ...(process.stdin.isTTY === true ? { operatorInput: process.stdin } : {}),
    repoRoot,
    spawn: createProcessSpawn(),
  });
}
