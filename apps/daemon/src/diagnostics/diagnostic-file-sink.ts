import {
  appendFileSync as nodeAppend, mkdirSync as nodeMkdir, renameSync as nodeRename,
  rmSync as nodeRm, statSync as nodeStat,
} from "node:fs";
import { join } from "node:path";

import { describeThrown, encodeDiagnosticLine } from "@moe/contracts";
import type { DiagnosticRecord, DiagnosticSink, DiagnosticThrown } from "@moe/contracts";

/**
 * THE DURABLE HALF OF THE DIAGNOSTIC PLANE: one JSON line per record, appended to a rotating
 * file under the project's own `.moe/logs`.
 *
 * `.moe/logs` has existed and stayed EMPTY for the life of this repository. `.moe/activity.log`
 * beside it is a DOMAIN event ledger — proposals, decisions, state — and answers what the board
 * did, never what the process failed at. This file is the other question.
 *
 * APPEND PER RECORD, HANDLE HELD BY NO ONE. Opening once and holding an fd is faster and wrong
 * here: the process that most needs its last line on disk is the one about to die, and on
 * Windows a held handle is also what makes a rotation fail with EBUSY. Diagnostic volume is
 * bounded by construction — this is not a stdout tee — so the syscall per line is affordable.
 *
 * TOTAL, AND HONEST ABOUT ITS OWN DEATH. Every path is fenced: a diagnostic sink that throws on
 * a full disk would crash the failure path it was installed to explain. But silence is its own
 * defect, so the FIRST failure is reported once through `onFailure` with the errno code that
 * says whether the operator is out of space, out of permission, or out of handles — and after a
 * short run of failures the sink disables itself rather than paying a doomed syscall per record.
 */

export const DIAGNOSTIC_LOG_FILENAME = "moe-diagnostics.log";
export const DIAGNOSTIC_SINK_WRITE_FAILED = "DIAGNOSTIC_SINK_WRITE_FAILED" as const;

const DEFAULT_MAX_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_GENERATIONS = 5;
/** Consecutive write failures tolerated before the sink stops trying. */
const FAILURE_BUDGET = 5;

/** The filesystem this sink uses, INJECTED so a test can refuse a write without a real disk. */
export interface DiagnosticFileSystem {
  appendFileSync(path: string, data: string): void;
  mkdirSync(path: string): void;
  renameSync(from: string, to: string): void;
  rmSync(path: string): void;
  statSync(path: string): { readonly size: number };
}

export interface DiagnosticFileSinkOptions {
  readonly directory: string;
  readonly fileName?: string;
  readonly fs?: DiagnosticFileSystem;
  /** Rotated generations kept beside the live file. */
  readonly generations?: number;
  readonly maxBytes?: number;
  /** Called AT MOST ONCE, on the first failure, so a dead sink is not a silent one. */
  readonly onFailure?: (reason: string, thrown: DiagnosticThrown) => void;
  /** Literal secret values scrubbed from every line. */
  readonly secrets?: readonly string[];
}

export interface DiagnosticFileSink extends DiagnosticSink {
  close(): void;
  /** True once the sink has given up writing. */
  disabled(): boolean;
}

const NODE_FS: DiagnosticFileSystem = Object.freeze({
  appendFileSync: (path: string, data: string): void => { nodeAppend(path, data, "utf8"); },
  mkdirSync: (path: string): void => { nodeMkdir(path, { recursive: true }); },
  renameSync: (from: string, to: string): void => { nodeRename(from, to); },
  rmSync: (path: string): void => { nodeRm(path, { force: true }); },
  statSync: (path: string): { readonly size: number } => ({ size: nodeStat(path).size }),
});

export function createDiagnosticFileSink(
  options: DiagnosticFileSinkOptions,
): DiagnosticFileSink {
  const fs = options.fs ?? NODE_FS;
  const fileName = options.fileName ?? DIAGNOSTIC_LOG_FILENAME;
  const livePath = join(options.directory, fileName);
  const maxBytes = Math.max(1_024, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const generations = Math.max(0, options.generations ?? DEFAULT_GENERATIONS);
  const secrets = options.secrets ?? [];

  let prepared = false;
  let failures = 0;
  let reported = false;
  let bytes: number | null = null;

  const fail = (thrown: unknown): void => {
    failures += 1;
    if (reported) return;
    reported = true;
    try {
      options.onFailure?.(DIAGNOSTIC_SINK_WRITE_FAILED, describeThrown(thrown));
    } catch {
      // The failure reporter is host code. If it throws too there is nowhere left to say so.
    }
  };

  const prepare = (): void => {
    if (prepared) return;
    prepared = true;
    try {
      fs.mkdirSync(options.directory);
    } catch (error) {
      // A directory that already exists is the ordinary case and `recursive` swallows it; a
      // genuine refusal (EACCES, EROFS) surfaces on the first append instead, where the errno
      // reaches the operator with the write it actually blocked.
      void error;
    }
    try {
      bytes = fs.statSync(livePath).size;
    } catch {
      // Absent is the ordinary case on a first start, not a fault.
      bytes = 0;
    }
  };

  /** Shift the generations down by one and start a new live file. */
  const rotate = (): void => {
    try {
      if (generations === 0) {
        fs.rmSync(livePath);
      } else {
        const oldest = `${livePath}.${String(generations)}`;
        try {
          fs.rmSync(oldest);
        } catch {
          // Nothing to drop, or something else holds it; the rename below decides the outcome.
        }
        for (let at = generations - 1; at >= 1; at -= 1) {
          try {
            fs.renameSync(`${livePath}.${String(at)}`, `${livePath}.${String(at + 1)}`);
          } catch {
            // A generation that does not exist yet, which is every one of them on a first
            // rotation. Never fatal: the live file's own rename below is the one that matters.
          }
        }
        fs.renameSync(livePath, `${livePath}.1`);
      }
      bytes = 0;
    } catch (error) {
      // ROTATION IS OPTIONAL, WRITING IS NOT. On Windows a reader holding the rotated file makes
      // this EBUSY; the sink keeps appending to an oversized live file rather than losing lines.
      // The bound is re-armed for the next record so a transient hold recovers by itself.
      void error;
      bytes = Math.floor(maxBytes / 2);
    }
  };

  const emit = (record: DiagnosticRecord): void => {
    if (failures >= FAILURE_BUDGET) return;
    try {
      prepare();
      const line = encodeDiagnosticLine(record, { secrets });
      const width = Buffer.byteLength(line, "utf8");
      if (bytes !== null && bytes + width > maxBytes && bytes > 0) rotate();
      fs.appendFileSync(livePath, line);
      bytes = (bytes ?? 0) + width;
      // A run of failures ending in a success was transient; only consecutive failures disable.
      failures = 0;
    } catch (error) {
      fail(error);
    }
  };

  return Object.freeze({
    close: (): void => {
      // Nothing is held open: every record was already durable when `emit` returned. `close`
      // exists so callers can treat this like every other owned resource in the daemon.
      bytes = null;
      prepared = false;
    },
    disabled: (): boolean => failures >= FAILURE_BUDGET,
    emit,
  });
}
