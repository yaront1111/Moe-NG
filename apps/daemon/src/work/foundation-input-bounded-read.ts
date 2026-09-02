import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export interface FoundationInputReadStat {
  readonly isFile: () => boolean;
  readonly size: number;
}

/** Narrow seam for deterministic hostile growth and close-on-fault tests. */
export interface FoundationInputReadOps {
  readonly close: (handle: number) => void;
  readonly fstat: (handle: number) => FoundationInputReadStat;
  readonly open: (path: string) => number;
  readonly read: (
    handle: number, buffer: Buffer, offset: number, length: number,
  ) => number;
}

export type BoundedFoundationInputRead =
  | Readonly<{ readonly bytes: Buffer; readonly kind: "BYTES" }>
  | Readonly<{ readonly kind: "NOT_FILE" }>
  | Readonly<{ readonly kind: "TOO_LARGE" }>;

const NODE_READ_OPS: FoundationInputReadOps = Object.freeze({
  close: (handle: number): void => closeSync(handle),
  fstat: (handle: number): FoundationInputReadStat => {
    const stat = fstatSync(handle);
    return Object.freeze({ isFile: (): boolean => stat.isFile(), size: stat.size });
  },
  open: (path: string): number => openSync(path, "r"),
  read: (handle: number, buffer: Buffer, offset: number, length: number): number =>
    readSync(handle, buffer, offset, length, null),
});

/**
 * Reads from one already-opened file identity and asks the OS for at most
 * `maxBytes + 1`. The extra byte distinguishes an exact-limit file from a file
 * that grew after `fstat` without ever allocating or reading the grown tail.
 */
export function readBoundedFoundationInputFile(
  path: string,
  maxBytes: number,
  ops: FoundationInputReadOps = NODE_READ_OPS,
): BoundedFoundationInputRead {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("foundation input byte limit must be a non-negative safe integer");
  }
  const handle = ops.open(path);
  try {
    const stat = ops.fstat(handle);
    if (!stat.isFile()) return Object.freeze({ kind: "NOT_FILE" as const });
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
      throw new Error("foundation input file size is invalid");
    }
    if (stat.size > maxBytes) return Object.freeze({ kind: "TOO_LARGE" as const });

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const remaining = buffer.byteLength - offset;
      const count = ops.read(handle, buffer, offset, remaining);
      if (!Number.isSafeInteger(count) || count < 0 || count > remaining) {
        throw new Error("foundation input read returned an invalid byte count");
      }
      if (count === 0) break;
      offset += count;
    }
    if (offset > maxBytes) return Object.freeze({ kind: "TOO_LARGE" as const });
    return Object.freeze({ bytes: Buffer.from(buffer.subarray(0, offset)), kind: "BYTES" as const });
  } finally {
    ops.close(handle);
  }
}
