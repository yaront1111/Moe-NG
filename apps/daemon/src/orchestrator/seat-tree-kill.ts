/**
 * The Windows arm of seat containment: `taskkill /T /F` against the seat's pid.
 *
 * Split out of agent-spawner.ts, which stood at 491 lines against the split-before-400 rail, as
 * the one self-contained piece of its kill path: it needs the spawn boundary, the child
 * environment's SYSTEMROOT and a pid, and answers through two callbacks. The POSIX arm stays
 * with the spawner because it is one `killProcessGroup` call around an ESRCH check.
 *
 * No process access of its own: the killer is spawned through the injected boundary and the
 * environment is the one the caller hands over, so a test can drive every arm.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { win32 as windowsPath } from "node:path";

export interface WindowsTreeKillInput {
  /**
   * Read when the killer CLOSES, never at spawn: a seat that closes while taskkill is running
   * is an already-dead tree, which is the outcome containment exists to reach.
   */
  readonly childClosed: () => boolean;
  readonly environment: NodeJS.ProcessEnv;
  /** The tree is provably dead: taskkill exited 0 or 128 ("no running instance"), or the seat closed. */
  readonly onConfirmed: () => void;
  /**
   * Called at most once, on the first failure: no absolute SYSTEMROOT, a throwing spawn, the
   * killer's `error` event, or a nonzero exit other than 128 against a seat that is still live.
   */
  readonly onFailed: () => void;
  readonly pid: number;
  readonly spawn: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

/** SYSTEMROOT as the child environment carries it, under any casing, only when absolute. */
export function windowsSystemRoot(environment: NodeJS.ProcessEnv): string | null {
  const entry = Object.entries(environment).find(([key, value]) =>
    key.toUpperCase() === "SYSTEMROOT" && typeof value === "string" && value !== "");
  const value = entry?.[1];
  return value !== undefined && windowsPath.isAbsolute(value) ? value : null;
}

/**
 * Spawns the killer and hands it back so the caller can SIGKILL and unref it at cleanup, or
 * returns undefined when no killer exists - `onFailed` has then already been called.
 */
export function spawnWindowsTreeKill(input: WindowsTreeKillInput): ChildProcess | undefined {
  const root = windowsSystemRoot(input.environment);
  if (root === null) {
    input.onFailed();
    return undefined;
  }
  let killer: ChildProcess;
  try {
    killer = input.spawn(
      windowsPath.join(root, "System32", "taskkill.exe"),
      ["/pid", String(input.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
  } catch {
    input.onFailed();
    return undefined;
  }
  try { killer.unref(); } catch { /* injected children may omit it */ }
  let settled = false;
  killer.once("error", () => {
    if (settled) return;
    settled = true;
    input.onFailed();
  });
  killer.once("close", (code) => {
    if (settled) return;
    settled = true;
    // 128 is taskkill's "no running instance": the tree is ALREADY dead, which is the outcome
    // containment exists to reach, not an escape from it. A closed direct child is the same
    // proof for any other nonzero exit - an agent that dies in the same instant the killer
    // lands must not shut the whole wrapper down.
    if (code !== 0 && code !== 128 && !input.childClosed()) {
      input.onFailed();
      return;
    }
    input.onConfirmed();
  });
  return killer;
}
