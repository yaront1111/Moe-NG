/**
 * The durability primitive's own contract, tested through the production
 * function rather than through the anchor protocol that composes it.
 *
 * `FileHandle.write` resolves with a `bytesWritten` count and is permitted to
 * write FEWER bytes than requested. A primitive that discards that count cannot
 * tell a complete write from a truncated one, and `publishFileAtomically` then
 * publishes the truncated bytes atomically — the atomicity holds and the
 * content is wrong, which is the worst combination. These cases pin the count.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  digestBytes,
  persistFileDurably,
  publishFileAtomically,
  readBackMatches,
} from "./recovery-anchor-fs.js";
import type { DurableWriteOpener } from "./recovery-anchor-fs.js";

const encoder = new TextEncoder();
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `moe-anchor-fs-${label}-`));
  directories.push(directory);
  return directory;
}

interface WriteAttempt {
  readonly accepted: number;
  readonly length: number;
  readonly offset: number;
}

interface WriteRecorder {
  readonly attempts: WriteAttempt[];
  closes: number;
  /** Bytes on the file at each `sync()`, so a flush of a PARTIAL file is visible. */
  readonly syncedAt: number[];
}

/**
 * Wraps a REAL handle and truncates each write to the scheduled size, so the
 * bytes on disk are the bytes the production loop actually managed to write.
 * A schedule entry past the end means "accept the whole remainder".
 */
function chunkingOpener(
  schedule: readonly number[],
  recorder: WriteRecorder,
): DurableWriteOpener {
  return async (path: string) => {
    const handle = await open(path, "w");
    let call = 0;
    let written = 0;
    return {
      close: async () => {
        recorder.closes += 1;
        await handle.close();
      },
      sync: async () => {
        recorder.syncedAt.push(written);
        await handle.sync();
      },
      write: async (data: Uint8Array, offset: number, length: number) => {
        const allowed = schedule[call] ?? length;
        call += 1;
        const { bytesWritten } = await handle.write(data, offset, Math.min(allowed, length));
        recorder.attempts.push({ accepted: bytesWritten, length, offset });
        written += bytesWritten;
        return { bytesWritten };
      },
    };
  };
}

function recorder(): WriteRecorder {
  return { attempts: [], closes: 0, syncedAt: [] };
}

/**
 * Reports the thrown failure's stable code and layer. A resolved call is itself
 * the defect under test, so it fails here with that stated plainly rather than
 * surfacing as an undefined-property mismatch.
 */
async function refusalOf(operation: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await operation;
  } catch (error) {
    const failure = error as { code?: unknown; layer?: unknown };
    return { code: failure.code, layer: failure.layer };
  }
  throw new Error("expected the durable write to refuse, but it reported success");
}

/** Far above the ONE attempt a bounded loop makes, far below what exhausts memory. */
const STALLED_PORT_ATTEMPT_CAP = 64;

/**
 * NEVER makes progress, on any attempt. `chunkingOpener` falls back to "accept
 * the remainder" once its schedule runs out, so it models a port that stalls
 * ONCE; only this one models a port that is permanently stuck — the shape an
 * unbounded completion loop would spin on forever.
 */
function stalledOpener(recorded: WriteRecorder): DurableWriteOpener {
  return async (_path: string) => ({
    close: async () => {
      recorded.closes += 1;
    },
    sync: async () => {
      recorded.syncedAt.push(-1);
    },
    write: async (_data: Uint8Array, offset: number, length: number) => {
      // The PORT carries the bound, not the test runner. An unbounded
      // production loop would otherwise spin until the worker dies of memory
      // exhaustion, and a crashed worker reports no per-test verdict at all.
      if (recorded.attempts.length >= STALLED_PORT_ATTEMPT_CAP) {
        throw new Error(
          `the completion loop retried a stalled port ${String(STALLED_PORT_ATTEMPT_CAP)} times; it is not bounded`,
        );
      }
      recorded.attempts.push({ accepted: 0, length, offset });
      return { bytesWritten: 0 };
    },
  });
}

/** Reports MORE bytes than it was offered; a real handle cannot, so it is synthesised. */
function overReportingOpener(recorded: WriteRecorder): DurableWriteOpener {
  return async (_path: string) => ({
    close: async () => {
      recorded.closes += 1;
    },
    sync: async () => {
      recorded.syncedAt.push(-1);
    },
    write: async (_data: Uint8Array, offset: number, length: number) => {
      recorded.attempts.push({ accepted: length + 1, length, offset });
      return { bytesWritten: length + 1 };
    },
  });
}

const WRITE_INCOMPLETE = Object.freeze({
  code: "RECOVERY_ANCHOR_WRITE_INCOMPLETE",
  layer: "RECOVERY_ANCHOR",
});

