import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

import {
  type PreFreezeAuditRefusal, preFreezeAuditRefusal,
} from "./pre-freeze-audit-vocabulary.js";
import {
  PINNED_BENCHMARK_SPEC_SHA256, PINNED_REBUILD_DESIGN_SHA256, type PinnedSource,
  isPinnedSource, readPinnedSource,
} from "./pre-freeze-source-reader.js";

/**
 * THE THIN CALLER: the only place in this package that touches a filesystem path.
 *
 * The pre-freeze audit itself is pure — it takes bytes and a digest. That is deliberate,
 * and it leaves exactly one job here: turn "the pinned benchmark spec" into bytes. Keeping
 * that job in its own file is what lets every audit module stay testable without a host
 * layout, and it means a change of checkout location touches one constant.
 *
 * THERE IS NO DEFAULT ROOT, AND THAT IS THE POINT. This module used to fall back to one
 * developer's absolute checkout path. A built-in default does not make a corpus portable;
 * it makes the audit PASS on exactly one machine and refuse on every other, while the test
 * suite that runs on that machine reports green. That is worse than refusing everywhere,
 * because the green is the thing a reader trusts. `MOE_PINNED_DOCUMENT_ROOT` is now
 * mandatory, and an unset variable is a refusal with its own code rather than a path.
 *
 * (`@moe/contracts` still declares the old literal as `PHASE0_SOURCE_REPOSITORY`. That is
 * FROZEN HISTORICAL PROVENANCE — a record of where phase zero was performed — and not a
 * live default. It is deliberately untouched; the two are unrelated despite the shared
 * string, and rewriting it would falsify evidence to fix a configuration bug.)
 *
 * AUTHORITY IS OBSERVED, NEVER ACCEPTED. The corpus is believed only when Git says what it
 * is: the root must resolve, be governed by a repository, be clean, and hold still across
 * the read. A caller cannot hand in a SHA to stand in for any of that — the public readers
 * take no arguments at all, and the authority checks run BEFORE the pinned digest is
 * consulted, so no supplied digest can reach a document that authority already refused.
 *
 * IT REFUSES; IT NEVER SKIPS. An unreadable document comes back as SPEC_UNPARSEABLE at
 * `PRE_FREEZE_AUDIT` and a document whose bytes have moved comes back as
 * SPEC_BYTES_UNPINNED. Neither is an absence a caller may treat as "nothing to check":
 * under epic rail 4 unverifiable evidence stays refused and never gains authority, and a
 * freeze gate that quietly passed when it could not read its input would be worse than no
 * gate at all.
 */

/** Where the pinned, read-only documents live. Mandatory: there is no fallback. */
export const PINNED_DOCUMENT_ROOT_ENV = "MOE_PINNED_DOCUMENT_ROOT";

export const PINNED_BENCHMARK_SPEC_RELATIVE_PATH =
  "docs/plans/2026-08-05-moe-best-tool-benchmark-spec.md";
export const PINNED_REBUILD_DESIGN_RELATIVE_PATH =
  "docs/plans/2026-08-05-moe-rebuild-design.md";

/** Verified bytes plus the parsed source, so a caller can re-hash without re-reading. */
export type PinnedDocument = {
  readonly bytes: Uint8Array;
  readonly path: string;
  readonly source: PinnedSource;
};

/**
 * What Git said about the corpus, at one instant. `status` is retained rather than reduced
 * to a boolean because it is also the moved-tree comparand: a corpus can go from one dirty
 * state to a different dirty state mid-read without its HEAD changing.
 */
export type PinnedCorpusAuthority = {
  readonly head: string;
  readonly root: string;
  readonly status: string;
};

export const isPinnedDocument = (
  value: PinnedDocument | PreFreezeAuditRefusal,
): value is PinnedDocument => !("code" in value);

export const isPinnedCorpusAuthority = (
  value: PinnedCorpusAuthority | PreFreezeAuditRefusal,
): value is PinnedCorpusAuthority => !("code" in value);

const gitOutput = (root: string, args: readonly string[]): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(execFileSync("git", ["-C", root, ...args], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }));

/**
 * Resolves the configured root, or refuses. Blank and whitespace-only are treated as unset
 * rather than as the current directory: `MOE_PINNED_DOCUMENT_ROOT=` in a shell profile is
 * a variable someone meant to fill in, and reading the process CWD as a corpus would be a
 * silent guess of exactly the kind this module exists to stop making.
 */
