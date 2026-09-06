/**
 * THE WRAPPER HALF OF THE DAEMON-BACKED LANE: a real `agent-wrapper-main.ts` staffing a real
 * seeded board, with ONE thing stood in - the seat itself.
 *
 * WHY A SEAT DOUBLE AT ALL. The journey this module serves proves that a provider limit parks
 * staffing. The only way to reach that path honestly is for a seat to EXIT with a provider's own
 * limit sentence in its output, and no real provider can be asked to hit its limit on cue. So the
 * seat - and only the seat - is a script: it ignores every argument the spawner appends, prints
 * ONE line to stderr, and exits 1. Everything downstream of that line is the shipped wrapper.
 *
 * THE LINE IS COPIED, NEVER COMPOSED. `LIMIT_LINE` carries the bytes of the claude session-limit
 * fixture in `LIMIT_LINE_SOURCE`, which was captured off a real seat exit. The fixture is declared
 * `const` there and is NOT exported, so it cannot be imported; the copy is therefore proven at
 * test time by reading that file and comparing (`readFixtureLimitLine`). A line retyped from
 * memory would match the roster pattern while proving nothing about the provider's real words.
 *
 * WINDOWS IS WHY THERE ARE THREE FILES. `agent-spawn-invocation.ts` runs a win32 seat THROUGH
 * cmd.exe as a command LINE, so the command must be something cmd can execute - a `.cmd`. On
 * posix the same spawner passes argv directly, so a `.sh` is the executable form. Both delegate
 * to one `.js`, which is where the bytes live, so the two platforms cannot drift apart.
 */
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";

import {
  clearProviderPause,
} from "../../../apps/daemon/src/orchestrator/provider-pause-ledger.js";
import type {
  ProviderPauseRecordResult,
} from "../../../apps/daemon/src/orchestrator/provider-pause-ledger.js";
import { spawnNode } from "./daemon-children.js";
import type { Watched } from "./daemon-children.js";
import { daemonEnv } from "./daemon-ports.js";
import type { DaemonLane, LaneScratch } from "./daemon-ports.js";

/** Where `LIMIT_LINE`'s bytes were copied from, cited so a reader can re-check them. */
export const LIMIT_LINE_SOURCE = "apps/daemon/src/orchestrator/seat-exit-classifier.test.ts";

/**
 * The claude session-limit line, byte for byte. `\u00B7` is the MIDDLE DOT the claude CLI
 * composes with; it is written ESCAPED here for the same reason the fixture writes it escaped -
 * so no console encoding between the source and the seat can mangle it.
 */
export const LIMIT_LINE = "You've hit your session limit \u00B7 resets 12:10am Asia/Jerusalem";

/** The fixture declaration `LIMIT_LINE` was copied out of. */
const FIXTURE_LINE = /const CLAUDE_SESSION_LIMIT[\s\S]*?\n\s*line: ("(?:[^"\\]|\\.)*"),/u;

/**
 * The fixture's own bytes, read out of its source. Returns null when the declaration cannot be
 * found, which is a MOVED fixture and must fail a test rather than silently pass a stale copy.
 */
export function readFixtureLimitLine(repoRoot: string): string | null {
  const source = readFileSync(join(repoRoot, LIMIT_LINE_SOURCE), "utf8");
  const literal = FIXTURE_LINE.exec(source)?.[1];
  if (literal === undefined) return null;
  const parsed: unknown = JSON.parse(literal);
  return typeof parsed === "string" ? parsed : null;
}

/** A JS string literal whose every byte is ASCII, so the generated file cannot be re-encoded. */
function asciiLiteral(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007F-\uFFFF]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export interface SeatDoubleFile {
  readonly bytes: string;
  readonly path: string;
}

export interface SeatDouble {
  /** What `MOE_AGENT_COMMAND` is set to: the form THIS platform's spawner can execute. */
  readonly command: string;
  readonly files: readonly SeatDoubleFile[];
}

/**
 * Writes the seat double into `dir` and says which of its forms this platform runs.
 *
 * `writeSync(2, ...)` rather than `process.stderr.write`: on Windows a pipe write is
 * asynchronous, and `process.exit` would then be free to discard the one line this whole
 * journey turns on. The exit code is 1 because a provider limit is a FAILED seat - the wrapper
 * classifies the exit, it does not ask the seat what happened.
 */
export function seatDoubleFiles(dir: string, line: string): SeatDouble {
  const jsPath = join(dir, "seat-double.js");
  const cmdPath = join(dir, "seat-double.cmd");
  const shPath = join(dir, "seat-double.sh");
  const files: readonly SeatDoubleFile[] = [
    {
      bytes: 'require("node:fs").writeSync(2, ' + asciiLiteral(line) + ' + "\\n");\nprocess.exit(1);\n',
      path: jsPath,
    },
    {
      // Ignores %* on purpose: the spawner appends the provider CLI's own flags, and a seat
      // double that forwarded them would be running whatever `node` makes of `-p`.
      bytes: `@echo off\r\n"${process.execPath}" "%~dp0seat-double.js"\r\nexit /b %ERRORLEVEL%\r\n`,
      path: cmdPath,
    },
    {
      bytes: `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/seat-double.js"\n`,
      path: shPath,
    },
  ];
  for (const file of files) writeFileSync(file.path, file.bytes, "utf8");
  chmodSync(shPath, 0o755);
  return Object.freeze({
    command: process.platform === "win32" ? cmdPath : shPath,
    files,
  });
}

