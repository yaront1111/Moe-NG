import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { win32 as windowsPath } from "node:path";

import { deliverEnvironment, type EnvironmentDeliveredVariables } from "../environment/environment-delivery.js";
import type { NodeMission } from "./agent-wrapper.js";
import type { VerifierRunCapture } from "./node-verifier.js";
import {
  VerifierProcessCancelledError,
  VerifierProcessContainmentError,
} from "./process-runner-lifecycle.js";
import type {
  VerifierProcessContainmentReason,
  VerifierProcessRunner,
} from "./process-runner-lifecycle.js";

export {
  VerifierProcessCancelledError,
  VerifierProcessContainmentError,
} from "./process-runner-lifecycle.js";
export type {
  VerifierProcessContainmentReason,
  VerifierProcessRunner,
} from "./process-runner-lifecycle.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_TAIL_BYTES = 262_144;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_DRAIN_GRACE_MS = 5_000;

const RUNTIME_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  "COMSPEC", "LANG", "LC_ALL", "LC_CTYPE", "PATH", "PATHEXT", "SYSTEMROOT",
  "TEMP", "TMP", "TMPDIR", "TZ", "WINDIR",
]);

type SpawnProcess = (
  file: string, args: readonly string[], options: SpawnOptions,
) => ChildProcess;

export interface VerifierProcessRunnerOptions {
  readonly delivered?: EnvironmentDeliveredVariables | undefined; // Onto the allowlisted RESULT.
  /**
   * How long stdio may stay open after the recipe's exit is observed before
   * the capture settles on that exit anyway. A recipe that backgrounds a
   * server inherits the pipes into a grandchild; without this bound its exit
   * would never become a close and a passing run would time out instead.
   */
  readonly drainGraceMs?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly killGraceMs?: number;
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  readonly onFatalContainment?: ((error: VerifierProcessContainmentError) => void) | undefined;
  readonly outputTailBytes?: number;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: SpawnProcess;
  readonly timeoutMs?: number;
}

/**
 * This boundary reduces ambient authority; it is not a hermetic verifier.
 * The recipe still runs through a same-UID shell in an operator-selected
 * workspace, so filesystem/process isolation and recipe sealing remain release
 * work outside this runner.
 */
