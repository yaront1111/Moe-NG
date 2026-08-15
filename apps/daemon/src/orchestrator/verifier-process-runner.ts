import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";

import type { NodeMission } from "./agent-wrapper.js";
import type { VerifierRunCapture } from "./node-verifier.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_TAIL_BYTES = 262_144;

const RUNTIME_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  "COMSPEC", "LANG", "LC_ALL", "LC_CTYPE", "PATH", "PATHEXT", "SYSTEMROOT",
  "TEMP", "TMP", "TMPDIR", "TZ", "WINDIR",
]);

type SpawnProcess = (
  file: string, args: readonly string[], options: SpawnOptions,
) => ChildProcess;

export interface VerifierProcessRunnerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
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
): (brief: NodeMission) => Promise<VerifierRunCapture> {
  const environment = runtimeEnvironment(options.environment ?? process.env);
  const killProcessGroup = options.killProcessGroup ?? process.kill.bind(process);
  const outputTailBytes = options.outputTailBytes ?? DEFAULT_OUTPUT_TAIL_BYTES;
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? nodeSpawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return (brief: NodeMission): Promise<VerifierRunCapture> =>
    new Promise((resolve) => {
      const hash = createHash("sha256");
      let byteCount = 0;
      let outputTail: Buffer = Buffer.alloc(0);
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve({
          byteCount,
          exitCode,
          output: outputTail.toString("utf8"),
          sha256: hash.digest("hex"),
        });
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
      child.on("close", (code) => finish(code));
      // Keep this listener after settlement: a late/repeated EventEmitter
      // `error` must remain contained instead of becoming an uncaught throw.
      child.on("error", () => finish(null));

      const killTree = (): void => {
        if (child.pid === undefined) return;
        if (platform === "win32") {
          try {
            const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true,
            });
            killer.on("error", () => undefined);
          } catch { /* timeout remains a failed capture if taskkill cannot start */ }
          return;
        }
        try {
          // detached:true makes the shell the leader; the negative pid targets
          // the whole test recipe group, including grandchildren.
          killProcessGroup(-child.pid, "SIGKILL");
        } catch { /* ESRCH/EPERM cannot be allowed to strand verification */ }
      };

      timer = setTimeout(() => {
        killTree();
        // Kill is best-effort. The verifier slot has its own hard deadline even
        // when the platform never reports `close` after the attempted kill.
        finish(null);
      }, timeoutMs);
    });
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
