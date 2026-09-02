import { Buffer } from "node:buffer";
import {
  fstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_JSON_BODY_BYTES } from "@moe/contracts";
import { describe, expect, it, vi } from "vitest";

import { readCutoverQuiesceRecordBytes } from "./cutover-quiesce-record-reader.js";

/**
 * task-642df965 - the bounded acquisition of the live-quiesce evidence artifact.
 *
 * WHAT IS UNDER TEST IS THE ALLOCATION CEILING, NOT "IT REFUSED". `decodeBoundedJsonBytes`
 * already refuses `JSON_BODY_LIMIT_EXCEEDED` for a body over the limit, but it can only do so
 * AFTER the whole file has been read into memory. This reader exists so the bytes are never
 * allocated in the first place, so every arm here measures what the reader ASKED THE OS FOR,
 * not merely what it answered.
 *
 * THE SPIES OBSERVE, THEY DO NOT SUBSTITUTE. The `node:fs` mock spreads the real module and
 * wraps four functions with pass-through recorders that DELEGATE to the genuine
 * implementations, so the production reader runs against real files and real descriptors. The
 * single exception is `failReadOnce`, an explicit ONE-SHOT fault injected at the OS boundary
 * (never at the module under test) to reach the throw-after-open path on a host where opening
 * a directory fails outright; it is armed per-arm and named in that arm's comment.
 */

const CAPACITY = MAX_JSON_BODY_BYTES + 1;

interface ReadCall {
  readonly bufferBytes: number;
  readonly fd: number;
  readonly length: number;
  readonly offset: number;
  readonly returned: number;
}

