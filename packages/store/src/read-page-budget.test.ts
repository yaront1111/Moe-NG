import { expect, it } from "vitest";

import {
  MAX_PAGE_DECODED_BYTES,
  requireStoredDecodedByteCount,
  selectReadPagePrefix,
} from "./read-page-budget.js";

it("selects the largest ordered prefix within exact row and byte boundaries", () => {
  const candidates = [
    { cursor: 1n, decodedBytes: 4 },
    { cursor: 2n, decodedBytes: 6 },
    { cursor: 3n, decodedBytes: 1 },
  ] as const;

  expect(selectReadPagePrefix(candidates, 3, 10)).toEqual({
    decodedBytes: 10,
    hasMore: true,
    selected: candidates.slice(0, 2),
  });
  expect(selectReadPagePrefix(candidates, 2, 11)).toEqual({
    decodedBytes: 10,
    hasMore: true,
    selected: candidates.slice(0, 2),
  });
  expect(selectReadPagePrefix(candidates, 3, 11)).toEqual({
    decodedBytes: 11,
    hasMore: false,
    selected: candidates,
  });
});

it("fails closed instead of returning a zero-progress or corrupt page", () => {
  expect(() =>
    selectReadPagePrefix([{ cursor: 1n, decodedBytes: 11 }], 10, 10),
  ).toThrowError(/STORE_LIMIT_EXCEEDED.*10 decoded bytes/u);

  expect(() =>
    selectReadPagePrefix(
      [{ cursor: 1n, decodedBytes: MAX_PAGE_DECODED_BYTES + 1 }],
      10,
      MAX_PAGE_DECODED_BYTES,
    ),
  ).toThrowError(/STORE_CORRUPT.*single-record ceiling/u);

  expect(() =>
    selectReadPagePrefix([{ cursor: 1n, decodedBytes: 0 }], 10, 10),
  ).toThrowError(/STORE_CORRUPT.*decoded byte count/u);
});

it("rejects duplicate or descending cursors before selecting a prefix", () => {
  expect(() =>
    selectReadPagePrefix(
      [
        { cursor: 2n, decodedBytes: 1 },
        { cursor: 2n, decodedBytes: 1 },
      ],
      10,
      10,
    ),
  ).toThrowError(/STORE_CORRUPT.*strictly increasing/u);
});

it("parses SQLite byte totals as exact decimal text", () => {
  expect(requireStoredDecodedByteCount({ decoded_bytes: "4096" })).toBe(4_096);
  expect(() =>
    requireStoredDecodedByteCount({ decoded_bytes: MAX_PAGE_DECODED_BYTES }),
  ).toThrowError(/STORE_CORRUPT.*decoded byte count/u);
  expect(() =>
    requireStoredDecodedByteCount({ decoded_bytes: "9007199254740993" }),
  ).toThrowError(/STORE_CORRUPT.*single-record ceiling/u);
});
