#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describeLaunchVariables, resolveLaunchEnv } from "./moe-up-env.js";
import {
  NODE_TRANSFORM_TYPES_FLAG, createProcessSpawn, launchEntryPaths,
} from "./moe-up-spawn.js";
import type { LaunchChildProcess, LaunchEntryPaths, LaunchSpawn } from "./moe-up-spawn.js";

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
 * the wrapper is enough for its `claude` grandchildren because the wrapper's own
 * spawn broker owns them through a Job object.
 */

export const MOE_UP_DAEMON_EXITED_BEFORE_LISTENING
  = "MOE_UP_DAEMON_EXITED_BEFORE_LISTENING" as const;
export const MOE_UP_DAEMON_ORIGIN_TIMEOUT = "MOE_UP_DAEMON_ORIGIN_TIMEOUT" as const;
export const MOE_UP_STORE_DIR_UNWRITABLE = "MOE_UP_STORE_DIR_UNWRITABLE" as const;
export const MOE_UP_WRAPPER_START_FAILED = "MOE_UP_WRAPPER_START_FAILED" as const;

/** The daemon announces its bound address on stdout; `daemon-entry` owns the wording. */
const ORIGIN_LINE = /^listening on (?<origin>\S+)$/mu;
const DEFAULT_ORIGIN_TIMEOUT_MS = 60_000;

export interface MoeUpOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
  /** Registers the console interrupt handler; injected so a test can fire it. */
  readonly onSignal: (handler: () => void) => void;
  readonly originTimeoutMs?: number;
  readonly randomHex?: (bytes: number) => string;
  readonly repoRoot: string;
  readonly spawn: LaunchSpawn;
}

/** Mirrors a child's output onto ours, and offers each line to a watcher. */
function pipeOutput(
  child: LaunchChildProcess, label: string, log: (line: string) => void,
  watch?: (chunk: string) => void,
): void {
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      const text = chunk.toString();
      watch?.(text);
      for (const line of text.split("\n")) if (line !== "") log(`[${label}] ${line}`);
    });
  }
}

interface OriginWatch {
  readonly origin: Promise<string | null>;
  readonly settle: (value: string | null) => void;
}

function watchForOrigin(): OriginWatch {
  let settle!: (value: string | null) => void;
  const origin = new Promise<string | null>((resolve) => {
    let done = false;
    settle = (value): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
  });
  return { origin, settle };
}

interface Fleet {
  /** Did a child exit? Distinguishes a crashed daemon from a merely silent one. */
  readonly childExited: () => boolean;
  readonly firstFailure: () => number | null;
  readonly stopEverything: () => void;
  readonly track: (child: LaunchChildProcess) => Promise<void>;
}

/**
 * The teardown cascade. One latch for every trigger: a second Ctrl-C during an
 * in-flight stop must not double-kill, and a child that is already gone must not
 * be signalled again.
 */
function createFleet(onStop: () => void): Fleet {
  const alive = new Set<LaunchChildProcess>();
  let failure: number | null = null;
  let exited = false;
  let stopping = false;

  const stopEverything = (): void => {
    if (stopping) return;
    stopping = true;
    onStop();
    for (const child of alive) child.kill();
  };

  const track = async (child: LaunchChildProcess): Promise<void> => {
    alive.add(child);
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
): LaunchChildProcess {
  // No --port: `daemon-main` deliberately binds an ephemeral port, and a fixed
  // one is exactly how a second stack collides with a live transport.
  const child = options.spawn(
    process.execPath,
    [NODE_TRANSFORM_TYPES_FLAG, paths.daemonEntry, `--dependencies=${paths.dependencies}`],
    { cwd: options.repoRoot, env: childEnv },
  );
  // Accumulated, not matched per chunk: a pipe may split the announcement line
  // anywhere, and a launcher that only checks whole chunks would then hang. The
  // buffer is released the moment the origin lands — a daemon that logs for days
  // would otherwise grow this string for the whole life of the launcher.
  let seen: string | null = "";
  pipeOutput(child, "daemon", options.log, (chunk) => {
    if (seen === null) return;
    seen += chunk;
    const found = ORIGIN_LINE.exec(seen)?.groups?.["origin"];
    if (found === undefined) return;
    seen = null;
    watch.settle(found);
  });
  return child;
}

function announce(origin: string, log: (line: string) => void): void {
  log(`moe up: daemon listening on ${origin}`);
  log(`moe up: control room -> cd apps/control-room && MOE_DAEMON_ORIGIN=${origin} pnpm dev`);
  log("moe up: then open http://localhost:5173/?live=1 — ctrl-c here stops both children");
}

export async function runMoeUp(options: MoeUpOptions): Promise<number> {
  const resolution = resolveLaunchEnv({
    env: options.env,
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
  const childEnv = { ...options.env, ...resolution.env };
  const watch = watchForOrigin();
  const fleet = createFleet(() => { watch.settle(null); });
  options.onSignal(() => { fleet.stopEverything(); });

  const daemonExit = fleet.track(startDaemonChild(options, paths, childEnv, watch));
  const timeoutMs = options.originTimeoutMs ?? DEFAULT_ORIGIN_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => { resolve(null); }, timeoutMs);
  });
  const origin = await Promise.race([watch.origin, timedOut]);
  clearTimeout(timer);

  if (origin === null) {
    // Two different faults, reported apart: the operator fixes a daemon that
    // died and a daemon that is merely silent by reading different things.
    options.log(fleet.childExited()
      ? MOE_UP_DAEMON_EXITED_BEFORE_LISTENING
      : MOE_UP_DAEMON_ORIGIN_TIMEOUT);
    fleet.stopEverything();
    await daemonExit;
    return fleet.firstFailure() ?? 1;
  }

  announce(origin, options.log);
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
    return fleet.firstFailure() ?? 1;
  }
  pipeOutput(wrapper, "wrapper", options.log);
  await Promise.all([daemonExit, fleet.track(wrapper)]);
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
    repoRoot,
    spawn: createProcessSpawn(),
  });
}
