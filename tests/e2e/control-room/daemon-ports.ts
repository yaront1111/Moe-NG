/**
 * The DAEMON-BACKED lane: a real daemon, the real demo seed, and the real
 * control-room dev server, started in that order and torn down on every exit path.
 *
 * HOW THIS DIFFERS FROM `harness.ts`/`static-ports.ts`. That pair builds the
 * bundle and serves COMMITTED FIXTURES with no daemon attached. This module
 * attaches one: `apps/daemon/src/daemon-main.ts` on an EPHEMERAL port,
 * `apps/daemon/src/orchestrator/demo-seed-main.ts` driving the J1 bootstrap chain
 * over that daemon's own HTTP surface, and the Vite dev server whose proxy carries
 * the five control-room routes to it. Nothing is reimplemented: the seed is the
 * shipped seed and the daemon is the shipped daemon, so what the browser reads is
 * the daemon's own answer and not a fixture standing in for one.
 *
 * REASON CODES ARE THIS MODULE'S OWN, mirroring `harness.ts`'s frozen tuple. A
 * child that never announces itself fails with a code naming WHICH child, because
 * "the journey timed out" is the one report an operator cannot act on. Process
 * mechanics live in `daemon-children.ts`; scratch identities in `daemon-scratch.ts`.
 */
import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

import { freePort, killTree, spawnNode, survivingChildren } from "./daemon-children.js";
import {
  LANE_CREDENTIAL, LANE_CSRF_TOKEN, createLaneScratch, daemonEnv, repoRoot, seedEnv, serverEnv,
} from "./daemon-scratch.js";
import type { LaneScratch, LiveCredentialMode } from "./daemon-scratch.js";

export { survivingPids } from "./daemon-children.js";

export const DAEMON_LANE_ERROR_CODES = Object.freeze([
  "E2E_REPO_ROOT_UNRESOLVED",
  "E2E_DAEMON_SPAWN_FAILED",
  "E2E_DAEMON_READY_TIMEOUT",
  "E2E_SEED_REFUSED",
  "E2E_SERVER_READY_TIMEOUT",
  "E2E_TEARDOWN_ORPHAN",
] as const);
export type DaemonLaneErrorCode = (typeof DAEMON_LANE_ERROR_CODES)[number];

/** Bounded, and separately per child, so a hang names the child that hung. */
export const DAEMON_READY_BUDGET_MS = 60_000;
export const SEED_BUDGET_MS = 90_000;
export const SERVER_READY_BUDGET_MS = 60_000;

export interface DaemonLane {
  /** The dev server's base URL — what the browser opens. */
  readonly baseUrl: string;
  readonly credential: string;
  readonly csrfToken: string;
  /** The daemon's OWN announced origin, parsed from its stdout. Never assumed. */
  readonly daemonOrigin: string;
  readonly daemonPid: number;
  /** The aggregate id the seeded `node.deliver` step carries. Unique per run. */
  readonly nodeRef: string;
  readonly projectId: string;
  readonly repoRoot: string;
  /**
   * The seed child's pid, for the run's evidence line ONLY. It has already exited
   * by the time `body` runs, so the number may name some other process by now and
   * is never probed; see `lanePids`.
   */
  readonly seedPid: number;
  readonly serverPid: number;
}

export interface LaneRefused {
  readonly code: DaemonLaneErrorCode;
  /** The child's own words, verbatim: a MOE_SEED_* refusal is never restated. */
  readonly detail: string;
  readonly ok: false;
}

export type LaneOutcome<T> = LaneRefused | { readonly ok: true; readonly value: T };

const refuse = (code: DaemonLaneErrorCode, detail: string): LaneRefused =>
  Object.freeze({ code, detail, ok: false as const });

const DAEMON_ORIGIN_LINE = /^listening on (\S+)$/mu;
const SERVER_LOCAL_LINE = /Local:\s+(http:\/\/localhost:\d+)/mu;

interface StartedChild {
  /** What the child announced: the daemon's origin, the server's base URL. */
  readonly announced: string;
  readonly pid: number;
}

async function startDaemon(
  root: string, scratch: LaneScratch, tracked: ChildProcess[],
): Promise<LaneRefused | StartedChild> {
  const watched = spawnNode([
    "--experimental-transform-types",
    `${root}/apps/daemon/src/daemon-main.ts`,
    `--dependencies=${root}/apps/daemon/src/daemon-store-dependencies.ts`,
    // No fixed port: an ephemeral one is what stops this lane colliding with a
    // dev daemon, and the origin is read back rather than assumed.
    "--port=0",
    `--csrf-token=${LANE_CSRF_TOKEN}`,
  ], root, daemonEnv(scratch));
  // Held on an object because a spawn error arrives on a later turn: a plain
  // `let` assigned only inside the listener reads as never-assigned here.
  const failure: { message: string | null } = { message: null };
  watched.child.once("error", (error: Error) => { failure.message = error.message; });
  // The HANDLE is tracked, not the pid: teardown must know whether this child is
  // still the process its number names before it kills anything by that number.
  tracked.push(watched.child);
  const pid = watched.child.pid;
  const announced = await watched.waitFor(DAEMON_ORIGIN_LINE, DAEMON_READY_BUDGET_MS);
  if (failure.message !== null) return refuse("E2E_DAEMON_SPAWN_FAILED", failure.message);
  if (pid === undefined) return refuse("E2E_DAEMON_SPAWN_FAILED", "the daemon reported no pid");
  if (announced === null) {
    return refuse("E2E_DAEMON_READY_TIMEOUT", watched.transcript().slice(-600));
  }
  return { announced, pid };
}

