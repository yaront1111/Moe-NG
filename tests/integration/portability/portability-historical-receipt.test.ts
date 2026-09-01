import { execFileSync } from "node:child_process";
import {
  copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SOURCE_COMMIT_CODES } from "./portability-source-contract.js";
import {
  MAX_HISTORICAL_RECEIPT_BYTES,
  SOURCE_COMMIT_PIN_FILE,
  parseHistoricalSourceCommitReceipt,
  readHistoricalSourceCommitReceipt,
  readPinBytes,
} from "./portability-historical-receipt.js";

const SHA = "a1f71a43c71cd03367a90baf52d99d814042dbe7";
const DIGEST = `sha256:${"b".repeat(64)}`;
const RUN = Object.freeze({ event: "push" as const, runId: 32312669884 });

function sealedReceipt(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    aggregateDigest: DIGEST,
    externalRun: RUN,
    sourceCommit: SHA,
    ...overrides,
  });
}

const HISTORICAL_REFUSAL_CASES = Object.freeze([
  ["absent bytes", undefined],
  ["unparseable bytes", "{not json"],
  ["an array", "[]"],
  ["an unsealed receipt carrying a digest", sealedReceipt({ externalRun: null })],
  ["an empty run", sealedReceipt({ externalRun: {} })],
  ["a missing event", sealedReceipt({ externalRun: { runId: RUN.runId } })],
  ["a non-push event", sealedReceipt({ externalRun: { event: "pull_request", runId: RUN.runId } })],
  ["a string run id", sealedReceipt({ externalRun: { event: "push", runId: `${RUN.runId}` } })],
  ["a zero run id", sealedReceipt({ externalRun: { event: "push", runId: 0 } })],
  ["a fractional run id", sealedReceipt({ externalRun: { event: "push", runId: 1.5 } })],
  ["an unsafe run id", sealedReceipt({ externalRun: { event: "push", runId: Number.MAX_VALUE } })],
  ["an extra run field", sealedReceipt({ externalRun: { ...RUN, actor: "caller" } })],
  ["an unknown top-level authority", sealedReceipt({ authority: "DAEMON_VERIFIED" })],
  ["a malformed comment", sealedReceipt({ $comment: { forged: true } })],
  ["a missing digest", JSON.stringify({ externalRun: RUN, sourceCommit: SHA })],
  ["an uppercase digest", sealedReceipt({ aggregateDigest: DIGEST.toUpperCase() })],
  ["a malformed source commit", sealedReceipt({ sourceCommit: "HEAD" })],
] as const);

