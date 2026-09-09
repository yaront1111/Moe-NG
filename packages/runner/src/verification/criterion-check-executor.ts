import { createHash } from "node:crypto";
import { openWindowsProcessBoundary } from "../platform/windows/windows-boundary.js";
import type { WindowsProcessBoundary } from "../platform/windows/windows-boundary-session.js";
import { ALLOWED_ENVIRONMENT_KEYS } from "../platform/windows/windows-launch-request.js";

export const CRITERION_CHECK_EXECUTOR_VERSION = "moe-criterion-check-executor/1" as const;
export interface CriterionCheckExecution {
  readonly program: string;
  readonly programSha256: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}
export interface CriterionCheckExecutionResult {
  readonly executorVersion: typeof CRITERION_CHECK_EXECUTOR_VERSION;
  readonly containment: "PROVEN" | "UNKNOWN";
  readonly exitCode: number | null;
  readonly outputSha256: string;
  readonly byteCount: number;
  readonly refusal: Readonly<{ code: string; layer: string }> | null;
}
export interface CriterionCheckExecutor {
  run(input: CriterionCheckExecution, onStarted: (pid: number) => void): Promise<CriterionCheckExecutionResult>;
  close(): Promise<void>;
}

/** Only a completed Job-broker proof yields containment; a dead leader PID never does. */
export function createCriterionCheckExecutor(): CriterionCheckExecutor {
  const active = new Set<WindowsProcessBoundary>();
  let closed = false;
  return {
    async run(input, onStarted) {
      const hash = createHash("sha256"); let byteCount = 0;
      const result = (containment: "PROVEN" | "UNKNOWN", exitCode: number | null,
        refusal: CriterionCheckExecutionResult["refusal"]): CriterionCheckExecutionResult => ({
        executorVersion: CRITERION_CHECK_EXECUTOR_VERSION, containment, exitCode, refusal,
        outputSha256: hash.digest("hex"), byteCount,
      });
      if (closed) return result("UNKNOWN", null, { code: "CRITERION_EXECUTOR_CLOSED", layer: "CRITERION_EXECUTOR" });
      if (typeof input.programSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(input.programSha256)) {
        return result("UNKNOWN", null, { code: "CRITERION_EXECUTOR_IMAGE_DIGEST_INVALID", layer: "CRITERION_EXECUTOR" });
      }
      if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 1800000) {
        return result("UNKNOWN", null, { code: "CRITERION_EXECUTOR_TIMEOUT_INVALID", layer: "CRITERION_EXECUTOR" });
      }
      const allowed = new Set<string>(ALLOWED_ENVIRONMENT_KEYS);
      // Host process variables are filtered; authority, credential and injection variables never travel.
      const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
        value !== undefined && allowed.has(key.toUpperCase()) && key.toUpperCase() !== "SYSTEMROOT"
        && !key.startsWith("ANTHROPIC_") && !key.startsWith("CLAUDE_")));
      const boundary = openWindowsProcessBoundary({ executable: input.program, argv: input.args,
        cwd: input.cwd, environment }, { timeoutMs: input.timeoutMs, hostEnvironment: process.env,
          approvedImageSha256: input.programSha256 });
      if ("truthClass" in boundary) return result("UNKNOWN", null, { code: boundary.code, layer: boundary.layer });
      active.add(boundary);
      let outputExceeded = false; let bindingFailed = false;
      const absorb = (chunk: Uint8Array): void => {
        byteCount += chunk.byteLength; hash.update(chunk);
        if (byteCount > 8 * 1024 * 1024 && !outputExceeded) { outputExceeded = true; boundary.cancel(); }
      };
      boundary.providerStdout.on("data", absorb); boundary.providerStderr.on("data", absorb);
      boundary.providerStdin.end();
      try {
        const started = await boundary.started;
        if (!("truthClass" in started)) {
          try { onStarted(started.pid); } catch { bindingFailed = true; boundary.cancel(); }
        }
        const completed = await boundary.completed;
        if (completed.truthClass !== "PROVEN") return result("UNKNOWN", null, { code: completed.code, layer: completed.layer });
        if (bindingFailed || outputExceeded || closed) return result("PROVEN", null, {
          code: bindingFailed ? "CRITERION_EXECUTOR_PID_BIND_FAILED" : outputExceeded ? "CRITERION_EXECUTOR_OUTPUT_LIMIT" : "CRITERION_EXECUTOR_CANCELLED",
          layer: "CRITERION_EXECUTOR",
        });
        return result("PROVEN", completed.exitCode, null);
      } finally { active.delete(boundary); }
    },
    async close() {
      closed = true;
      const outcomes = await Promise.all([...active].map((boundary) => boundary.close()));
      if (outcomes.some((outcome) => outcome.truthClass !== "PROVEN")) throw new Error("CRITERION_EXECUTOR_CONTAINMENT_UNKNOWN");
    },
  };
}