describe("persistFileDurably short writes", () => {
  it("refuses with RECOVERY_ANCHOR_WRITE_INCOMPLETE when the payload cannot be fully written", async () => {
    const path = join(temporaryDirectory("short"), "payload.bin");
    const observed = recorder();
    // One byte lands, then the port stops making progress, so no amount of
    // retrying completes the payload.
    const opener = chunkingOpener([1, 0], observed);

    expect(await refusalOf(persistFileDurably(path, encoder.encode("SEVEN__"), opener))).toEqual(
      WRITE_INCOMPLETE,
    );
    expect(readFileSync(path).byteLength).toBeLessThan(7);
  });

  it("terminates on a port that reports no progress at all instead of looping", async () => {
    const path = join(temporaryDirectory("stalled"), "payload.bin");
    const observed = recorder();

    const opener = chunkingOpener([0], observed);

    expect(await refusalOf(persistFileDurably(path, encoder.encode("SEVEN__"), opener))).toEqual(
      WRITE_INCOMPLETE,
    );

    // Exactly ONE attempt: the bound is that a chunk must ADVANCE, so a
    // zero-progress port is refused on its first chunk rather than retried.
    expect(observed.attempts.length).toBe(1);
    expect(observed.attempts[0]).toEqual({ accepted: 0, length: 7, offset: 0 });
  });

  it("terminates on a PERMANENTLY stalled port rather than retrying forever", async () => {
    const path = join(temporaryDirectory("stuck"), "payload.bin");
    const observed = recorder();

    expect(
      await refusalOf(persistFileDurably(path, encoder.encode("SEVEN__"), stalledOpener(observed))),
    ).toEqual(WRITE_INCOMPLETE);

    // The bound is "a chunk must ADVANCE", so a port that never advances is
    // refused on its FIRST chunk. Weakening that guard makes this case spin,
    // and this assertion is what turns the spin into a failure.
    expect(observed.attempts.length).toBe(1);
    expect(observed.closes).toBe(1);
    expect(observed.syncedAt).toEqual([]);
  });

  it("refuses a port claiming MORE bytes written than it was offered", async () => {
    const observed = recorder();
    const path = join(temporaryDirectory("over"), "payload.bin");

    expect(
      await refusalOf(persistFileDurably(path, encoder.encode("SEVEN__"), overReportingOpener(observed))),
    ).toEqual(WRITE_INCOMPLETE);
    expect(observed.attempts.length).toBe(1);
  });

  it("closes the handle and flushes nothing on the refusal path", async () => {
    const path = join(temporaryDirectory("descriptor"), "payload.bin");
    const observed = recorder();

    await refusalOf(persistFileDurably(path, encoder.encode("SEVEN__"), chunkingOpener([2, 0], observed)));

    // Observed at the seam, not inferred: the descriptor is released exactly
    // once, and a PARTIAL file is never flushed as though it were evidence.
    expect(observed.closes).toBe(1);
    expect(observed.syncedAt).toEqual([]);
  });
});

/**
 * The completion sweep: every payload length crossed with every chunk schedule.
 * A schedule entry past its end means "accept the whole remainder", so the same
 * table produces single-write, multi-write and empty-payload deliveries.
 */
const COMPLETION_PAYLOADS = Object.freeze(["", "A", "SEVEN__", "0123456789ABCDEF"] as const);
const COMPLETION_SCHEDULES = Object.freeze([[1], [1, 2, 3], [3, 1], []] as const);

interface CompletionCase {
  readonly label: string;
  readonly payload: Uint8Array;
  readonly schedule: readonly number[];
}

function completionCases(): readonly CompletionCase[] {
  const cases: CompletionCase[] = [];
  for (const text of COMPLETION_PAYLOADS) {
    for (const schedule of COMPLETION_SCHEDULES) {
      cases.push({
        label: `${String(text.length)}-bytes-via-[${schedule.join(",")}]`,
        payload: encoder.encode(text),
        schedule,
      });
    }
  }
  return cases;
}

const COMPLETION_CASES = completionCases();
/**
 * Hand-written, NOT derived from the table: a sweep that silently produced zero
 * cases would pass every assertion inside it. The empty and multi-chunk counts
 * are pinned separately because DoD 4 names those two shapes specifically, and
 * a table edit that dropped either would otherwise leave the total intact.
 */
const EXPECTED_CASES = 16;
const EXPECTED_EMPTY_PAYLOAD_CASES = 4;
const EXPECTED_MULTI_CHUNK_CASES = 6;

