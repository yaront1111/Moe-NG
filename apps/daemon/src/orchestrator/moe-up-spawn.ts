import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

/**
 * The launcher's process port: what `moe up` needs from a child, and where the
 * two existing entries live. Split from the composer so a test can drive the
 * lifecycle with a fake child while the real adapter below stays one shape.
 */

/** The narrow slice of a child process this launcher actually drives. */
export interface LaunchChildProcess {
  kill(signal?: NodeJS.Signals): boolean;
  once(
    event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  readonly pid?: number | undefined;
  readonly stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  readonly stdin?: {
    on?(event: "error", listener: (error: Error) => void): unknown;
    write(chunk: string, callback?: (error?: Error | null) => void): unknown;
  } | null | undefined;
  readonly stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
}

export interface LaunchSpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export type LaunchSpawn = (
  command: string, argv: readonly string[], options: LaunchSpawnOptions,
) => LaunchChildProcess;

export interface LaunchEntryPaths {
  readonly daemonEntry: string;
  readonly dependencies: string;
  readonly wrapperEntry: string;
}

/**
 * Absolute, so a child's own cwd can never change which entry runs.
 *
 * Every entry runs under plain `node` with no transform flag, as do the `moe start`
 * wrapper (`projects/project-stack-host-main.ts`) and the stack host the runner's Windows
 * boundary starts. Strip-only mode refuses what it cannot erase, so the guard is a real
 * spawn: `moe-up-main.test.ts` and `project-stack-host-main.test.ts` load each entry under
 * plain node together with what it imports at runtime, which the daemon's
 * `erasableSyntaxOnly` never sees (the control room's payload-hint table).
 */
export function launchEntryPaths(repoRoot: string): LaunchEntryPaths {
  const daemonSrc = join(repoRoot, "apps", "daemon", "src");
  return Object.freeze({
    daemonEntry: join(daemonSrc, "daemon-main.ts"),
    dependencies: join(daemonSrc, "daemon-store-dependencies.ts"),
    wrapperEntry: join(daemonSrc, "orchestrator", "agent-wrapper-main.ts"),
  });
}

/**
 * Where a BUILT control room lives, when one does, in the order they are tried:
 * the checkout's own Vite output, then the packaged artifact's copy of it
 * (`tools/packaging/pack-windows.ts` stages `apps/control-room/dist` as
 * `<root>/control-room`). The two never coexist in one tree, so the order is a
 * statement of which layout this file is written against rather than a tie-break.
 */
export const CONTROL_ROOM_BUNDLE_CANDIDATES: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(["apps", "control-room", "dist"]),
  Object.freeze(["control-room"]),
]);

/**
 * The asset root the launcher hands the daemon, or `null` when no bundle is
 * built - the ordinary development state, in which the launcher passes no flag,
 * the daemon hosts nothing, and the two-process recipe is printed instead.
 * Proven by the one file the daemon's static host demands of a bundle, an
 * `index.html` that is a regular file directly under the root, so the launcher
 * never hands over a directory the daemon would refuse to start on.
 */
export function controlRoomAssetRoot(repoRoot: string): string | null {
  for (const segments of CONTROL_ROOM_BUNDLE_CANDIDATES) {
    const candidate = join(repoRoot, ...segments);
    try {
      if (statSync(join(candidate, "index.html")).isFile()) return candidate;
    } catch {
      // Absent is the ordinary case, not a fault: a source checkout with no build.
    }
  }
  return null;
}

/**
 * The real spawn. `shell: false` is stated rather than left to the default: a
 * shell here would re-parse a store path containing spaces and silently run a
 * different argv than the one this launcher composed.
 */
export function createProcessSpawn(): LaunchSpawn {
  return (command, argv, options) => spawn(command, [...argv], {
    cwd: options.cwd,
    env: { ...options.env },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}
