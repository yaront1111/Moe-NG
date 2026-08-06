import {
  DurableStoreError,
  MAX_PAGE_DECODED_BYTES,
} from "./store-contracts.js";
import { limitExceeded, requireSafePositiveInteger } from "./store-input.js";

export { MAX_PAGE_DECODED_BYTES } from "./store-contracts.js";

export const READ_PAGE_ROW_OVERHEAD_BYTES = 256 as const;

export interface SizedReadCursor<Cursor extends bigint | number> {
  readonly cursor: Cursor;
  readonly decodedBytes: number;
}

export interface ReadPagePrefix<Cursor extends bigint | number> {
  readonly decodedBytes: number;
  readonly hasMore: boolean;
  readonly selected: readonly SizedReadCursor<Cursor>[];
}

export function requirePageDecodedByteLimit(value: unknown): number {
  const limit = requireSafePositiveInteger(value, "maxDecodedBytes");
  if (limit > MAX_PAGE_DECODED_BYTES) {
    return limitExceeded(
      `maxDecodedBytes cannot exceed ${MAX_PAGE_DECODED_BYTES}`,
    );
  }
  return limit;
}

export function requireStoredDecodedByteCount(
  row: Record<string, unknown>,
  column = "decoded_bytes",
): number {
  const value = row[column];
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      "a read-page candidate has an invalid decoded byte count",
    );
  }
  const exact = BigInt(value);
  if (exact > BigInt(MAX_PAGE_DECODED_BYTES)) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      "a read-page candidate exceeds the valid single-record ceiling",
    );
  }
  return Number(exact);
}

export function selectReadPagePrefix<Cursor extends bigint | number>(
  candidates: readonly SizedReadCursor<Cursor>[],
  rowLimit: number,
  decodedByteLimit: number,
): ReadPagePrefix<Cursor> {
  let decodedBytes = 0;
  let previousCursor: Cursor | undefined;
  const selected: SizedReadCursor<Cursor>[] = [];

  for (const candidate of candidates) {
    if (
      previousCursor !== undefined &&
      (typeof candidate.cursor !== typeof previousCursor ||
        candidate.cursor <= previousCursor)
    ) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "read-page candidate cursors are not strictly increasing",
      );
    }
    previousCursor = candidate.cursor;

    if (!Number.isSafeInteger(candidate.decodedBytes) || candidate.decodedBytes <= 0) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "a read-page candidate has an invalid decoded byte count",
      );
    }
    if (candidate.decodedBytes > MAX_PAGE_DECODED_BYTES) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "a read-page candidate exceeds the valid single-record ceiling",
      );
    }
    if (selected.length >= rowLimit) {
      break;
    }
    if (candidate.decodedBytes > decodedByteLimit - decodedBytes) {
      if (selected.length === 0) {
        return limitExceeded(
          `the next record does not fit within ${decodedByteLimit} decoded bytes`,
        );
      }
      break;
    }
    selected.push(Object.freeze({ ...candidate }));
    decodedBytes += candidate.decodedBytes;
  }

  return Object.freeze({
    decodedBytes,
    hasMore: selected.length < candidates.length,
    selected: Object.freeze(selected),
  });
}

export function assertReadPageCursors<Cursor extends bigint | number>(
  actual: readonly Cursor[],
  selected: readonly SizedReadCursor<Cursor>[],
): void {
  if (
    actual.length !== selected.length ||
    actual.some((cursor, index) => cursor !== selected[index]?.cursor)
  ) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      "selected read-page records changed between preflight and materialization",
    );
  }
}
