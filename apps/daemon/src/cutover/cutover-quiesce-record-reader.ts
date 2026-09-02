import { Buffer } from "node:buffer";
import { closeSync, openSync, readSync } from "node:fs";

import { MAX_JSON_BODY_BYTES } from "@moe/contracts";

/**
 * Bounded acquisition of the live-quiesce evidence artifact.
 *
 * WHY THIS EXISTS WHEN THE CODEC ALREADY HAS A CEILING. `decodeBoundedJsonBytes` refuses a
 * body over `MAX_JSON_BODY_BYTES`, but it can only do so once the whole file is already a
 * `Uint8Array` in this process. Slurping the artifact and then measuring it means the
 * allocation an operator wanted bounded has already happened, and on a file that is not a
 * regular file at all it may never return. This reader is therefore the PRODUCTION AUTHORITY
 * for the byte ceiling on this artifact: it never allocates more than the ceiling plus the
 * one byte that proves the ceiling was passed.
 *
 * WHY THE OVERFLOW REFUSAL CARRIES A LAYER. The reader and the contracts codec emit the SAME
 * `JSON_BODY_LIMIT_EXCEEDED` code, and no input can trip one without the other - the reader
 * caps its own read at the ceiling plus one, so the codec can never observe a body this
 * reader did not admit. The two mechanisms are told apart by the PROVENANCE they produce, not
 * by the code they share, which is what lets a caller's fixture prove that THIS guard
 * refused rather than merely that the system refused. The label is module-local: it is not a
 * refusal code and belongs to no exported roster.
 *
 * WHY THERE IS NO STAT. `statSync` then `readFileSync` reads a size that is stale the instant
 * it returns - the file can grow between the two calls - and sizes an allocation that the
 * ceiling was supposed to prevent. The loop below needs no size at all: it stops when the
 * buffer is full, which is the only fact the decision depends on.
 *
 * WHY THE PATH IS NOT A PARAMETER OF THE POLICY. The caller passes WHICH file, derived by the
 * daemon from its own store root; it can never pass a different LIMIT. A caller-selectable
 * ceiling is a caller-selectable hole.
 */

/**
 * The provenance this reader stamps on its own refusals, identical to the snapshot layer it
 * serves so an operator sees one daemon boundary rather than two.
 *
 * DELIBERATELY NOT EXPORTED. This reader declares no NEW boundary: it reuses the cutover
 * generation boundary that `CUTOVER_GENERATION_SNAPSHOT_LAYER` already declares and that the
 * security lane's boundary roster already names. A second EXPORTED `*_LAYER` constant holding
 * the same string would be a second declaration of one boundary, which is exactly what
 * tests/security/boundary-roster.security.ts scans for and refuses. Callers read the label
 * off the refusal they were handed; nobody needs the symbol.
 */
const CUTOVER_QUIESCE_RECORD_READER_LAYER = "DAEMON_CUTOVER_GENERATION" as const;

/**
 * One byte past the codec's ceiling. Reading the extra byte is what distinguishes a file AT
 * the limit (legal, and the codec must see it) from a file over it, without ever asking how
 * large the file actually is.
 */
const CAPACITY_BYTES = MAX_JSON_BODY_BYTES + 1;

export interface CutoverQuiesceRecordBytes {
  readonly bytes: Uint8Array;
  readonly ok: true;
}

/**
 * The artifact could not be opened or could not be read. Deliberately distinct from the
 * overflow refusal: "no live run wrote one" and "one was written and is too large" are
 * different answers, and the snapshot maps them to different outer codes.
 */
export interface CutoverQuiesceRecordUnreadable {
  readonly detail: string;
  readonly ok: false;
  readonly reason: "UNREADABLE";
}

export interface CutoverQuiesceRecordOverLimit {
  readonly code: "JSON_BODY_LIMIT_EXCEEDED";
  readonly detail: string;
  readonly layer: typeof CUTOVER_QUIESCE_RECORD_READER_LAYER;
  readonly ok: false;
  readonly reason: "OVER_LIMIT";
}

export type CutoverQuiesceRecordRead =
  | CutoverQuiesceRecordBytes
  | CutoverQuiesceRecordOverLimit
  | CutoverQuiesceRecordUnreadable;

function unreadable(detail: string): CutoverQuiesceRecordUnreadable {
  return Object.freeze({ detail, ok: false as const, reason: "UNREADABLE" as const });
}

function overLimit(): CutoverQuiesceRecordOverLimit {
  return Object.freeze({
    code: "JSON_BODY_LIMIT_EXCEEDED" as const,
    detail: `the live-quiesce evidence record exceeds ${MAX_JSON_BODY_BYTES} bytes`,
    layer: CUTOVER_QUIESCE_RECORD_READER_LAYER,
    ok: false as const,
    reason: "OVER_LIMIT" as const,
  });
}

/**
 * Fills `buffer` from `fd` until the buffer is full or the file ends, returning how many
 * bytes were read. A short read is legal on every platform, so the loop is what makes the
 * returned prefix equal the file's leading bytes; each request asks for exactly the remaining
 * capacity, so no request can ever write past the ceiling.
 */
function fillFromDescriptor(fd: number, buffer: Buffer): number {
  let filled = 0;
  while (filled < buffer.byteLength) {
    const read = readSync(fd, buffer, filled, buffer.byteLength - filled, null);
    if (read <= 0) break;
    filled += read;
  }
  return filled;
}

/**
 * Reads the live-quiesce evidence artifact at `path` under a hard byte ceiling.
 *
 * The descriptor is opened ONCE and closed in a `finally` that covers the success path, the
 * overflow refusal and a thrown read error alike - an unclosed handle on win32 keeps the
 * artifact locked against the rename and delete a later run needs. An empty file is a
 * SUCCESSFUL read of zero bytes: whether zero bytes are valid evidence is the decoder's
 * question, not this reader's, and answering it here would give the same artifact two
 * different verdicts depending on which layer saw it first.
 */
export function readCutoverQuiesceRecordBytes(path: string): CutoverQuiesceRecordRead {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return unreadable(`no live-quiesce evidence record could be opened at ${path}`);
  }
  try {
    const buffer = Buffer.allocUnsafe(CAPACITY_BYTES);
    const filled = fillFromDescriptor(fd, buffer);
    // The buffer filled completely, so the file has at least CAPACITY_BYTES bytes and is
    // therefore over the codec's ceiling. Nothing further is read and nothing is resized:
    // the whole point is that the oversized body is never materialised.
    if (filled >= CAPACITY_BYTES) return overLimit();
    // A COPY of exactly the filled prefix, never a subarray: a view would keep the whole
    // CAPACITY_BYTES allocation alive for as long as the caller holds it, and would carry a
    // nonzero byteOffset into a decoder that reads the backing buffer through internal slots.
    const bytes = new Uint8Array(filled);
    bytes.set(buffer.subarray(0, filled));
    return Object.freeze({ bytes, ok: true });
  } catch {
    return unreadable(`the live-quiesce evidence record at ${path} could not be read`);
  } finally {
    // A FAILING CLOSE MUST NOT BECOME A THROWN SNAPSHOT. `closeSync` can raise EIO on some
    // filesystems, and this function is called from a seam that maps outcomes to refusal
    // codes rather than catching exceptions - letting a close failure escape would turn a
    // bounded refusal into an unhandled error at the daemon command layer, which is exactly
    // the fail-open the caller's codes exist to prevent. The read's answer already stands and
    // nothing an operator can act on is lost.
    try {
      closeSync(fd);
    } catch { /* the descriptor is unusable either way; the answer above is unaffected */ }
  }
}