describe("persistFileDurably write completion", () => {
  it("generated exactly the completion cases this suite claims to sweep", () => {
    expect(COMPLETION_CASES.length).toBe(EXPECTED_CASES);
    expect(COMPLETION_CASES.filter((one) => one.payload.byteLength === 0).length).toBe(
      EXPECTED_EMPTY_PAYLOAD_CASES,
    );
    expect(new Set(COMPLETION_CASES.map((one) => one.label)).size).toBe(EXPECTED_CASES);
  });

  it("writes every byte across each schedule and flushes only once complete", async () => {
    const root = temporaryDirectory("completion");
    let multiChunk = 0;

    for (const [index, one] of COMPLETION_CASES.entries()) {
      const path = join(root, `case-${String(index)}.bin`);
      const observed = recorder();

      await persistFileDurably(path, one.payload, chunkingOpener(one.schedule, observed));

      const written = readFileSync(path);
      expect(new Uint8Array(written), `${one.label} content`).toEqual(one.payload);
      // The flush happens ONCE, and only with the whole payload on the file. A
      // sync recorded at any smaller size is a flushed truncation.
      expect(observed.syncedAt, `${one.label} flush`).toEqual([one.payload.byteLength]);
      expect(observed.closes, `${one.label} close`).toBe(1);

      // The offset advances by exactly the bytes already proven written, so a
      // retry completes the remainder instead of rewriting from zero.
      let expectedOffset = 0;
      for (const attempt of observed.attempts) {
        expect(attempt.offset, `${one.label} offset`).toBe(expectedOffset);
        expect(attempt.length, `${one.label} remaining`).toBe(
          one.payload.byteLength - expectedOffset,
        );
        expectedOffset += attempt.accepted;
      }
      expect(expectedOffset, `${one.label} total`).toBe(one.payload.byteLength);

      // An empty payload needs no write at all, and must not manufacture one.
      if (one.payload.byteLength === 0) expect(observed.attempts.length).toBe(0);
      if (observed.attempts.length > 1) multiChunk += 1;
    }

    // Without this the sweep could satisfy every assertion above using only
    // single-write deliveries, testing nothing about completing a short write.
    expect(multiChunk).toBe(EXPECTED_MULTI_CHUNK_CASES);
  });
});

/**
 * Reports the full count while writing NOTHING. The file is real, so the
 * publish's rename still works — which is exactly how a primitive that trusts
 * `bytesWritten` blindly would behave against a lying device.
 */
function lyingOpener(): DurableWriteOpener {
  return async (path: string) => {
    const handle = await open(path, "w");
    return {
      close: () => handle.close(),
      sync: () => handle.sync(),
      write: async (_data: Uint8Array, _offset: number, length: number) => ({
        bytesWritten: length,
      }),
    };
  };
}

/**
 * The reason this defect mattered more than a single discarded return value:
 * `publishFileAtomically` writes the staging file through `persistFileDurably`
 * and then RENAMES it into place. A truncated staging file is therefore
 * published atomically as though complete — the atomicity guarantee holds and
 * the content is wrong, which is the worst combination available.
 */
describe("publishFileAtomically composes the proven write", () => {
  it("leaves the previous bytes published when the payload cannot be fully written", async () => {
    const target = join(temporaryDirectory("publish-short"), "published.json");
    writeFileSync(target, "PREVIOUS");
    const observed = recorder();

    expect(
      await refusalOf(
        publishFileAtomically(target, encoder.encode("NEXT-PAYLOAD"), chunkingOpener([1, 0], observed)),
      ),
    ).toEqual(WRITE_INCOMPLETE);

    expect(readFileSync(target, "utf8")).toBe("PREVIOUS");
    expect(existsSync(`${target}.staging`)).toBe(false);
    expect(observed.closes).toBe(1);
  });

  it("publishes the whole payload when the write completes across several chunks", async () => {
    const target = join(temporaryDirectory("publish-chunked"), "published.json");
    writeFileSync(target, "PREVIOUS");
    const payload = encoder.encode("0123456789ABCDEF");
    const observed = recorder();

    await publishFileAtomically(target, payload, chunkingOpener([1, 2, 3], observed));

    expect(new Uint8Array(readFileSync(target))).toEqual(payload);
    // The delivery really was chunked, so this case is not a single-write
    // publish wearing a multi-chunk label.
    expect(observed.attempts.length).toBeGreaterThan(1);
  });

  it("still leaves read-back to the caller: the publish never re-reads what it wrote", async () => {
    const target = join(temporaryDirectory("publish-readback"), "published.json");
    const payload = encoder.encode("0123456789ABCDEF");

    // A port that LIES about bytesWritten cannot be caught by counting bytes,
    // and the publish resolves. That is the boundary of this fix, and it is
    // why `readBackMatches` remains a separate check a caller must invoke.
    await publishFileAtomically(target, payload, lyingOpener());

    expect(readFileSync(target).byteLength).toBe(0);
    expect(await readBackMatches(target, digestBytes(payload))).toBe(false);
    expect(await readBackMatches(target, digestBytes(new Uint8Array(0)))).toBe(true);
  });
});
