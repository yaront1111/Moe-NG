import { spawn } from "node:child_process";
import { join } from "node:path";
import { CSRF_TOKEN, REPOSITORY_ROOT, killTree, readyDaemonOrigin } from "./j1-loop-harness.js";
import type { DaemonHandle, J1Scratch, PipedChild } from "./j1-loop-harness.js";

export interface PreparedBoundary {
  readonly attemptId: string;
  readonly projectId: string;
  readonly reservationDigest: string;
}
export interface CrashDaemonHandle extends DaemonHandle {
  prepared(): Promise<PreparedBoundary>;
  resume(boundary: PreparedBoundary): void;
}

/** Own child, store, and IPC channel; no shared J1 launcher behavior changes. */
export async function startCrashDaemon(
  scratch: J1Scratch, catalogPath: string,
): Promise<CrashDaemonHandle> {
  const child = spawn(process.execPath, [
    "--experimental-transform-types", join(REPOSITORY_ROOT, "apps/daemon/src/daemon-main.ts"),
    `--dependencies=${join(REPOSITORY_ROOT, "tests/e2e/foundation/dispatch-crash-dependencies.ts")}`,
    "--port=0", `--csrf-token=${CSRF_TOKEN}`,
  ], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, MOE_DAEMON_CREDENTIAL: scratch.credential,
      MOE_PROJECT_ID: scratch.projectId, MOE_STORE_PATH: scratch.storePath,
      MOE_NODE_SPECS_DIR: scratch.specsDir, MOE_FOUNDATION_WORKSPACE_CATALOG: catalogPath,
      MOE_PROJECT_CONFIGURATION_DIGEST: undefined, MOE_VERIFICATION_CATALOG: undefined },
    stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
  }) as PipedChild;
  let output = "", boundary: PreparedBoundary | null = null, failure: Error | null = null;
  const waiters = new Set<{ resolve(value: PreparedBoundary): void; reject(error: Error): void }>();
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const fail = (error: Error): void => {
    failure = error;
    for (const waiter of waiters) waiter.reject(error);
    waiters.clear();
  };
  child.once("error", fail);
  child.once("exit", () => fail(new Error("DISPATCH_TEST_CHILD_EXITED")));
  child.once("disconnect", () => fail(new Error("DISPATCH_TEST_IPC_CLOSED")));
  child.on("message", message => {
    if (typeof message !== "object" || message === null) return;
    const value = message as Record<string, unknown>;
    if (value.kind !== "DISPATCH_PREPARED" || value.projectId !== scratch.projectId
      || typeof value.attemptId !== "string" || typeof value.reservationDigest !== "string"
      || !/^[0-9a-f]{64}$/u.test(value.reservationDigest)) return;
    boundary = { attemptId: value.attemptId, projectId: scratch.projectId,
      reservationDigest: value.reservationDigest };
    for (const waiter of waiters) waiter.resolve(boundary);
    waiters.clear();
  });
  for (let poll = 0; poll < 120 && failure === null; poll += 1) {
    const origin = readyDaemonOrigin(output);
    if (origin !== null) return {
      child, origin, pid: child.pid as number, output: () => output,
      prepared: () => {
        if (failure !== null) return Promise.reject(failure);
        if (boundary !== null) return Promise.resolve(boundary);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            waiters.delete(waiter); reject(new Error(`DISPATCH_TEST_PREPARE_TIMEOUT: ${output}`));
          }, 30_000);
          const waiter = {
            resolve: (value: PreparedBoundary) => { clearTimeout(timer); resolve(value); },
            reject: (error: Error) => { clearTimeout(timer); reject(error); },
          };
          waiters.add(waiter);
        });
      },
      resume: value => {
        if (failure !== null) throw failure;
        child.send({ ...value, kind: "RESUME_PREPARED" });
      },
    };
    await new Promise(resolve => { setTimeout(resolve, 250); });
  }
  await killTree(child);
  throw new Error(`DISPATCH_TEST_DAEMON_NOT_READY: ${output}`);
}
