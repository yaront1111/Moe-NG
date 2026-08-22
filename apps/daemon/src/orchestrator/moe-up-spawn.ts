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
 * Node 24 strips types but does not TRANSFORM them, and the wrapper's module
 * graph contains a TypeScript parameter property — `agent-spawn-contract.ts:53`,
 * `constructor(readonly reason: ...)`. Measured on Windows at b773de7:
 *
 *   node apps/daemon/src/orchestrator/agent-wrapper-main.ts
 *   -> SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]:
 *      TypeScript parameter property is not supported in strip-only mode
 *
 * so the wrapper entry cannot start under plain `node` at all. vitest never sees
 * this because its transform handles parameter properties. This flag is the
 * launcher's own invocation choice, NOT a repair of the wrapper: the underlying
 * syntax is still there and still breaks the documented manual recipe. Passed to
 * both children so a parameter property added to the daemon's graph tomorrow
 * cannot break the launcher the same way. Drop it once the syntax is gone — the
 * negative-control test in `moe-up-main.test.ts` says when.
 */
export const NODE_TRANSFORM_TYPES_FLAG = "--experimental-transform-types" as const;

/** Absolute, so a child's own cwd can never change which entry runs. */
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
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}