describe("immutable historical portability receipt claims", () => {
  it("keeps an unsealed record explicitly UNKNOWN rather than calling it acceptance", () => {
    const outcome = parseHistoricalSourceCommitReceipt(JSON.stringify({
      aggregateDigest: null,
      externalRun: null,
      sourceCommit: SHA,
    }));
    expect(outcome).toEqual({
      aggregateDigest: null,
      claimState: "UNSEALED",
      externalRun: null,
      kind: "HISTORICAL_RECEIPT",
      readable: true,
      sourceCommit: SHA,
      truthClass: "UNKNOWN",
    });
    expect(Object.isFrozen(outcome)).toBe(true);
  });

  it("parses the exact sealed schema without granting current-run authority", () => {
    const outcome = parseHistoricalSourceCommitReceipt(sealedReceipt());
    expect(outcome).toEqual({
      aggregateDigest: DIGEST,
      claimState: "SEALED",
      externalRun: RUN,
      kind: "HISTORICAL_RECEIPT",
      readable: true,
      sourceCommit: SHA,
      truthClass: "UNKNOWN",
    });
    expect(Object.isFrozen(outcome)).toBe(true);
    if ("readable" in outcome) expect(Object.isFrozen(outcome.externalRun)).toBe(true);
    expect(outcome).not.toHaveProperty("authority");
    expect(outcome).not.toHaveProperty("ok", true);
    expect(outcome).not.toHaveProperty("state", "SEALED");
  });

  it("enumerates the complete nonzero historical-refusal roster", () => {
    expect(HISTORICAL_REFUSAL_CASES).toHaveLength(17);
    expect(HISTORICAL_REFUSAL_CASES.length).toBeGreaterThan(0);
  });

  it.each(HISTORICAL_REFUSAL_CASES)(
    "refuses %s with the exact historical code and layer", (_label, bytes) => {
    expect(parseHistoricalSourceCommitReceipt(bytes)).toEqual({
      code: SOURCE_COMMIT_CODES.pinUnreadable,
      layer: "PORTABILITY_EVIDENCE",
      ok: false,
    });
    },
  );

  it("refuses before parsing bytes beyond the historical receipt cap", () => {
    const oversized = `${sealedReceipt()}${" ".repeat(MAX_HISTORICAL_RECEIPT_BYTES)}`;
    expect(oversized.length).toBeGreaterThan(MAX_HISTORICAL_RECEIPT_BYTES);
    expect(parseHistoricalSourceCommitReceipt(oversized)).toEqual({
      code: SOURCE_COMMIT_CODES.pinUnreadable,
      layer: "PORTABILITY_EVIDENCE",
      ok: false,
    });

    const utf8Oversized = sealedReceipt({ $comment: ["🧱".repeat(17_000)] });
    expect(utf8Oversized.length).toBeLessThan(MAX_HISTORICAL_RECEIPT_BYTES);
    expect(Buffer.byteLength(utf8Oversized, "utf8")).toBeGreaterThan(
      MAX_HISTORICAL_RECEIPT_BYTES,
    );
    expect(parseHistoricalSourceCommitReceipt(utf8Oversized)).toEqual({
      code: SOURCE_COMMIT_CODES.pinUnreadable,
      layer: "PORTABILITY_EVIDENCE",
      ok: false,
    });
  });

  it("reads the real committed sealed receipt without changing its bytes", () => {
    const bytes = readPinBytes();
    expect(bytes, `${SOURCE_COMMIT_PIN_FILE} must remain beside the parser`).toBeTypeOf("string");
    const fromBytes = parseHistoricalSourceCommitReceipt(bytes);
    const fromDisk = readHistoricalSourceCommitReceipt();
    expect(fromDisk).toEqual(fromBytes);
    expect(fromDisk).toMatchObject({
      claimState: "SEALED",
      kind: "HISTORICAL_RECEIPT",
      readable: true,
      sourceCommit: expect.stringMatching(/^[0-9a-f]{40}$/u),
      truthClass: "UNKNOWN",
    });
  });

  it("bounds and exactly decodes receipt bytes before allocating parser input", () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "moe-historical-read-"));
    const receiptPath = join(isolatedRoot, SOURCE_COMMIT_PIN_FILE);
    try {
      writeFileSync(receiptPath, "x".repeat(MAX_HISTORICAL_RECEIPT_BYTES + 1), "utf8");
      expect(readPinBytes(isolatedRoot)).toBeUndefined();
      writeFileSync(receiptPath, Buffer.from([0xc3, 0x28]));
      expect(readPinBytes(isolatedRoot)).toBeUndefined();
    } finally {
      rmSync(isolatedRoot, { force: true, recursive: true });
    }
  });

  it("can be imported outside a Git checkout without observing current HEAD", () => {
    const implementation = readFileSync(
      join(import.meta.dirname, "portability-historical-receipt.ts"),
      "utf8",
    );
    expect(implementation).not.toMatch(/node:child_process|spawnSync|execFile/u);
    expect(implementation).not.toContain('from "./portability-source-commit.js"');

    const isolatedRoot = mkdtempSync(join(tmpdir(), "moe-historical-module-"));
    const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
    try {
      for (const file of [
        "portability-evidence-pin.json",
        "portability-historical-receipt.ts",
        "portability-source-contract.ts",
      ]) copyFileSync(join(import.meta.dirname, file), join(isolatedRoot, file));
      symlinkSync(
        join(repositoryRoot, "node_modules"),
        join(isolatedRoot, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
      writeFileSync(join(isolatedRoot, "outside.test.ts"), [
        'import { expect, it } from "vitest";',
        'import { readHistoricalSourceCommitReceipt } from "./portability-historical-receipt.js";',
        'it("reads the sealed receipt without Git", () => {',
        "  expect(readHistoricalSourceCommitReceipt()).toMatchObject({",
        '    claimState: "SEALED", kind: "HISTORICAL_RECEIPT",',
        '    readable: true, truthClass: "UNKNOWN",',
        "  });",
        "});",
      ].join("\n"), "utf8");
      const nested = execFileSync(process.execPath, [
        join(repositoryRoot, "node_modules", "vitest", "vitest.mjs"),
        "run",
        "outside.test.ts",
        "--root",
        isolatedRoot,
      ], { cwd: isolatedRoot, encoding: "utf8", shell: false });
      expect(nested).toMatch(/Test Files\s+1 passed \(1\)/u);
      expect(nested).toMatch(/Tests\s+1 passed \(1\)/u);
    } finally {
      rmSync(isolatedRoot, { force: true, recursive: true });
    }
  });
});
