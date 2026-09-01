/** Current checkout authority. Historical receipts have a separate module. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PORTABILITY_SOURCE_COMMIT, SOURCE_COMMIT_CODES, SOURCE_COMMIT_ENV,
  SOURCE_COMMIT_EVIDENCE_ENV, SOURCE_COMMIT_GIT_ENV, observeCheckoutCommit,
  readPortabilitySourceCommit, resolvePortabilitySourceCommit, resolveSourceCommit,
} from "./portability-source-commit.js";

const SHA_A = "a1f71a43c71cd03367a90baf52d99d814042dbe7";
const SHA_B = "d543f71ea380d46a3f801178b4821c4bc0abe9b7";
const HISTORICAL_BYTES = JSON.stringify({ sourceCommit: SHA_A });

const CURRENT_RUN_CASES = Object.freeze([
  {
    actualCheckoutCommit: SHA_A,
    declaredCommit: undefined,
    event: "branch checkout without an external declaration",
    expected: { boundBy: "CHECKOUT", ok: true, sourceCommit: SHA_A },
  },
  {
    actualCheckoutCommit: SHA_A,
    declaredCommit: SHA_A,
    event: "pull-request head checkout whose declaration agrees",
    expected: { boundBy: "CHECKOUT", ok: true, sourceCommit: SHA_A },
  },
  {
    actualCheckoutCommit: SHA_B,
    declaredCommit: SHA_A,
    event: "synthetic merge checkout mislabeled as the pull-request head",
    expected: {
      code: "PORTABILITY_SOURCE_COMMIT_CHECKOUT_MISMATCH",
      layer: "PORTABILITY_EVIDENCE",
      ok: false,
    },
  },
] as const);

const SPECIAL_INDEX_FLAG_CASES = Object.freeze([
  {
    clear: "--no-assume-unchanged",
    mutation: "assume-unchanged mutation\n",
    set: "--assume-unchanged",
  },
  {
    clear: "--no-skip-worktree",
    mutation: "skip-worktree mutation\n",
    set: "--skip-worktree",
  },
] as const);

describe("portability source-commit resolution — current checkout authority", () => {
  it("decides a nonzero branch, pull-request-head, and synthetic-merge roster", () => {
    expect(CURRENT_RUN_CASES).toHaveLength(3);
    expect(CURRENT_RUN_CASES.length).toBeGreaterThan(0);
    for (const row of CURRENT_RUN_CASES) {
      expect([
        row.event,
        resolveSourceCommit({
          actualCheckoutCommit: row.actualCheckoutCommit,
          declaredCommit: row.declaredCommit,
        }),
      ]).toEqual([row.event, row.expected]);
    }
  });

  it("publishes the exact checkout-mismatch refusal code and layer", () => {
    expect(SOURCE_COMMIT_CODES.checkoutMismatch).toBe(
      "PORTABILITY_SOURCE_COMMIT_CHECKOUT_MISMATCH",
    );
    expect(resolveSourceCommit({
      actualCheckoutCommit: SHA_B,
      declaredCommit: SHA_A,
    })).toEqual({
      code: SOURCE_COMMIT_CODES.checkoutMismatch,
      layer: "PORTABILITY_EVIDENCE",
      ok: false,
    });
  });

  it("pins the checkout-observer refusal vocabulary", () => {
    expect(SOURCE_COMMIT_CODES.checkoutDirty).toBe("PORTABILITY_SOURCE_CHECKOUT_DIRTY");
    expect(SOURCE_COMMIT_CODES.observationFailed).toBe(
      "PORTABILITY_SOURCE_CHECKOUT_OBSERVATION_FAILED",
    );
    expect(SOURCE_COMMIT_CODES.repositoryMismatch).toBe(
      "PORTABILITY_SOURCE_REPOSITORY_MISMATCH",
    );
    expect(SOURCE_COMMIT_CODES.pinUnreadable).toBe("PORTABILITY_SOURCE_COMMIT_PIN_UNREADABLE");
  });

  it.each([
    ["absent checkout", undefined, undefined, SOURCE_COMMIT_CODES.absent],
    ["short checkout", "a1f71a4", SHA_A, SOURCE_COMMIT_CODES.malformed],
    ["uppercase checkout", SHA_A.toUpperCase(), SHA_A, SOURCE_COMMIT_CODES.malformed],
    ["truncated declaration", SHA_A, SHA_A.slice(0, 39), SOURCE_COMMIT_CODES.malformed],
    ["blank declaration", SHA_A, "   ", SOURCE_COMMIT_CODES.malformed],
  ] as const)("refuses a %s with an exact code and layer", (
    _label, actualCheckoutCommit, declaredCommit, code,
  ) => {
    expect(resolveSourceCommit({ actualCheckoutCommit, declaredCommit })).toEqual({
      code,
      layer: "PORTABILITY_EVIDENCE",
      ok: false,
    });
  });

  it("never lets historical receipt bytes select or conflict with the current checkout", () => {
    const hostileInputs = {
      actualCheckoutCommit: SHA_B,
      declaredCommit: SHA_B,
      pinBytes: HISTORICAL_BYTES,
    };
    const receiptOnlyInputs = {
      actualCheckoutCommit: undefined,
      declaredCommit: undefined,
      pinBytes: HISTORICAL_BYTES,
    };
    expect(resolveSourceCommit(hostileInputs)).toEqual({
      boundBy: "CHECKOUT",
      ok: true,
      sourceCommit: SHA_B,
    });
    expect(resolveSourceCommit(receiptOnlyInputs)).toEqual({
      code: SOURCE_COMMIT_CODES.absent,
      layer: "PORTABILITY_EVIDENCE",
      ok: false,
    });
  });

  it("requires the suite-wide declaration when evidence mode is explicit", () => {
    expect(resolveSourceCommit({
      actualCheckoutCommit: SHA_A,
      requireDeclaration: true,
    })).toEqual({
      code: SOURCE_COMMIT_CODES.absent,
      layer: "PORTABILITY_EVIDENCE",
      ok: false,
    });
  });
});

describe("portability source-commit resolution — production surface", () => {
  it("binds the real checkout and treats the environment only as a declaration", () => {
    const outcome = resolvePortabilitySourceCommit();
    expect(outcome).toEqual({
      boundBy: "CHECKOUT",
      ok: true,
      sourceCommit: expect.stringMatching(/^[0-9a-f]{40}$/u),
    });
  });

  it("exposes ONE captured constant that equals a fresh production read", () => {
    expect(PORTABILITY_SOURCE_COMMIT).toMatch(/^[0-9a-f]{40}$/u);
    expect(PORTABILITY_SOURCE_COMMIT).toBe(readPortabilitySourceCommit());
  });

  it("names the workflow inputs checked against the observed checkout", () => {
    expect(SOURCE_COMMIT_ENV).toBe("MOE_PORTABILITY_SOURCE_COMMIT");
    expect(SOURCE_COMMIT_EVIDENCE_ENV).toBe("MOE_PORTABILITY_EVIDENCE_MODE");
    expect(SOURCE_COMMIT_GIT_ENV).toBe("MOE_PORTABILITY_GIT_EXECUTABLE");
  });

  it("scrubs Git routing variables and rejects tracked-byte drift", () => {
    const root = mkdtempSync(join(tmpdir(), "moe-portability-checkout-"));
    try {
      execFileSync("git", ["init", "--quiet", root], { stdio: "ignore" });
      execFileSync("git", ["-C", root, "config", "core.autocrlf", "false"]);
      execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
      execFileSync("git", ["-C", root, "config", "user.name", "Moe Test"]);
      const hooksDirectory = join(root, ".git-hooks-disabled");
      mkdirSync(hooksDirectory);
      execFileSync("git", ["-C", root, "config", "core.hooksPath", hooksDirectory]);
      writeFileSync(join(root, "tracked.txt"), "committed\n", "utf8");
      execFileSync("git", ["-C", root, "add", "tracked.txt"]);
      execFileSync("git", ["-C", root, "commit", "--quiet", "--no-gpg-sign", "-m", "fixture"]);
      const decoy = join(root, "decoy");
      mkdirSync(decoy);
      const environment = { ...process.env, GIT_DIR: decoy, GIT_WORK_TREE: decoy };
      expect(observeCheckoutCommit(root, {
        environment,
        gitExecutable: "git",
        requireAbsoluteExecutable: true,
      })).toEqual({
        code: SOURCE_COMMIT_CODES.observationFailed,
        layer: "PORTABILITY_EVIDENCE",
        ok: false,
      });
      expect(observeCheckoutCommit(decoy, { environment })).toEqual({
        code: SOURCE_COMMIT_CODES.repositoryMismatch,
        layer: "PORTABILITY_EVIDENCE",
        ok: false,
      });
      const clean = observeCheckoutCommit(root, { environment, requireClean: true });
      expect(clean).toMatchObject({ ok: true, sourceCommit: expect.stringMatching(/^[0-9a-f]{40}$/u) });

      expect(SPECIAL_INDEX_FLAG_CASES).toHaveLength(2);
      expect(SPECIAL_INDEX_FLAG_CASES.length).toBeGreaterThan(0);
      let executedFlagCases = 0;
      for (const flagCase of SPECIAL_INDEX_FLAG_CASES) {
        execFileSync("git", ["-C", root, "update-index", flagCase.set, "tracked.txt"]);
        writeFileSync(join(root, "tracked.txt"), flagCase.mutation, "utf8");
        expect(observeCheckoutCommit(root, { environment, requireClean: true })).toEqual({
          code: SOURCE_COMMIT_CODES.checkoutDirty,
          layer: "PORTABILITY_EVIDENCE",
          ok: false,
        });
        execFileSync("git", ["-C", root, "update-index", flagCase.clear, "tracked.txt"]);
        writeFileSync(join(root, "tracked.txt"), "committed\n", "utf8");
        executedFlagCases += 1;
      }
      expect(executedFlagCases).toBe(SPECIAL_INDEX_FLAG_CASES.length);

      writeFileSync(join(root, "tracked.txt"), "mutated\n", "utf8");
      expect(observeCheckoutCommit(root, { environment, requireClean: true })).toEqual({
        code: SOURCE_COMMIT_CODES.checkoutDirty,
        layer: "PORTABILITY_EVIDENCE",
        ok: false,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }, 300_000);

  it("rejects same-length tracked drift hidden behind the index stat cache", () => {
    const root = mkdtempSync(join(tmpdir(), "moe-portability-stat-cache-"));
    try {
      execFileSync("git", ["init", "--quiet", root], { stdio: "ignore" });
      execFileSync("git", ["-C", root, "config", "core.autocrlf", "false"]);
      execFileSync("git", ["-C", root, "config", "core.trustctime", "false"]);
      execFileSync("git", ["-C", root, "config", "core.checkStat", "minimal"]);
      execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
      execFileSync("git", ["-C", root, "config", "user.name", "Moe Test"]);
      const hooksDirectory = join(root, ".git-hooks-disabled");
      mkdirSync(hooksDirectory);
      execFileSync("git", ["-C", root, "config", "core.hooksPath", hooksDirectory]);
      const tracked = join(root, "tracked.txt");
      writeFileSync(tracked, "committed\n", "utf8");
      execFileSync("git", ["-C", root, "add", "tracked.txt"]);
      execFileSync("git", ["-C", root, "commit", "--quiet", "--no-gpg-sign", "-m", "fixture"]);

      const cachedTime = new Date("2001-01-01T00:00:00.000Z");
      utimesSync(tracked, cachedTime, cachedTime);
      execFileSync("git", ["-C", root, "update-index", "--refresh"]);
      const indexPath = join(root, ".git", "index");
      const indexBefore = readFileSync(indexPath);
      writeFileSync(tracked, "subverted\n", "utf8");
      utimesSync(tracked, cachedTime, cachedTime);

      expect(() => execFileSync(
        "git", ["-C", root, "diff", "--quiet", "--", "tracked.txt"], { stdio: "ignore" },
      )).not.toThrow();
      expect(observeCheckoutCommit(root, { requireClean: true })).toEqual({
        code: SOURCE_COMMIT_CODES.checkoutDirty,
        layer: "PORTABILITY_EVIDENCE",
        ok: false,
      });
      expect(readFileSync(indexPath)).toEqual(indexBefore);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }, 300_000);

  it("does not let repository-local filters forge the reconstructed tree", () => {
    const root = mkdtempSync(join(tmpdir(), "moe-portability-filter-routing-"));
    try {
      execFileSync("git", ["init", "--quiet", root], { stdio: "ignore" });
      execFileSync("git", ["-C", root, "config", "core.autocrlf", "false"]);
      execFileSync("git", ["-C", root, "config", "core.trustctime", "false"]);
      execFileSync("git", ["-C", root, "config", "core.checkStat", "minimal"]);
      execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
      execFileSync("git", ["-C", root, "config", "user.name", "Moe Test"]);
      const hooksDirectory = join(root, ".git-hooks-disabled");
      mkdirSync(hooksDirectory);
      execFileSync("git", ["-C", root, "config", "core.hooksPath", hooksDirectory]);
      const tracked = join(root, "tracked.txt");
      writeFileSync(join(root, ".gitattributes"), "tracked.txt filter=forge\n", "utf8");
      writeFileSync(tracked, "committed\n", "utf8");
      execFileSync("git", ["-C", root, "add", ".gitattributes", "tracked.txt"]);
      execFileSync("git", ["-C", root, "commit", "--quiet", "--no-gpg-sign", "-m", "fixture"]);

      const cachedTime = new Date("2001-01-01T00:00:00.000Z");
      utimesSync(tracked, cachedTime, cachedTime);
      execFileSync("git", ["-C", root, "update-index", "--refresh"]);
      execFileSync("git", ["-C", root, "config", "filter.forge.clean",
        "while IFS= read -r line; do printf 'committed\\n'; done"]);
      execFileSync("git", ["-C", root, "config", "filter.forge.required", "true"]);
      writeFileSync(tracked, "tampered!\n", "utf8");
      utimesSync(tracked, cachedTime, cachedTime);

      expect(() => execFileSync(
        "git", ["-C", root, "diff", "--quiet", "--", "tracked.txt"],
        { stdio: "ignore", timeout: 30_000 },
      )).not.toThrow();
      const headBlob = execFileSync(
        "git", ["-C", root, "rev-parse", "HEAD:tracked.txt"], { encoding: "utf8" },
      ).trim();
      expect(execFileSync(
        "git", ["-C", root, "hash-object", "--path=tracked.txt", "tracked.txt"],
        { encoding: "utf8" },
      ).trim()).toBe(headBlob);
      expect(execFileSync(
        "git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=no"],
        { encoding: "utf8" },
      )).toBe("");
      expect(observeCheckoutCommit(root, { requireClean: true })).toEqual({
        code: SOURCE_COMMIT_CODES.checkoutDirty,
        layer: "PORTABILITY_EVIDENCE",
        ok: false,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }, 300_000);
});