const resolveCorpusRoot = (): string | PreFreezeAuditRefusal => {
  const configured = process.env[PINNED_DOCUMENT_ROOT_ENV]?.trim();
  if (!configured) return preFreezeAuditRefusal("CORPUS_ROOT_UNSET", 0, "");
  try {
    if (!statSync(configured).isDirectory()) {
      return preFreezeAuditRefusal("CORPUS_ROOT_UNREADABLE", 0, configured);
    }
  } catch {
    return preFreezeAuditRefusal("CORPUS_ROOT_UNREADABLE", 0, configured);
  }
  // Trailing separators are stripped so the joined path never doubles them, but NOT off a
  // bare drive designator: `D:\` means the root of D:, while `D:` means the CURRENT
  // directory on D:, and quietly turning one into the other would read a different corpus.
  const trimmed = configured.replace(/[\\/]+$/, "");
  return trimmed && !/^[A-Za-z]:$/.test(trimmed) ? trimmed : configured;
};

/**
 * The RAW observation: what Git says, with no verdict attached. A directory Git cannot
 * answer for is UNVERSIONED rather than unreadable — the bytes are there, but nothing
 * attributes them to a commit, so there is no authority to pin against.
 *
 * Cleanliness is deliberately NOT judged here. A corpus that was clean when the read began
 * and dirty when it ended has MOVED, and that is the more precise repair: folding the
 * dirty verdict into the observation would let the second look answer DIRTY and hide the
 * fact that the tree changed underneath the bytes already taken from it.
 */
const observeCorpusGit = (
  root: string,
): PinnedCorpusAuthority | PreFreezeAuditRefusal => {
  let head: string;
  let status: string;
  try {
    head = gitOutput(root, ["rev-parse", "--verify", "HEAD"]).trim();
    status = gitOutput(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  } catch (error) {
    // A status too large for the buffer is not an unreadable repository — it is an
    // emphatically dirty one, and reporting it as UNVERSIONED would send the reader to
    // look for a missing `.git`. A sibling module caps this at 64 KiB and does exactly
    // that mislabelling once a tree collects a few thousand untracked files.
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOBUFS") {
      return preFreezeAuditRefusal("CORPUS_ROOT_DIRTY", 0, root);
    }
    return preFreezeAuditRefusal("CORPUS_ROOT_UNVERSIONED", 0, root);
  }
  if (!/^[a-f0-9]{40}$/.test(head)) {
    return preFreezeAuditRefusal("CORPUS_ROOT_UNVERSIONED", 0, root);
  }
  return Object.freeze({ head, root, status });
};

/** Authority a caller may act on: observed, and clean enough for HEAD to describe it. */
export const observePinnedCorpusAuthority = (
  root: string,
): PinnedCorpusAuthority | PreFreezeAuditRefusal => {
  const observed = observeCorpusGit(root);
  if (!isPinnedCorpusAuthority(observed)) return observed;
  if (observed.status.length > 0) return preFreezeAuditRefusal("CORPUS_ROOT_DIRTY", 0, root);
  return observed;
};

/**
 * The corpus authority for this host, or the exact reason it may not be believed. Exported
 * so a caller — including a test deciding whether its real-byte arms can run — asks the
 * PRODUCTION surface that question instead of re-deriving it from a path check of its own.
 */
export const readPinnedCorpusAuthority = (): PinnedCorpusAuthority | PreFreezeAuditRefusal => {
  const root = resolveCorpusRoot();
  if (typeof root !== "string") return root;
  return observePinnedCorpusAuthority(root);
};

const readPinnedDocument = (
  relativePath: string,
  expectedSha256: string,
): PinnedDocument | PreFreezeAuditRefusal => {
  const before = readPinnedCorpusAuthority();
  if (!isPinnedCorpusAuthority(before)) return before;
  const path = `${before.root}/${relativePath}`;
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    return preFreezeAuditRefusal("SPEC_UNPARSEABLE", 0, path);
  }
  const after = observeCorpusGit(before.root);
  if (!isPinnedCorpusAuthority(after)) return after;
  if (before.head !== after.head || before.status !== after.status) {
    return preFreezeAuditRefusal("CORPUS_ROOT_MOVED", 0, before.root);
  }
  const source = readPinnedSource(bytes, expectedSha256);
  if (!isPinnedSource(source)) return source;
  return Object.freeze({ bytes, path, source });
};

export const readPinnedBenchmarkSpec = (): PinnedDocument | PreFreezeAuditRefusal =>
  readPinnedDocument(PINNED_BENCHMARK_SPEC_RELATIVE_PATH, PINNED_BENCHMARK_SPEC_SHA256);

export const readPinnedRebuildDesign = (): PinnedDocument | PreFreezeAuditRefusal =>
  readPinnedDocument(PINNED_REBUILD_DESIGN_RELATIVE_PATH, PINNED_REBUILD_DESIGN_SHA256);
