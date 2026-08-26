import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PRE_FREEZE_AUDIT_LAYER, type PreFreezeAuditRefusal,
} from "./pre-freeze-audit-vocabulary.js";
import {
  PINNED_BENCHMARK_SPEC_RELATIVE_PATH, PINNED_DOCUMENT_ROOT_ENV, isPinnedCorpusAuthority,
  isPinnedDocument, readPinnedBenchmarkSpec, readPinnedCorpusAuthority,
  readPinnedRebuildDesign,
} from "./pre-freeze-pinned-documents.js";
import { PINNED_BENCHMARK_SPEC_SHA256 } from "./pre-freeze-source-reader.js";

/**
 * THE PORTABLE HALF OF THIS PACKAGE'S COVERAGE. Every arm here runs, and passes, on a
 * machine that has never held the private corpus — that is the entire point of the file,
 * and it is why these arms live apart from the real-byte suites rather than inside them.
 * Those suites need the documents; these need only the absence of them.
 *
 * WHAT WOULD MAKE THIS FILE VACUOUS, AND WHAT STOPS IT. An arm asserting merely "a refusal
 * happened" would stay green if every condition collapsed into one catch-all code, and a
 * sweep that generated no cases would stay green while asserting nothing at all. So each
 * case names its EXACT expected code, every case asserts the layer as a value rather than
 * as a presence, and the roster's length and uniqueness are pinned so an emptied or
 * duplicated sweep reds instead of passing.
 */

const scratch: string[] = [];

const newScratchDir = (label: string): string => {
  const created = mkdtempSync(join(tmpdir(), `moe-corpus-${label}-`));
  scratch.push(created);
  return created;
};

/** A real repository with one commit, so HEAD resolves and `status` is the only variable. */
const newCorpusRepo = (label: string, dirty: boolean): string => {
  const root = newScratchDir(label);
  const git = (...args: readonly string[]): void => {
    execFileSync("git", ["-C", root, ...args], { stdio: "ignore", windowsHide: true });
  };
  git("init", "--quiet");
  mkdirSync(join(root, "docs", "plans"), { recursive: true });
  writeFileSync(join(root, PINNED_BENCHMARK_SPEC_RELATIVE_PATH), "# placeholder corpus\n");
  git("add", "--all");
  git("-c", "user.email=worker@moe.test", "-c", "user.name=moe worker",
    "commit", "--quiet", "--message", "corpus fixture");
  if (dirty) writeFileSync(join(root, "uncommitted.md"), "written after the commit\n");
  return root;
};

/**
 * The frozen sweep. `kind` exists because two conditions cannot be spelled as a literal
 * path: they need a repository built at run time. Keeping them in the same roster is what
 * lets one length assertion cover the whole sweep.
 */
const CORPUS_REFUSAL_CASES = Object.freeze([
  { expected: "CORPUS_ROOT_UNSET", kind: "UNSET", label: "the variable is unset" },
  { expected: "CORPUS_ROOT_UNSET", kind: "LITERAL", label: "the variable is empty", root: "" },
  {
    expected: "CORPUS_ROOT_UNSET", kind: "LITERAL", label: "the variable is whitespace only",
    root: "   \t  ",
  },
  {
    expected: "CORPUS_ROOT_UNREADABLE", kind: "LITERAL",
    label: "a windows-shaped path that does not exist", root: "D:\\projexts\\moes-absent-64b603e7",
  },
  {
    expected: "CORPUS_ROOT_UNREADABLE", kind: "LITERAL",
    label: "a posix-shaped path that does not exist", root: "/var/tmp/moes-absent-64b603e7",
  },
  {
    expected: "CORPUS_ROOT_UNREADABLE", kind: "FILE",
    label: "a readable file rather than a directory",
  },
  {
    expected: "CORPUS_ROOT_UNVERSIONED", kind: "PLAIN_DIR",
    label: "a directory no repository governs",
  },
  {
    expected: "CORPUS_ROOT_DIRTY", kind: "DIRTY_REPO",
    label: "a repository holding uncommitted content",
  },
] as const);

const rootForCase = (kind: (typeof CORPUS_REFUSAL_CASES)[number]["kind"]): string | undefined => {
  if (kind === "PLAIN_DIR") return newScratchDir("plain");
  if (kind === "DIRTY_REPO") return newCorpusRepo("dirty", true);
  if (kind === "FILE") {
    const path = join(newScratchDir("file"), "corpus.md");
    writeFileSync(path, "not a directory\n");
    return path;
  }
  return undefined;
};

const applyCase = (testCase: (typeof CORPUS_REFUSAL_CASES)[number]): void => {
  if (testCase.kind === "UNSET") {
    delete process.env[PINNED_DOCUMENT_ROOT_ENV];
    return;
  }
  process.env[PINNED_DOCUMENT_ROOT_ENV] =
    testCase.kind === "LITERAL" ? testCase.root : rootForCase(testCase.kind) ?? "";
};

