import { PREVIEW_DECISIONS } from "./preview-contracts.js";
import type { PreviewDecision } from "./preview-contracts.js";
import type { PreviewProcessHandle } from "./preview-process.js";
import type { PreviewReceiptV1 } from "./preview-receipt-contracts.js";
import { previewReceiptId } from "./preview-receipt-contracts.js";
import { runPreview, stopPreview } from "./preview-runner.js";
import type { PreviewRunRequest, PreviewRunResult, PreviewRunnerConfig } from "./preview-runner.js";

/**
 * WHO OWNS A RUNNING PREVIEW, and who guarantees it stops.
 *
 * `runPreview` starts one and hands back a handle; something has to hold that handle between
 * the start and the operator's decision, which may be minutes later. That is this. Without it
 * the guarantee "the process always stops" would rest on every call site remembering to stop
 * it — and the one that forgets holds the port, so the NEXT preview cannot bind and the failure
 * surfaces nowhere near its cause.
 *
 * FOUR WAYS A PREVIEW ENDS, and all four run the same `stopPreview`:
 *   - APPROVE — the operator accepted it;
 *   - REJECT — the operator rejected it;
 *   - a start that never became answerable — already stopped inside `startPreviewProcess`;
 *   - DAEMON SHUTDOWN — `close()`, which stops every live preview and refuses to start more.
 * A decision and a shutdown that race cannot double-start or resurrect anything: `stop()` is
 * memoised per handle, and the entry is removed from the roster before it is stopped.
 *
 * WHY `close()` DOES NOT THROW ON A STRAGGLER. Its caller is the daemon on its way down. A
 * process that outlived SIGKILL is a real defect, but reporting it by making shutdown throw
 * would take the daemon down harder without killing anything extra. Liveness is asserted by pid
 * in the tests, which is where an escaped process is actually caught.
 */

export interface LivePreview {
  readonly goalId: string;
  readonly pid: number;
  readonly port: number;
  readonly receiptId: string;
  readonly sha: string;
}

export interface PreviewSupervisor {
  /** Every preview this supervisor is currently holding open. */
  readonly active: () => readonly LivePreview[];
  /** Daemon shutdown: stops every live preview and refuses to start any more. */
  readonly close: () => Promise<void>;
  /** APPROVE or REJECT. Both stop the process; the decision does not change that. */
  readonly decide: (receiptId: string, decision: PreviewDecision) => Promise<boolean>;
  readonly start: (request: PreviewRunRequest) => Promise<PreviewRunResult>;
}

interface Entry {
  readonly handle: PreviewProcessHandle;
  readonly receipt: PreviewReceiptV1;
}

export function createPreviewSupervisor(config: PreviewRunnerConfig): PreviewSupervisor {
  const live = new Map<string, Entry>();
  /** Starts already in flight, keyed by the deterministic receipt id they will land under. */
  const starting = new Map<string, Promise<PreviewRunResult>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  const forget = (receiptId: string): Entry | undefined => {
    const entry = live.get(receiptId);
    // Removed BEFORE it is stopped, so a decision and a shutdown racing over the same preview
    // stop it once between them rather than both waiting on it.
    if (entry !== undefined) live.delete(receiptId);
    return entry;
  };

  return Object.freeze({
    active: (): readonly LivePreview[] => [...live.values()].map((entry) => ({
      goalId: entry.receipt.goalId,
      pid: entry.handle.pid,
      port: entry.handle.port,
      receiptId: entry.receipt.receiptId,
      sha: entry.receipt.sha,
    })),

    close: async (): Promise<void> => {
      closed = true;
      closing ??= (async (): Promise<void> => {
        const entries = [...live.keys()].map(forget);
        await Promise.allSettled(entries.map(async (entry) =>
          entry === undefined ? undefined : stopPreview(entry.handle)));
      })();
      await closing;
    },

    decide: async (receiptId: string, decision: PreviewDecision): Promise<boolean> => {
      if (!PREVIEW_DECISIONS.includes(decision)) return false;
      const entry = forget(receiptId);
      if (entry === undefined) return false;
      // APPROVE and REJECT are the same instruction to the PROCESS. What differs is what the
      // graph is told afterwards, which is not this row's to decide.
      await stopPreview(entry.handle);
      return true;
    },

    start: async (request: PreviewRunRequest): Promise<PreviewRunResult> => {
      // CHECK-THEN-ACT, CLOSED. The receipt id is deterministic, so it is known BEFORE the run
      // and can serialise starts for the same revision. Without this, two concurrent calls both
      // pass the landed gate and both spawn a server; the second cannot bind the port the first
      // took, so it refuses PREVIEW_START_TIMEOUT — a preview that failed for no reason the
      // operator could act on. The receipt's idempotence alone does not prevent it: it dedupes
      // the RECORD, and by then two processes have already started.
      const receiptId = previewReceiptId(config.projectId, request.goalId, request.sha);
      const inFlight = starting.get(receiptId);
      if (inFlight !== undefined) return inFlight;
      const run = (async (): Promise<PreviewRunResult> => {
        const result = await runPreview(config, request);
        if (!result.ok) return result;
        if (closed) {
          // The daemon went down between the start and now. Nothing may be left holding a port
          // after `close()` has already swept, so this one stops instead of joining the roster.
          await stopPreview(result.started.handle);
          return result;
        }
        live.set(result.started.receipt.receiptId, {
          handle: result.started.handle, receipt: result.started.receipt,
        });
        return result;
      })();
      starting.set(receiptId, run);
      try {
        return await run;
      } finally {
        starting.delete(receiptId);
      }
    },
  });
}

/** The receipt id a decision names, so a caller does not have to reproduce the hash. */
export function previewReceiptIdFor(
  projectId: string, request: Pick<PreviewRunRequest, "goalId" | "sha">,
): string {
  return previewReceiptId(projectId, request.goalId, request.sha);
}
