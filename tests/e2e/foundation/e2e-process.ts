/**
 * Declared-boundary process control — the ONLY place in this epic allowed to
 * terminate a real process.
 *
 * J3 (design line 1099) requires killing the agent, the runner and the daemon
 * at declared boundaries. The runner subtree is deliberately fenced against real
 * termination, so this capability is confined here: it is never exported from a
 * package, and `e2e-harness.test.ts` scans `packages/`, `apps/` and `adapters/`
 * and fails if anything there references this directory.
 *
 * Every refusal carries a stable code from `E2E_ERROR_CODES`. Refusing without a
 * code would let a journey assert "the kill did not happen" while a completely
 * different layer was doing the refusing.
 */

import { spawn, type ChildProcess } from "node:child_process";

import {
  type DeclaredBoundary,
  type E2eRun,
  isDeclaredBoundary,
} from "./e2e-harness.js";

/** The three processes J3 names, verbatim from design line 1099. */
export const KILL_TARGETS = Object.freeze(["agent", "runner", "daemon"] as const);
export type KillTarget = (typeof KILL_TARGETS)[number];

export type KillResult =
  | { readonly ok: true; readonly boundary: DeclaredBoundary }
  | {
      readonly ok: false;
      readonly code: "E2E_UNDECLARED_BOUNDARY" | "E2E_PROCESS_ALREADY_KILLED";
      readonly message: string;
    };

export interface HarnessProcessHandle {
  readonly target: KillTarget;
  readonly pid: number | undefined;
  /** The boundary this process was killed at, or `null` while it is alive. */
  readonly killedAt: DeclaredBoundary | null;
}

class HarnessProcess implements HarnessProcessHandle {
  private boundary: DeclaredBoundary | null = null;

  constructor(
    readonly target: KillTarget,
    readonly child: ChildProcess,
  ) {}

  get pid(): number | undefined {
    return this.child.pid;
  }

  get killedAt(): DeclaredBoundary | null {
    return this.boundary;
  }

  markKilled(boundary: DeclaredBoundary): void {
    this.boundary = boundary;
  }
}

/**
 * Resolves once the child has actually exited.
 *
 * Awaiting the exit is not politeness: on Windows the process keeps file
 * handles open until it is gone, so removing a scratch fixture directory before
 * the exit lands fails with `EBUSY` and hides whatever the journey was really
 * asserting.
 */
function awaitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}

/**
 * Spawns a Node child bound to one of J3's three kill targets.
 *
 * The target is validated BEFORE spawning, so an unknown target cannot leave an
 * orphan behind that no cleanup entry owns.
 */
export function spawnHarnessProcess(
  run: E2eRun,
  target: KillTarget,
  args: readonly string[],
): HarnessProcessHandle {
  if (!(KILL_TARGETS as readonly string[]).includes(target)) {
    throw new TypeError(`E2E_UNKNOWN_KILL_TARGET: ${JSON.stringify(target)}`);
  }
  const child = spawn(process.execPath, [...args], { stdio: "ignore" });
  const handle = new HarnessProcess(target, child);
  run.registerCleanup(`process:${target}:${String(child.pid)}`, async () => {
    child.kill("SIGKILL");
    await awaitExit(child);
  });
  return handle;
}

/**
 * Terminates a spawned process at a declared boundary.
 *
 * Both refusals are typed. `E2E_PROCESS_ALREADY_KILLED` matters because a J3
 * case that killed the same handle twice would appear to exercise two crash
 * boundaries while exercising one.
 */
export function killAtDeclaredBoundary(
  handle: HarnessProcessHandle,
  boundary: string,
): KillResult {
  // Provenance first: a handle this module did not create has no cleanup entry
  // owning it, so refusing it with a typed boundary code would report a tidy
  // outcome for a process nothing will ever reap.
  if (!(handle instanceof HarnessProcess)) {
    throw new TypeError("kill target was not produced by spawnHarnessProcess");
  }
  if (!isDeclaredBoundary(boundary)) {
    return {
      ok: false,
      code: "E2E_UNDECLARED_BOUNDARY",
      message: `${JSON.stringify(boundary)} is not a declared boundary`,
    };
  }
  if (handle.killedAt !== null) {
    return {
      ok: false,
      code: "E2E_PROCESS_ALREADY_KILLED",
      message: `${handle.target} was already killed at ${handle.killedAt}`,
    };
  }
  handle.child.kill("SIGKILL");
  handle.markKilled(boundary);
  return { ok: true, boundary };
}
