import { Worker } from "node:worker_threads";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function bytes(value: string): Uint8Array {
  return textEncoder.encode(value);
}
export function text(value: Uint8Array): string {
  return textDecoder.decode(value);
}

export interface RaceWorkerResult {
  readonly code?: string;
  readonly disposition?: string;
  readonly eventIds?: readonly string[];
}

export function startRaceWorker(
  databasePath: string,
  gate: SharedArrayBuffer,
  suffix: string,
  sharedCommand = false,
): {
  readonly preOpenReady: Promise<void>;
  readonly ready: Promise<void>;
  readonly result: Promise<RaceWorkerResult>;
} {
  const worker = new Worker(new URL("./sqlite-event-store-race-worker.mjs", import.meta.url), {
    execArgv: ["--experimental-strip-types"],
    workerData: {
      commandBytes: sharedCommand ? "same-command" : `command-${suffix}`,
      commandId: sharedCommand ? "cmd-shared" : `cmd-${suffix}`,
      committedAt: "2026-08-06T10:00:00.000Z",
      databasePath,
      eventId: `evt-${suffix}`,
      gate,
    },
  });

  let resolvePreOpenReady!: () => void;
  let resolveReady!: () => void;
  let resolveResult!: (value: RaceWorkerResult) => void;
  let rejectBoth!: (error: Error) => void;
  const preOpenReady = new Promise<void>((resolve, reject) => {
    resolvePreOpenReady = resolve;
    rejectBoth = reject;
  });
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    const previousReject = rejectBoth;
    rejectBoth = (error) => {
      previousReject(error);
      reject(error);
    };
  });
  const result = new Promise<RaceWorkerResult>((resolve, reject) => {
    resolveResult = resolve;
    const previousReject = rejectBoth;
    rejectBoth = (error) => {
      previousReject(error);
      reject(error);
    };
  });
  worker.on("message", (message: unknown) => {
    if (message !== null && typeof message === "object" && "kind" in message) {
      if (message.kind === "READY") {
        resolveReady();
      } else if (message.kind === "PREOPEN_READY") {
        resolvePreOpenReady();
      } else if (message.kind === "RESULT") {
        resolveResult(message as RaceWorkerResult);
      }
    }
  });
  worker.on("error", (error) => rejectBoth(error));
  worker.on("exit", (code) => {
    if (code !== 0) {
      rejectBoth(new Error(`race worker exited with ${code}`));
    }
  });
  return { preOpenReady, ready, result };
}
