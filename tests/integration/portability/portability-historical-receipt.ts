/** Git-independent reader for immutable historical portability receipt claims. */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import {
  SOURCE_COMMIT_CODES,
  refuseSourceCommit,
  type SourceCommitRefused,
} from "./portability-source-contract.js";

export const SOURCE_COMMIT_PIN_FILE = "portability-evidence-pin.json";
export const MAX_HISTORICAL_RECEIPT_BYTES = 64 * 1024;

export interface HistoricalClaimedRun {
  readonly event: "push";
  readonly runId: number;
}

export interface HistoricalSourceCommitSealedClaim {
  readonly aggregateDigest: string;
  readonly claimState: "SEALED";
  readonly externalRun: HistoricalClaimedRun;
  readonly kind: "HISTORICAL_RECEIPT";
  readonly readable: true;
  readonly sourceCommit: string;
  readonly truthClass: "UNKNOWN";
}

export interface HistoricalSourceCommitUnknown {
  readonly aggregateDigest: null;
  readonly claimState: "UNSEALED";
  readonly externalRun: null;
  readonly kind: "HISTORICAL_RECEIPT";
  readonly readable: true;
  readonly sourceCommit: string;
  readonly truthClass: "UNKNOWN";
}

export type HistoricalSourceCommitOutcome =
  | HistoricalSourceCommitSealedClaim
  | HistoricalSourceCommitUnknown
  | SourceCommitRefused;

const OBJECT_NAME = /^[0-9a-f]{40}$/u;
const AGGREGATE_DIGEST = /^sha256:[0-9a-f]{64}$/u;

function sealedRun(value: unknown): HistoricalClaimedRun | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "event,runId") return undefined;
  if (record["event"] !== "push") return undefined;
  if (!Number.isSafeInteger(record["runId"]) || (record["runId"] as number) <= 0) return undefined;
  return Object.freeze({ event: "push" as const, runId: record["runId"] as number });
}

/** Parses structure only; the result is a receipt record, never current-run authority. */
export function parseHistoricalSourceCommitReceipt(
  pinBytes: string | undefined,
): HistoricalSourceCommitOutcome {
  if (
    typeof pinBytes !== "string" ||
    pinBytes.trim() === "" ||
    Buffer.byteLength(pinBytes, "utf8") > MAX_HISTORICAL_RECEIPT_BYTES
  ) {
    return refuseSourceCommit(SOURCE_COMMIT_CODES.pinUnreadable);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(pinBytes);
  } catch {
    return refuseSourceCommit(SOURCE_COMMIT_CODES.pinUnreadable);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuseSourceCommit(SOURCE_COMMIT_CODES.pinUnreadable);
  }
  const record = parsed as Record<string, unknown>;
  const allowedKeys = new Set(["$comment", "aggregateDigest", "externalRun", "sourceCommit"]);
  const comment = record["$comment"];
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    (comment !== undefined &&
      (!Array.isArray(comment) || comment.some((line) => typeof line !== "string")))
  ) return refuseSourceCommit(SOURCE_COMMIT_CODES.pinUnreadable);
  if (typeof record["sourceCommit"] !== "string" || !OBJECT_NAME.test(record["sourceCommit"])) {
    return refuseSourceCommit(SOURCE_COMMIT_CODES.pinUnreadable);
  }
  if (record["externalRun"] === null) {
    if (record["aggregateDigest"] !== undefined && record["aggregateDigest"] !== null) {
      return refuseSourceCommit(SOURCE_COMMIT_CODES.pinUnreadable);
    }
    return Object.freeze({
      aggregateDigest: null,
      claimState: "UNSEALED" as const,
      externalRun: null,
      kind: "HISTORICAL_RECEIPT" as const,
      readable: true as const,
      sourceCommit: record["sourceCommit"],
      truthClass: "UNKNOWN" as const,
    });
  }
  const run = sealedRun(record["externalRun"]);
  if (
    typeof record["aggregateDigest"] !== "string" ||
    !AGGREGATE_DIGEST.test(record["aggregateDigest"]) ||
    run === undefined
  ) return refuseSourceCommit(SOURCE_COMMIT_CODES.pinUnreadable);
  return Object.freeze({
    aggregateDigest: record["aggregateDigest"],
    claimState: "SEALED" as const,
    externalRun: run,
    kind: "HISTORICAL_RECEIPT" as const,
    readable: true as const,
    sourceCommit: record["sourceCommit"],
    truthClass: "UNKNOWN" as const,
  });
}

export function readPinBytes(directory: string = import.meta.dirname): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(join(directory, SOURCE_COMMIT_PIN_FILE), "r");
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > MAX_HISTORICAL_RECEIPT_BYTES) return undefined;

    const bytes = Buffer.allocUnsafe(MAX_HISTORICAL_RECEIPT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_HISTORICAL_RECEIPT_BYTES) return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // A close failure cannot turn unreadable receipt bytes into authority.
      }
    }
  }
}

export function readHistoricalSourceCommitReceipt(
  directory: string = import.meta.dirname,
): HistoricalSourceCommitOutcome {
  return parseHistoricalSourceCommitReceipt(readPinBytes(directory));
}