export function createVerifierProcessRunner(
  options: VerifierProcessRunnerOptions = {},
): VerifierProcessRunner {
  const sourceEnvironment = options.environment ?? process.env;
  // UNDER the allowlist: the overlay lands on what the filter RETURNED, so an arbitrary operator
  // name arrives without either roster being widened to admit it.
  const { environment } = deliverEnvironment(runtimeEnvironment(sourceEnvironment), options.delivered);
  const drainGraceMs = options.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const killProcessGroup = options.killProcessGroup ?? process.kill.bind(process);
  const outputTailBytes = options.outputTailBytes ?? DEFAULT_OUTPUT_TAIL_BYTES;
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? nodeSpawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const active = new Set<{
    readonly cancel: () => void;
    readonly done: Promise<VerifierRunCapture>;
  }>();
  const containmentFailures: VerifierProcessContainmentError[] = [];
  let closed = false;
  let closing: Promise<void> | undefined;

  const run = async (brief: NodeMission): Promise<VerifierRunCapture> => {
    if (closed) throw new Error("VERIFIER_PROCESS_RUNNER_CLOSED");
    let owned: {
      readonly cancel: () => void;
      readonly done: Promise<VerifierRunCapture>;
    } | undefined;
    let cancelOwned: () => void = () => undefined;
    let completedBeforeRegistration = false;
    const done = new Promise<VerifierRunCapture>((resolve, reject) => {
      const hash = createHash("sha256");
      let byteCount = 0;
      let outputTail: Buffer = Buffer.alloc(0);
      let settled = false;
      let childClosed = false;
      let childExited = false;
      let exitStatus: number | null = null;
      let treeKillConfirmed = false;
      let killHelper: ChildProcess | undefined;
      let termination: "CANCEL" | "PROCESS_ERROR" | "TIMEOUT" | null = null;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        if (drainTimer !== undefined) clearTimeout(drainTimer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (killHelper !== undefined) {
          try { killHelper.kill("SIGKILL"); } catch { /* already gone */ }
          try { killHelper.unref(); } catch { /* optional for injected children */ }
          killHelper = undefined;
        }
        if (owned !== undefined) active.delete(owned);
        else completedBeforeRegistration = true;
      };
      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          byteCount,
          exitCode,
          output: outputTail.toString("utf8"),
          sha256: hash.digest("hex"),
        });
      };
      const failContainment = (reason: VerifierProcessContainmentReason): void => {
        if (settled) return;
        settled = true;
        const error = new VerifierProcessContainmentError(reason);
        containmentFailures.push(error);
        closed = true;
        cleanup();
        try {
          options.onFatalContainment?.(error);
        } catch { /* an observer cannot replace or suppress the containment failure */ }
        reject(error);
      };
      const finishCancellation = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new VerifierProcessCancelledError());
      };

      let child: ChildProcess;
      try {
        child = spawn(brief.test, [], {
          cwd: brief.workspace,
          detached: platform !== "win32",
          env: environment,
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        finish(null);
        return;
      }

      const absorb = (chunk: Buffer | string): void => {
        if (settled) return;
        const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
        byteCount += raw.byteLength;
        hash.update(raw);
        outputTail = appendTail(outputTail, raw, outputTailBytes);
      };
      child.stdout?.on("data", absorb);
      child.stderr?.on("data", absorb);
      const maybeFinishTermination = (): void => {
        if (termination === null || !treeKillConfirmed || !childClosed) return;
        if (termination === "CANCEL") finishCancellation();
        else finish(null);
      };
      const releaseStdio = (): void => {
        for (const stream of [child.stdout, child.stderr]) {
          try { stream?.destroy(); } catch { /* already released */ }
        }
      };
      // A best-effort signal, not containment: the recipe's verdict has
      // already landed, so a straggler the group signal cannot reach (ESRCH, a
      // grandchild that left the group) is a leak for the hermetic-verifier
      // release work, never a reason to fail the runner closed. Windows has no
      // group to signal and the observed pid is stale, so nothing is killed.
      const killStragglersBestEffort = (): void => {
        if (platform === "win32" || child.pid === undefined) return;
        try { killProcessGroup(-child.pid, "SIGKILL"); } catch { /* group already gone */ }
      };
      // Settles a recipe whose exit was observed while stdio never closed.
      // Destroying our pipe ends makes the real close arrive afterwards; the
      // settled guard in every finisher keeps it from settling twice.
      const settleExited = (): void => {
        if (settled || childClosed) return;
        if (termination === null) killStragglersBestEffort();
        releaseStdio();
        childClosed = true;
        if (termination === null) finish(exitStatus);
        else maybeFinishTermination();
      };
      child.on("close", (code) => {
        childClosed = true;
        if (termination === null) finish(code);
        else maybeFinishTermination();
      });
      // close needs every stdio pipe released, and a grandchild that inherited
      // them (a backgrounded server) keeps the pipes open long after the recipe
      // exits. Grading on close alone would turn that passing run into a
      // timeout; exit fixes the status, and the drain grace bounds the wait.
      child.on("exit", (code) => {
        if (childExited) return;
        childExited = true;
        exitStatus = code;
        if (settled || childClosed) return;
        drainTimer = setTimeout(settleExited, drainGraceMs);
        if (typeof drainTimer.unref === "function") drainTimer.unref();
      });
      // Keep this listener after settlement: a late/repeated EventEmitter
      // `error` must remain contained instead of becoming an uncaught throw.
      child.on("error", () => {
        if (settled || termination !== null) return;
        if (child.pid === undefined) finish(null);
        else beginTermination("PROCESS_ERROR");
      });

      const killDirectBestEffort = (): void => {
        try { child.kill("SIGKILL"); } catch { /* containment failure is reported separately */ }
      };
      const systemRoot = (): string | null => {
        const entry = Object.entries(sourceEnvironment).find(([key, value]) =>
          key.toUpperCase() === "SYSTEMROOT" && typeof value === "string" && value !== "");
        const value = entry?.[1];
        return value !== undefined && windowsPath.isAbsolute(value) ? value : null;
      };
      const killTree = (): void => {
        if (child.pid === undefined) {
          killDirectBestEffort();
          failContainment("PID_UNAVAILABLE");
          return;
        }
        if (platform === "win32") {
          if (childExited) {
            // The pid is stale once exit is observed: taskkill could only
            // report the tree gone (128) or, worse, target whatever reused the
            // pid. The observed exit is the proof containment exists to reach.
            treeKillConfirmed = true;
            maybeFinishTermination();
            return;
          }
          const root = systemRoot();
          if (root === null) {
            killDirectBestEffort();
            failContainment("TREE_KILL_FAILED");
            return;
          }
          try {
            const killer = spawn(
              windowsPath.join(root, "System32", "taskkill.exe"),
              ["/pid", String(child.pid), "/T", "/F"],
              { stdio: "ignore", windowsHide: true },
            );
            killHelper = killer;
            try { killer.unref(); } catch { /* injected children may omit it */ }
            let killerSettled = false;
            const failKiller = (): void => {
              if (killerSettled) return;
              killerSettled = true;
              killDirectBestEffort();
              failContainment("TREE_KILL_FAILED");
            };
            killer.once("error", failKiller);
            killer.once("close", (code) => {
              if (killerSettled) return;
              killerSettled = true;
              // 128 is taskkill's "no running instance": the tree is ALREADY
              // dead, which is the outcome containment exists to reach, not an
              // escape from it. A direct child whose exit or close landed is
              // the same proof for any other nonzero exit: a recipe that dies
              // in the same instant the killer lands must not shut the whole
              // runner down.
              if (code !== 0 && code !== 128 && !childClosed && !childExited) {
                killDirectBestEffort();
                failContainment("TREE_KILL_FAILED");
                return;
              }
              treeKillConfirmed = true;
              maybeFinishTermination();
            });
          } catch {
            killDirectBestEffort();
            failContainment("TREE_KILL_FAILED");
          }
          return;
        }
        try {
          // detached:true makes the shell the leader; the negative pid targets
          // the whole test recipe group, including grandchildren.
          killProcessGroup(-child.pid, "SIGKILL");
        } catch (error) {
          // ESRCH means the group is already gone — the exact state the signal
          // was sent to reach — so a recipe that exits as the kill lands is
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

      const beginTermination = (reason: "CANCEL" | "PROCESS_ERROR" | "TIMEOUT"): void => {
        if (settled || termination !== null) return;
        if (childExited) {
          // The leader is already dead and only a straggler can still pin the
          // pipes. Cancellation outranks the recorded exit and still signals
          // the group with containment semantics; a deadline or error reaching
          // a dead leader merely cuts the drain short, since the exit it would
          // overwrite with a kill outcome landed inside the deadline.
          if (reason === "CANCEL") {
            termination = reason;
            killTree();
          }
          settleExited();
          return;
        }
        termination = reason;
        killTimer = setTimeout(() => {
          // CLOSE_NOT_OBSERVED names a live leader that survived SIGKILL. One
          // whose exit landed is dead; a pipe still pinned by a straggler that
          // escaped the group is released so the kill outcome can settle.
          if (childExited && treeKillConfirmed) {
            settleExited();
            return;
          }
          failContainment(treeKillConfirmed ? "CLOSE_NOT_OBSERVED" : "TREE_KILL_FAILED");
        }, killGraceMs);
        if (typeof killTimer.unref === "function") killTimer.unref();
        killTree();
      };
      cancelOwned = (): void => { beginTermination("CANCEL"); };
      timer = setTimeout(() => {
        beginTermination("TIMEOUT");
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    owned = { cancel: cancelOwned, done };
    if (!completedBeforeRegistration) active.add(owned);
    return done;
  };

  const callable = run as VerifierProcessRunner;
  Object.defineProperties(callable, {
    activeCount: { value: (): number => active.size },
    close: {
      value: (): Promise<void> => {
        if (closing !== undefined) return closing;
        closed = true;
        closing = (async (): Promise<void> => {
          const current = [...active];
          for (const process of current) process.cancel();
          await Promise.allSettled(current.map((process) => process.done));
          if (containmentFailures.length === 1) throw containmentFailures[0];
          if (containmentFailures.length > 1) {
            throw new AggregateError(containmentFailures, "VERIFIER_PROCESS_CONTAINMENT_FAILED");
          }
        })();
        return closing;
      },
    },
  });
  return callable;
}

function runtimeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && RUNTIME_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      environment[key] = value;
    }
  }
  return environment;
}

function appendTail(current: Buffer, chunk: Buffer, limit: number): Buffer {
  if (limit <= 0) return Buffer.alloc(0);
  if (chunk.byteLength >= limit) return Buffer.from(chunk.subarray(chunk.byteLength - limit));
  const retainedPrefixBytes = Math.min(current.byteLength, limit - chunk.byteLength);
  return Buffer.concat([
    current.subarray(current.byteLength - retainedPrefixBytes),
    chunk,
  ], retainedPrefixBytes + chunk.byteLength);
}