/** How often the wrapper takes a pass. Above `wrapper-knobs.ts`'s 100 ms floor, and bounded. */
export const WRAPPER_INTERVAL_MS = 500;

/**
 * The wrapper's environment: the lane's own daemon environment plus the four wrapper knobs.
 *
 * `MOE_NODE_LANDING: "0"` keeps git out of the scratch workspace - the lane's node spec points at
 * a temp directory that is not a repository, and a landing attempt there is noise this journey
 * does not read. No provider credential is added: the seat double needs none, and a real one
 * reaching a scripted seat would be a leak with nothing to spend it on.
 */
export function wrapperEnv(
  scratch: LaneScratch, command: string, intervalMs: number = WRAPPER_INTERVAL_MS,
): Readonly<Record<string, string | undefined>> {
  return Object.freeze({
    ...daemonEnv(scratch),
    MOE_AGENT_COMMAND: command,
    MOE_NODE_LANDING: "0",
    MOE_WRAPPER_INTERVAL_MS: String(intervalMs),
    MOE_WRAPPER_MAX_AGENTS: "1",
  });
}

/**
 * Starts the REAL wrapper and hands its handle to the caller's tracked list, so the same
 * teardown that kills the daemon and the dev server kills this too.
 */
export function startWrapper(
  root: string, env: Readonly<Record<string, string | undefined>>, tracked: ChildProcess[],
): Watched {
  const watched = spawnNode(
    ["--experimental-transform-types", `${root}/apps/daemon/src/orchestrator/agent-wrapper-main.ts`],
    root,
    env,
  );
  tracked.push(watched.child);
  return watched;
}

/**
 * Ends a live pause the way an operator would: one durable write against the same store the
 * wrapper is polling. SQLite is in WAL mode, so a second process may write while the wrapper
 * holds the file open; the wrapper sees it on its next pass and staffs again.
 */
export function clearPause(
  storePath: string, projectId: string, provider: string,
): ProviderPauseRecordResult {
  const store = SqliteEventStore.openForProject(storePath, projectId);
  try {
    return clearProviderPause(store, { now: new Date().toISOString(), projectId, provider });
  } finally {
    store.close();
  }
}

const SCRATCH_PREFIX = "moe-e2e-daemon-";
const PROJECT_PREFIX = "e2e-proj-";

/**
 * The lane's scratch identities, reconstructed from what `DaemonLane` DOES expose.
 *
 * `withDaemonBackedControlRoom` hands `body` a lane, never the `LaneScratch` behind it, and the
 * wrapper needs the store path and the spec directory that lane is running on. `createLaneScratch`
 * derives every identity from one random suffix and LOWERCASES it into `projectId`, so the
 * directory is found by scanning rather than by rejoining a tag that may have lost its case.
 *
 * Returns null unless the found directory carries this lane's own store and node spec: a wrong
 * pick would silently point the wrapper at another run's board.
 */
export function resolveLaneScratch(lane: DaemonLane): LaneScratch | null {
  const tag = lane.projectId.startsWith(PROJECT_PREFIX)
    ? lane.projectId.slice(PROJECT_PREFIX.length)
    : null;
  if (tag === null || tag === "") return null;
  // EVERY candidate is checked, not just the first. A box that has run this lane before keeps its
  // abandoned scratch directories in TEMP (the lane's cleanup is best effort by design), and two
  // suffixes that differ only in case collapse to the same tag here - so taking `find`'s first hit
  // would answer null while the real directory sat further down the list.
  for (const entry of readdirSync(tmpdir())) {
    if (!entry.startsWith(SCRATCH_PREFIX)) continue;
    if (entry.slice(SCRATCH_PREFIX.length).toLowerCase() !== tag) continue;
    const root = join(tmpdir(), entry);
    const nodeSpecsDir = join(root, "node-specs");
    const storePath = join(root, "store.sqlite");
    const spec = join(nodeSpecsDir, "node.json");
    if (!existsSync(storePath) || !existsSync(spec)) continue;
    // The spec names THIS lane's node, so a directory belonging to another run is never returned.
    if (!readFileSync(spec, "utf8").includes(`"nodeRef":"${lane.nodeRef}"`)) continue;
    return Object.freeze({
      catalogPath: join(root, "projects.json"), nodeRef: lane.nodeRef, nodeSpecsDir,
      projectId: lane.projectId, root, storePath, tag,
    });
  }
  return null;
}
