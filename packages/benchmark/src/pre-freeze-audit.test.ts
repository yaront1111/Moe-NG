import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { auditPreFreezeSources, runPreFreezeAudit } from "./pre-freeze-audit.js";
import { PRE_FREEZE_AUDIT_LAYER } from "./pre-freeze-audit-vocabulary.js";
import {
  PINNED_DOCUMENT_ROOT_ENV, isPinnedCorpusAuthority, isPinnedDocument,
  readPinnedBenchmarkSpec, readPinnedCorpusAuthority, readPinnedRebuildDesign,
} from "./pre-freeze-pinned-documents.js";
import type { PinnedSource } from "./pre-freeze-source-reader.js";

/**
 * CORPUS GATE (task-e1b479134f6c4c2282bd7b13af693460). The pinned corpus is now
 * mandatory-explicit — MOE_PINNED_DOCUMENT_ROOT or a refusal — so the real-byte arms below
 * cannot run on a host that has not been pointed at one. They are GATED, never deleted or
 * re-based on synthetic bytes, and the gate is never silent: the first arm in this file
 * always executes and names the exact code that closed them, so "corpus absent" can never
 * be misread as "these arms passed".
 */
const CORPUS = readPinnedCorpusAuthority();
const itWithCorpus = it.skipIf(!isPinnedCorpusAuthority(CORPUS));

const original = process.env[PINNED_DOCUMENT_ROOT_ENV];
afterEach(() => {
  if (original === undefined) delete process.env[PINNED_DOCUMENT_ROOT_ENV];
  else process.env[PINNED_DOCUMENT_ROOT_ENV] = original;
});

const sourceOf = (which: "benchmark" | "design"): PinnedSource => {
  const document = which === "benchmark" ? readPinnedBenchmarkSpec() : readPinnedRebuildDesign();
  if (!isPinnedDocument(document)) {
    throw new Error(`pinned ${which} refused: ${document.code} at ${document.layer}`);
  }
  return document.source;
};

const scratch: string[] = [];
afterAll(() => {
  for (const path of scratch) rmSync(path, { force: true, recursive: true });
});

/** A clean, versioned root that simply lacks the documents — the SPEC_UNPARSEABLE fixture. */
const emptyVersionedRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "moe-audit-root-"));
  scratch.push(root);
  const git = (...args: readonly string[]): void => {
    execFileSync("git", ["-C", root, ...args], { stdio: "ignore", windowsHide: true });
  };
  git("init", "--quiet");
  writeFileSync(join(root, "README.md"), "no pinned documents here\n");
  git("add", "--all");
  git("-c", "user.email=worker@moe.test", "-c", "user.name=moe worker",
    "commit", "--quiet", "--message", "empty corpus fixture");
  return root;
};

describe("pinned corpus gate (task-e1b479134f6c4c2282bd7b13af693460)", () => {
  it("names the exact refusal gating the real-byte arms, rather than skipping silently", () => {
    if (isPinnedCorpusAuthority(CORPUS)) {
      expect(CORPUS.head).toMatch(/^[a-f0-9]{40}$/);
      expect(CORPUS.status).toBe("");
      return;
    }
    expect(CORPUS.layer).toBe(PRE_FREEZE_AUDIT_LAYER);
    if (!process.env[PINNED_DOCUMENT_ROOT_ENV]?.trim()) {
      expect(CORPUS.code).toBe("CORPUS_ROOT_UNSET");
    } else {
      expect(CORPUS.code).toMatch(/^CORPUS_ROOT_(UNREADABLE|UNVERSIONED|DIRTY|MOVED)$/);
    }
  });
});

describe("pre-freeze audit entry point (task-71a4fac5d15044c08f6617f50a561e39)", () => {
  itWithCorpus("passes the two pinned documents end to end", () => {
    const report = runPreFreezeAudit();
    expect(report.refusals).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.references?.ok).toBe(true);
    expect(report.gateInventory?.ok).toBe(true);
    expect(report.thresholds?.ok).toBe(true);
  });

  itWithCorpus("sums every half's case count, and every half generated cases", () => {
    const report = runPreFreezeAudit();
    const halves = [report.references, report.gateInventory, report.thresholds];
    for (const half of halves) expect(half?.generatedCases ?? 0).toBeGreaterThan(0);
    expect(report.generatedCases)
      .toBe(halves.reduce((sum, half) => sum + (half?.generatedCases ?? 0), 0));
    expect(report.references?.familyCases).toEqual({ "BENCH-S": 14, "CORE-I": 22, "CORE-S": 14 });
    expect(report.thresholds?.ciTailCases).toBe(7);
    expect(report.gateInventory?.rungCases).toBe(5);
  });

  itWithCorpus("agrees with the pure form given the same already-verified sources", () => {
    const pure = auditPreFreezeSources({
      benchmark: sourceOf("benchmark"), design: sourceOf("design"),
    });
    expect(pure.generatedCases).toBe(runPreFreezeAudit().generatedCases);
    expect(pure.refusals).toEqual([]);
  });

  /**
   * A CLEAN, VERSIONED root that merely lacks the documents, not a nonexistent path. The
   * fixture changed with the corpus rules and the assertion did not: a nonexistent path is
   * now answered by the corpus fence as CORPUS_ROOT_UNREADABLE and would never have reached
   * the document reader, so this arm would have gone on passing while silently testing a
   * different fence. The arm below poses that other condition on purpose, and the two
   * expectations differ — which is what proves the two fences are not one.
   */
  it("refuses rather than passing when a pinned document cannot be read", () => {
    process.env[PINNED_DOCUMENT_ROOT_ENV] = emptyVersionedRoot();
    const report = runPreFreezeAudit();
    expect(report.ok).toBe(false);
    expect(report.generatedCases).toBe(0);
    expect(report.references).toBeNull();
    expect(report.refusals.map((refusal) => refusal.code))
      .toEqual(["SPEC_UNPARSEABLE", "SPEC_UNPARSEABLE", "SWEEP_ZERO_CASES"]);
    expect(report.refusals.every((refusal) => refusal.layer === "PRE_FREEZE_AUDIT")).toBe(true);
  });

  it("refuses at the corpus fence, not the document fence, when the root does not exist", () => {
    process.env[PINNED_DOCUMENT_ROOT_ENV] = "D:\\no\\such\\pinned\\root";
    const report = runPreFreezeAudit();
    expect(report.ok).toBe(false);
    expect(report.generatedCases).toBe(0);
    expect(report.refusals.map((refusal) => refusal.code))
      .toEqual(["CORPUS_ROOT_UNREADABLE", "CORPUS_ROOT_UNREADABLE", "SWEEP_ZERO_CASES"]);
    expect(report.refusals.every((refusal) => refusal.layer === PRE_FREEZE_AUDIT_LAYER)).toBe(true);
  });
});