const spy = vi.hoisted(() => ({
  closes: [] as number[],
  failCloseOnce: false,
  failReadOnce: false,
  opens: [] as number[],
  readFileCalls: 0,
  reads: [] as ReadCall[],
  recording: false,
  statCalls: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const openSync = ((...args: Parameters<typeof actual.openSync>): number => {
    const fd = actual.openSync(...args);
    if (spy.recording) spy.opens.push(fd);
    return fd;
  }) as typeof actual.openSync;
  const closeSync = ((fd: number): void => {
    if (spy.recording) spy.closes.push(fd);
    if (spy.recording && spy.failCloseOnce) {
      spy.failCloseOnce = false;
      actual.closeSync(fd);
      const error: NodeJS.ErrnoException = new Error("injected OS-boundary close fault");
      error.code = "EIO";
      throw error;
    }
    actual.closeSync(fd);
  }) as typeof actual.closeSync;
  const readSync = ((
    fd: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
  ): number => {
    if (spy.recording && spy.failReadOnce) {
      spy.failReadOnce = false;
      const error: NodeJS.ErrnoException = new Error("injected OS-boundary read fault");
      error.code = "EIO";
      throw error;
    }
    const returned = actual.readSync(fd, buffer, offset, length, position);
    if (spy.recording) {
      spy.reads.push({ bufferBytes: buffer.byteLength, fd, length, offset, returned });
    }
    return returned;
  }) as typeof actual.readSync;
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    if (spy.recording) spy.readFileCalls += 1;
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync;
  const statSync = ((...args: Parameters<typeof actual.statSync>) => {
    if (spy.recording) spy.statCalls += 1;
    return actual.statSync(...args);
  }) as typeof actual.statSync;
  const fstatSync = ((...args: Parameters<typeof actual.fstatSync>) => {
    if (spy.recording) spy.statCalls += 1;
    return actual.fstatSync(...args);
  }) as typeof actual.fstatSync;
  const patched = {
    ...actual, closeSync, fstatSync, openSync, readFileSync, readSync, statSync,
  };
  return { ...patched, default: patched };
});

function resetSpy(): void {
  spy.closes.length = 0;
  spy.opens.length = 0;
  spy.reads.length = 0;
  spy.readFileCalls = 0;
  spy.statCalls = 0;
}

/** Records ONLY the production call, so the arm's own fixture writes are never counted. */
function observe<T>(run: () => T): T {
  resetSpy();
  spy.recording = true;
  try {
    return run();
  } finally {
    spy.recording = false;
  }
}

function withDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "moe-quiesce-reader-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

/** A file of EXACTLY `size` bytes. Size is derived from the contracts constant, never typed. */
function writeSized(path: string, size: number): void {
  writeFileSync(path, Buffer.alloc(size, 0x61));
}

/** Every descriptor `openSync` handed out was handed back to `closeSync`. */
function expectEveryDescriptorClosed(): void {
  for (const fd of spy.opens) expect(spy.closes).toContain(fd);
  expect(spy.closes.length).toBeGreaterThanOrEqual(spy.opens.length);
}

describe("the live-quiesce record reader bounds what it acquires", () => {
  it("reads an EMPTY file successfully: emptiness is the decoder's business, not the reader's", () => {
    withDirectory((directory) => {
      const path = join(directory, "evidence.json");
      writeSized(path, 0);
      const answer = observe(() => readCutoverQuiesceRecordBytes(path));

      expect(answer.ok).toBe(true);
      expect(answer.ok ? answer.bytes.byteLength : -1).toBe(0);
      expectEveryDescriptorClosed();
      expect(spy.opens).toHaveLength(1);
    });
  });

  it("returns the file's bytes BYTE-IDENTICALLY, including bytes that are not valid UTF-8", () => {
    withDirectory((directory) => {
      const path = join(directory, "evidence.json");
      // 0xff/0xfe are not legal UTF-8: a reader that round-tripped through a string would
      // return replacement characters here rather than the bytes on disk.
      const written = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0xfe, 0x7d]);
      writeFileSync(path, written);
      const answer = observe(() => readCutoverQuiesceRecordBytes(path));

      expect(answer.ok).toBe(true);
      const bytes = answer.ok ? answer.bytes : new Uint8Array();
      expect(bytes.byteLength).toBe(written.byteLength);
      expect(Buffer.compare(Buffer.from(bytes), written)).toBe(0);
      expectEveryDescriptorClosed();
    });
  });

  it("reads a file of EXACTLY MAX_JSON_BODY_BYTES and returns exactly that many bytes", () => {
    withDirectory((directory) => {
      const path = join(directory, "evidence.json");
      writeSized(path, MAX_JSON_BODY_BYTES);
      const answer = observe(() => readCutoverQuiesceRecordBytes(path));

      // AT the limit is ACCEPTED. Without this arm an off-by-one that refused the largest
      // legal record would pass every other assertion in this file.
      expect(answer.ok).toBe(true);
      expect(answer.ok ? answer.bytes.byteLength : -1).toBe(MAX_JSON_BODY_BYTES);
      expectEveryDescriptorClosed();
    });
  });

  it("REFUSES one byte over the limit, naming the daemon reader as the refusing mechanism", () => {
    withDirectory((directory) => {
      const path = join(directory, "evidence.json");
      writeSized(path, MAX_JSON_BODY_BYTES + 1);
      const answer = observe(() => readCutoverQuiesceRecordBytes(path));

      expect(answer.ok).toBe(false);
      if (answer.ok) throw new Error("unreachable");
      expect(answer.reason).toBe("OVER_LIMIT");
      if (answer.reason !== "OVER_LIMIT") throw new Error(`got ${answer.reason}`);
      // The code is SHARED with the contracts codec; the LAYER is what names who answered.
      // Both sides are LITERALS here - the reader's layer constant is module-local and is
      // deliberately not imported, so no single production edit can move expected and actual
      // together the way an imported constant would.
      expect(answer.code).toBe("JSON_BODY_LIMIT_EXCEEDED");
      expect(answer.layer).toBe("DAEMON_CUTOVER_GENERATION");
      expectEveryDescriptorClosed();
    });
  });

  it("never asks the OS for more than MAX_JSON_BODY_BYTES + 1 on an over-limit file", () => {
    withDirectory((directory) => {
      const path = join(directory, "evidence.json");
      // Four times the ceiling: a stat-then-readFileSync reader allocates all of it.
      writeSized(path, CAPACITY * 4);
      const answer = observe(() => readCutoverQuiesceRecordBytes(path));
      expect(answer.ok).toBe(false);

      // NON-VACUITY FIRST: a reader that used readFileSync would make every bound below
      // trivially true by never calling readSync at all.
      expect(spy.reads.length).toBeGreaterThan(0);
      expect(spy.readFileCalls).toBe(0);
      // A pre-stat is forbidden by construction, not merely unnecessary: the size it reads is
      // stale the instant it returns, and the allocation it sizes has already been decided.
      expect(spy.statCalls).toBe(0);

      const requested = spy.reads.reduce((total, call) => total + call.length, 0);
      expect(requested).toBeLessThanOrEqual(CAPACITY);
      expect(Math.max(...spy.reads.map((call) => call.length))).toBeLessThanOrEqual(CAPACITY);
      // The union bound: no request may write past the ceiling, whatever the retry pattern.
      expect(Math.max(...spy.reads.map((call) => call.offset + call.length)))
        .toBeLessThanOrEqual(CAPACITY);
      // The destination buffer itself is capped, so the allocation never happened either.
      expect(Math.max(...spy.reads.map((call) => call.bufferBytes))).toBeLessThanOrEqual(CAPACITY);
      expect(spy.opens).toHaveLength(1);
      expectEveryDescriptorClosed();
    });
  });

  it("refuses a MISSING file as UNREADABLE and opens no descriptor to leak", () => {
    withDirectory((directory) => {
      const answer = observe(
        () => readCutoverQuiesceRecordBytes(join(directory, "absent.json")),
      );

      expect(answer.ok).toBe(false);
      if (answer.ok) throw new Error("unreachable");
      expect(answer.reason).toBe("UNREADABLE");
      expect(spy.opens).toHaveLength(0);
      expectEveryDescriptorClosed();
    });
  });

  it("refuses a DIRECTORY as UNREADABLE and closes any descriptor it did open", () => {
    withDirectory((directory) => {
      const path = join(directory, "evidence.json");
      mkdirSync(path);
      // A real cross-platform error path, no injection: POSIX opens the directory and fails
      // in readSync, Windows fails in openSync. Either way nothing may leak.
      const answer = observe(() => readCutoverQuiesceRecordBytes(path));

      expect(answer.ok).toBe(false);
      if (answer.ok) throw new Error("unreachable");
      expect(answer.reason).toBe("UNREADABLE");
      expectEveryDescriptorClosed();
    });
  });

  it("closes the descriptor when the read THROWS after the open succeeded", () => {
    withDirectory((directory) => {
      const path = join(directory, "evidence.json");
      writeSized(path, 64);
      // ONE-SHOT fault at the OS boundary. The module under test is fully real; only the
      // first readSync of this arm fails, which is the only way to reach the throw-after-open
      // path on a host where opening a directory fails outright.
      const answer = observe(() => {
        spy.failReadOnce = true;
        return readCutoverQuiesceRecordBytes(path);
      });
      expect(spy.failReadOnce).toBe(false);

      expect(answer.ok).toBe(false);
      if (answer.ok) throw new Error("unreachable");
      expect(answer.reason).toBe("UNREADABLE");
      // The open DID happen, so this arm really exercises the leak path rather than the
      // open-failed path the missing-file arm already covers.
      expect(spy.opens).toHaveLength(1);
      expect(spy.closes).toContain(spy.opens[0]);
    });
  });

  it("returns a bounded answer, never a THROW, when closing the descriptor itself fails", () => {
    withDirectory((directory) => {
      const path = join(directory, "evidence.json");
      writeFileSync(path, "{}", "utf8");
      // ONE-SHOT close fault at the OS boundary; the real descriptor is closed first, so
      // nothing leaks. This is TOTALITY, not cleanup: this reader is called from a seam that
      // maps outcomes onto refusal codes and does NOT catch, so an escaping close error would
      // surface as an unhandled exception where a refusal is contracted.
      const answer = observe(() => {
        spy.failCloseOnce = true;
        return readCutoverQuiesceRecordBytes(path);
      });
      expect(spy.failCloseOnce).toBe(false);
      // The fault really fired - otherwise this arm proves nothing about the swallow.
      expect(spy.closes).toHaveLength(1);
      // The read's own answer STANDS. A close failure changes nothing an operator can act on.
      expect(answer.ok).toBe(true);
      expect(answer.ok ? answer.bytes.byteLength : -1).toBe(2);
    });
  });

  it("releases the EXACT descriptor on refusal, so the artifact can be renamed and deleted", () => {
    let executed = 0;
    withDirectory((directory) => {
      const path = join(directory, "evidence.json");
      writeSized(path, MAX_JSON_BODY_BYTES + 1);
      const answer = observe(() => readCutoverQuiesceRecordBytes(path));
      expect(answer.ok).toBe(false);
      expect(spy.opens).toHaveLength(1);

      // THE DISCRIMINATING PROOF, and it is not the rename below. A descriptor that is
      // really gone makes the next syscall against its number fail with EBADF. Read
      // SYNCHRONOUSLY here, before anything else in this process can be handed the same
      // number, so a reused fd cannot fake a pass or a failure.
      const fd = spy.opens[0] as number;
      let released: string | undefined;
      try {
        fstatSync(fd);
      } catch (error) {
        released = (error as NodeJS.ErrnoException).code;
      }
      expect(released).toBe("EBADF");

      if (process.platform !== "win32") return;
      // The OPERATIONAL consequence on Windows, kept because it is what an operator sees -
      // but recorded honestly as NON-discriminating: MEASURED under the omit-finally drill,
      // these two still succeed with the handle leaked, because libuv opens files with
      // FILE_SHARE_DELETE. The EBADF assertion above is what actually reds.
      const moved = join(directory, "evidence.moved.json");
      renameSync(path, moved);
      unlinkSync(moved);
      executed += 1;
    });
    if (process.platform === "win32") {
      // Asserted EXECUTED, not skipped: a guarded arm that silently returns is green forever.
      expect(executed).toBeGreaterThan(0);
    } else {
      expect(executed).toBe(0);
    }
  });
});
