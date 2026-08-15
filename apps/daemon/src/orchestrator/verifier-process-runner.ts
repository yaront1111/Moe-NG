import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { win32 as windowsPath } from "node:path";

import type { NodeMission } from "./agent-wrapper.js";
import type { VerifierRunCapture } from "./node-verifier.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_TAIL_BYTES = 262_144;
const DEFAULT_KILL_GRACE_MS = 5_000;

const RUNTIME_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  "COMSPEC", "LANG", "LC_ALL", "LC_CTYPE", "PATH", "PATHEXT", "SYSTEMROOT",
  "TEMP", "TMP", "TMPDIR", "TZ", "WINDIR",
]);

type SpawnProcess = (
  file: string, args: readonly string[], options: SpawnOptions,
) => ChildProcess;

export interface VerifierProcessRunnerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly killGraceMs?: number;
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  readonly onFatalContainment?: ((error: VerifierProcessContainmentError) => void) | undefined;
  readonly outputTailBytes?: number;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: SpawnProcess;
  readonly timeoutMs?: number;
}

export type VerifierProcessContainmentReason =
  | "CLOSE_NOT_OBSERVED"
  | "PID_UNAVAILABLE"
  | "TREE_KILL_FAILED";

export class VerifierProcessContainmentError extends Error {
  readonly code = "VERIFIER_PROCESS_CONTAINMENT_FAILED";
  readonly reason: VerifierProcessContainmentReason;

  constructor(reason: VerifierProcessContainmentReason) {
    super(`VERIFIER_PROCESS_CONTAINMENT_FAILED:${reason}`);
    this.name = "VerifierProcessContainmentError";
    this.reason = reason;
  }
}

export class VerifierProcessCancelledError extends Error {
  readonly code = "VERIFIER_PROCESS_CANCELLED";

  constructor() {
    super("VERIFIER_PROCESS_CANCELLED");
    this.name = "VerifierProcessCancelledError";
  }
}

export interface VerifierProcessRunner {
  (brief: NodeMission): Promise<VerifierRunCapture>;
  readonly activeCount: () => number;
  readonly close: () => Promise<void>;
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
  const environment = runtimeEnvironment(sourceEnvironment);
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
      let treeKillConfirmed = false;
      let killHelper: ChildProcess | undefined;
      let termination: "CANCEL" | "PROCESS_ERROR" | "TIMEOUT" | null = null;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
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
      child.on("close", (code) => {
        childClosed = true;
        if (termination === null) finish(code);
        else maybeFinishTermination();
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
              if (code !== 0) {
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
          treeKillConfirmed = true;
          maybeFinishTermination();
        } catch {
          killDirectBestEffort();
          failContainment("TREE_KILL_FAILED");
        }
      };

      const beginTermination = (reason: "CANCEL" | "PROCESS_ERROR" | "TIMEOUT"): void => {
        if (settled || termination !== null) return;
        termination = reason;
        killTimer = setTimeout(() => {
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