const refusalOf = (value: unknown): PreFreezeAuditRefusal => value as PreFreezeAuditRefusal;

describe("pinned corpus authority (task-e1b479134f6c4c2282bd7b13af693460)", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[PINNED_DOCUMENT_ROOT_ENV];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[PINNED_DOCUMENT_ROOT_ENV];
    else process.env[PINNED_DOCUMENT_ROOT_ENV] = saved;
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  afterAll(() => {
    for (const path of scratch) rmSync(path, { force: true, recursive: true });
  });

  it("sweeps eight distinct corpus conditions over four distinct codes", () => {
    expect(CORPUS_REFUSAL_CASES.length).toBe(8);
    expect(new Set(CORPUS_REFUSAL_CASES.map(({ label }) => label)).size).toBe(8);
    expect(new Set(CORPUS_REFUSAL_CASES.map(({ expected }) => expected)).size).toBe(4);
    expect(Object.isFrozen(CORPUS_REFUSAL_CASES)).toBe(true);
  });

  for (const testCase of CORPUS_REFUSAL_CASES) {
    it(`refuses at its own code when ${testCase.label}`, () => {
      applyCase(testCase);
      const authority = readPinnedCorpusAuthority();
      expect(isPinnedCorpusAuthority(authority)).toBe(false);
      expect(refusalOf(authority).code).toBe(testCase.expected);
      expect(refusalOf(authority).layer).toBe(PRE_FREEZE_AUDIT_LAYER);

      const document = readPinnedBenchmarkSpec();
      expect(isPinnedDocument(document)).toBe(false);
      expect(refusalOf(document).code).toBe(testCase.expected);
      expect(refusalOf(document).layer).toBe(PRE_FREEZE_AUDIT_LAYER);
    });
  }

  /**
   * The moved-tree condition is the one that cannot be posed by a static root: it is a
   * property of the corpus DURING the read. The fs read is wrapped only to supply that
   * timing — both authority observations and the comparison between them are the real
   * production ones, so the code below is what the module decided, not what a helper did.
   */
  it("refuses a corpus that moves between the two authority observations", async () => {
    const root = newCorpusRepo("moving", false);
    process.env[PINNED_DOCUMENT_ROOT_ENV] = root;
    expect(isPinnedCorpusAuthority(readPinnedCorpusAuthority())).toBe(true);

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const real = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...real,
        readFileSync: (...args: Parameters<typeof real.readFileSync>) => {
          real.writeFileSync(join(root, "landed-mid-read.md"), "the tree moved\n");
          return real.readFileSync(...args);
        },
      };
    });
    const fresh = await import("./pre-freeze-pinned-documents.js");
    const document = fresh.readPinnedBenchmarkSpec();

    expect(fresh.isPinnedDocument(document)).toBe(false);
    expect(refusalOf(document).code).toBe("CORPUS_ROOT_MOVED");
    expect(refusalOf(document).layer).toBe(PRE_FREEZE_AUDIT_LAYER);
  });

  /**
   * DoD 3's second clause. The strong form is a CORRECT digest: if even the genuine pinned
   * SHA cannot buy a document past an authority that refused, no forged one can either.
   */
  it("never lets a caller-supplied SHA stand in for observed Git authority", () => {
    expect(readPinnedBenchmarkSpec.length).toBe(0);
    expect(readPinnedRebuildDesign.length).toBe(0);
    const forge = readPinnedBenchmarkSpec as unknown as (sha: string) => unknown;

    delete process.env[PINNED_DOCUMENT_ROOT_ENV];
    expect(refusalOf(forge(PINNED_BENCHMARK_SPEC_SHA256)).code).toBe("CORPUS_ROOT_UNSET");

    process.env[PINNED_DOCUMENT_ROOT_ENV] = newCorpusRepo("forged", true);
    expect(refusalOf(forge(PINNED_BENCHMARK_SPEC_SHA256)).code).toBe("CORPUS_ROOT_DIRTY");
    expect(refusalOf(forge(PINNED_BENCHMARK_SPEC_SHA256)).layer).toBe(PRE_FREEZE_AUDIT_LAYER);
  });

  /**
   * The portability assertion this row is named for. It is stated over the module's own
   * exported surface rather than over a grep, so restoring the deleted default reds it.
   */
  it("carries no built-in corpus root, so no host is privileged over another", async () => {
    const surface = await import("./pre-freeze-pinned-documents.js");
    for (const value of Object.values(surface)) {
      if (typeof value === "string") expect(value).not.toMatch(/^[A-Za-z]:[\\/]/);
    }
    expect("DEFAULT_PINNED_DOCUMENT_ROOT" in surface).toBe(false);

    delete process.env[PINNED_DOCUMENT_ROOT_ENV];
    expect(refusalOf(readPinnedBenchmarkSpec()).code).toBe("CORPUS_ROOT_UNSET");
    expect(refusalOf(readPinnedRebuildDesign()).code).toBe("CORPUS_ROOT_UNSET");
  });
});