async function runSeed(
  root: string, scratch: LaneScratch, origin: string, tracked: ChildProcess[],
): Promise<LaneRefused | number> {
  const watched = spawnNode([
    "--experimental-transform-types",
    `${root}/apps/daemon/src/orchestrator/demo-seed-main.ts`,
  ], root, seedEnv(scratch, origin));
  // Tracked even though it exits on its own: a seed that HANGS hits its budget
  // below and would otherwise outlive the lane, since teardown only kills what
  // it was told about. A seed that exited is left alone by the same teardown,
  // which reads the handle before it reads the number.
  tracked.push(watched.child);
  const pid = watched.child.pid ?? -1;
  const exit = await new Promise<number | null>((done) => {
    const timer = setTimeout(() => { done(null); }, SEED_BUDGET_MS);
    watched.child.once("exit", (code) => { clearTimeout(timer); done(code); });
  });
  // The seed echoes the daemon's own code and layer, so its transcript IS the
  // diagnosis; restating it locally would lose the refusing layer.
  return exit === 0 ? pid : refuse("E2E_SEED_REFUSED", watched.transcript().slice(-800));
}

async function startServer(
  root: string, origin: string, mode: LiveCredentialMode, tracked: ChildProcess[],
): Promise<LaneRefused | StartedChild> {
  const port = await freePort();
  const watched = spawnNode([
    `${root}/apps/control-room/node_modules/vite/bin/vite.js`,
    "--port", String(port), "--strictPort",
  ], `${root}/apps/control-room`, serverEnv(origin, mode));
  tracked.push(watched.child);
  const pid = watched.child.pid;
  const announced = await watched.waitFor(SERVER_LOCAL_LINE, SERVER_READY_BUDGET_MS);
  if (announced === null) {
    return refuse("E2E_SERVER_READY_TIMEOUT", watched.transcript().slice(-600));
  }
  if (pid === undefined) {
    return refuse("E2E_SERVER_READY_TIMEOUT", "the dev server reported no pid");
  }
  // A server on a DIFFERENT port than the one requested is a second server, and
  // the journey would then drive something this lane does not own.
  if (announced !== `http://localhost:${String(port)}`) {
    return refuse("E2E_SERVER_READY_TIMEOUT", `expected port ${String(port)}, got ${announced}`);
  }
  return { announced, pid };
}

export interface DaemonLaneOptions {
  /** ABSENT serves the same bundle with no credentials, for the refusal arm. */
  readonly liveCredentials: LiveCredentialMode;
}

async function openLane<T>(
  root: string, options: DaemonLaneOptions, tracked: ChildProcess[], scratchRoots: string[],
  body: (lane: DaemonLane) => Promise<T>,
): Promise<LaneOutcome<T>> {
  const scratch = createLaneScratch();
  scratchRoots.push(scratch.root);
  const daemon = await startDaemon(root, scratch, tracked);
  if ("ok" in daemon) return daemon;
  const seeded = await runSeed(root, scratch, daemon.announced, tracked);
  if (typeof seeded !== "number") return seeded;
  const served = await startServer(root, daemon.announced, options.liveCredentials, tracked);
  if ("ok" in served) return served;
  return Object.freeze({
    ok: true as const,
    value: await body(Object.freeze({
      baseUrl: served.announced,
      credential: LANE_CREDENTIAL,
      csrfToken: LANE_CSRF_TOKEN,
      daemonOrigin: daemon.announced,
      daemonPid: daemon.pid,
      nodeRef: scratch.nodeRef,
      projectId: scratch.projectId,
      repoRoot: root,
      seedPid: seeded,
      serverPid: served.pid,
    })),
  });
}

/**
 * Runs `body` against a real daemon-backed control room and tears the fleet down
 * in a `finally`.
 *
 * Precedence mirrors `harness.ts`: each child refuses before the next is started,
 * a body failure RE-THROWS (a failed assertion is the caller's failure and must
 * never be laundered into a harness reason code), and a surviving process only
 * overwrites a SUCCESSFUL outcome — the operator needs the reason the run failed
 * at all before the reason teardown was untidy.
 */
export async function withDaemonBackedControlRoom<T>(
  options: DaemonLaneOptions,
  body: (lane: DaemonLane) => Promise<T>,
): Promise<LaneOutcome<T>> {
  const root = repoRoot();
  if (root === null) return refuse("E2E_REPO_ROOT_UNRESOLVED", "package.json/pnpm-workspace.yaml");
  const tracked: ChildProcess[] = [];
  const scratchRoots: string[] = [];
  let primary: LaneOutcome<T>;
  try {
    primary = await openLane(root, options, tracked, scratchRoots, body);
  } finally {
    // Newest first: the dev server holds the proxy connection to the daemon.
    for (const child of [...tracked].reverse()) await killTree(child);
    // Best effort, and deliberately silent. The store file's handle may not be
    // released the instant its process dies, and a scratch directory that
    // survives is a few hundred kilobytes in TEMP — never a reason to fail a
    // journey that otherwise passed.
    for (const scratch of scratchRoots) {
      try {
        rmSync(scratch, { force: true, recursive: true });
      } catch {
        // Left behind on purpose rather than retried; see above.
      }
    }
  }
  const survivors = await survivingChildren(tracked);
  return survivors.length > 0 && primary.ok
    ? refuse("E2E_TEARDOWN_ORPHAN", survivors.join(","))
    : primary;
}

/**
 * The pids still alive when `body` ran, for the caller's own orphan assertion
 * after teardown. The seed is NOT among them: `body` only runs once the seed has
 * exited 0, so by the time any caller probes, its number is a reaped process's
 * number and can only ever name a stranger. A seed that hangs never reaches
 * `body` at all; it is refused as E2E_SEED_REFUSED and killed through its handle.
 */
export const lanePids = (lane: DaemonLane): readonly number[] =>
  Object.freeze([lane.daemonPid, lane.serverPid]);
