import { spawn } from "node:child_process";
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
