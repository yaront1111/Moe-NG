import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ScopeObserverError, type GitRefListing } from "./scope-contract.js";
import {
  MAX_SCOPE_OBSERVATION_BYTES,
  createNodeGitObserver,
  hermeticGitEnvironment,
  parseRefListing,
} from "./scope-git.js";

/**
 * listRefs() is an external-effect boundary, so it is covered from two sides and
 * neither side alone would be honest.
 *
 * The end-to-end cases spawn a REAL git against a temp repository, because a
 * fake observer would prove only that the fake agrees with itself — the argv,
 * the hermetic environment and git's actual `for-each-ref` grammar are exactly
 * the parts a fake cannot check.
 *
 * The refusal cases drive `parseRefListing` directly with injected bytes. That
 * is the production parser, not a reimplementation: `listRefs()` is literally
 * `parseRefListing(git(argv))`. Real git cannot be made to emit a truncated
 * record or invalid UTF-8 on demand, so injection is the only way to reach
 * those branches at all — and every one of them asserts the exact code AND that
 * GIT_OBSERVER was the refusing layer, never merely that it threw.
 */

const repositories: string[] = [];

afterAll(() => {
  for (const path of repositories) {
    rmSync(path, { force: true, recursive: true });
  }
});

/** A real repository with one commit on `main` and a fabricated remote ref. */
function temporaryRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "moe-runner-refs-"));
  repositories.push(root);
  const git = (...args: readonly string[]): void => {
    execFileSync("git", [...args], {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_DATE: "@0 +0000", GIT_COMMITTER_DATE: "@0 +0000" },
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
  };
  git("init", "--initial-branch=main", "--quiet");
  git("config", "user.email", "scope@example.invalid");
  git("config", "user.name", "Scope Test");
  // Content differs per repository on purpose. Author/committer dates are
  // pinned above, so identical content would produce an identical commit id and
  // the digest-separation assertion below would pass for the wrong reason.
  writeFileSync(join(root, "seed.txt"), `seed ${repositories.length}\n`);
  git("add", "seed.txt");
  git("commit", "--quiet", "--no-gpg-sign", "-m", "seed");
  git("branch", "feature/one");
  // A remote-tracking ref without a remote: refs/remotes is in scope and the
  // observation must include it, so it is created directly rather than fetched.
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  return root;
}

function observe(root: string): GitRefListing {
  const observer = createNodeGitObserver(root, hermeticGitEnvironment(process.env));
  if (observer.listRefs === undefined) throw new Error("listRefs is not implemented");
  return observer.listRefs();
}

/** Builds git's exact wire shape: NUL between fields, LF terminating each record. */
function record(refName: string, objectName: string, objectType: string): string {
  return `${refName}\0${objectName}\0${objectType}\0\n`;
}

const COMMIT = "0".repeat(40);
const COMMIT_SHA256 = "a".repeat(64);

// 30s: these cases run real git subprocesses (~seconds each unloaded); the 5s
// default times out under full-fleet parallelism. Same repair as daemon 03fd290.
describe("createNodeGitObserver().listRefs — real git", { timeout: 30_000 }, () => {
  it("enumerates refs/heads and refs/remotes with their target commits", () => {
    const listing = observe(temporaryRepository());
    const names = listing.refs.map((ref) => ref.refName);
    expect(names).toContain("refs/heads/main");
    expect(names).toContain("refs/heads/feature/one");
    expect(names).toContain("refs/remotes/origin/main");
    // Non-vacuity: an empty listing would satisfy every "does not contain" check
    // written against this surface, which is the defect this guard exists for.
    expect(listing.refs.length).toBeGreaterThanOrEqual(3);
    expect(listing.refCount).toBe(listing.refs.length);
    for (const ref of listing.refs) {
      expect(ref.targetCommit).toMatch(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u);
    }
  });

  it("orders refs by code unit and returns a frozen observation", () => {
    const listing = observe(temporaryRepository());
    const names = listing.refs.map((ref) => ref.refName);
    expect(names).toEqual([...names].sort());
    expect(Object.isFrozen(listing)).toBe(true);
    expect(Object.isFrozen(listing.refs)).toBe(true);
    expect(Object.isFrozen(listing.refs[0])).toBe(true);
  });

  it("binds the observation to a digest, so an empty result is never bare absence", () => {
    const first = observe(temporaryRepository());
    const second = observe(temporaryRepository());
    expect(first.observationDigest).toMatch(/^[0-9a-f]{64}$/u);
    // Two repositories built by the same script differ only in commit identity,
    // so the digest must still separate them: it covers content, not just shape.
    expect(first.observationDigest).not.toBe(second.observationDigest);
  });

  it("leaves the other observer methods reachable and unchanged", () => {
    const root = temporaryRepository();
    const observer = createNodeGitObserver(root, hermeticGitEnvironment(process.env));
    expect(observer.headCommit()).toMatch(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u);
    expect(observer.lsFilesTracked()).toEqual(["seed.txt"]);
  });
});

interface RefusalCase {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly code: string;
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Splices one raw byte into a record: no string literal can carry invalid UTF-8. */
function withRawByte(prefix: string, byte: number, suffix: string): Uint8Array {
  const head = encode(prefix);
  const tail = encode(suffix);
  const bytes = new Uint8Array(head.length + 1 + tail.length);
  bytes.set(head, 0);
  bytes[head.length] = byte;
  bytes.set(tail, head.length + 1);
  return bytes;
}

/**
 * Each fixture below is chosen so that the guard it names is the ONLY thing that
 * can reject it: neuter that one guard and the listing is ACCEPTED, which is what
 * makes the case go red under a mutation drill. Fixtures that merely "look"
 * malformed are worse than no fixture — an earlier guard answers with the same
 * code and the same layer, the case passes, and the guard it claims to cover is
 * never exercised. Three cases here were exactly that and were replaced.
 */
const MALFORMED_CASES: readonly RefusalCase[] = Object.freeze([
  {
    // Fatal UTF-8 decoding is the only rejector: the bad byte sits INSIDE an
    // otherwise well-formed record, so lenient decoding turns it into U+FFFD,
    // the name still starts with refs/heads/, the target is still lowercase hex
    // and the type is still `commit` — the listing is accepted and reports a ref
    // name git never emitted. (Four loose bytes would be caught by field count.)
    id: "invalid-utf8-inside-a-well-formed-record",
    bytes: withRawByte("refs/heads/ma", 0xff, `in\0${COMMIT}\0commit\0\n`),
    code: "RUNNER_SCOPE_STATUS_MALFORMED",
  },
  {
    // The LF-terminator guard is the only rejector: this is a COMPLETE four-field
    // record whose LF was replaced by another byte, so dropping the guard makes
    // slice(0, -1) chop the stray byte instead and four valid fields survive.
    // (Ending at the record's own NUL would be caught by field count instead.)
    id: "record-terminated-by-a-byte-other-than-lf",
    bytes: encode(`refs/heads/main\0${COMMIT}\0commit\0X`),
    code: "RUNNER_SCOPE_STATUS_MALFORMED",
  },
  {
    // The field-count guard is the only rejector: the record lost its trailing
    // NUL, so it carries three fields that are each individually valid — scope,
    // commit type and hex target all pass once the count is no longer checked.
    // (Dropping the TYPE field instead would be caught by the objecttype guard.)
    id: "record-missing-its-trailing-nul",
    bytes: encode(`refs/heads/main\0${COMMIT}\0commit\n`),
    code: "RUNNER_SCOPE_STATUS_MALFORMED",
  },
  {
    id: "extra-field",
    bytes: encode(`refs/heads/main\0${COMMIT}\0commit\0surplus\0\n`),
    code: "RUNNER_SCOPE_STATUS_MALFORMED",
  },
  {
    id: "empty-ref-name",
    bytes: encode(`\0${COMMIT}\0commit\0\n`),
    code: "RUNNER_SCOPE_STATUS_MALFORMED",
  },
  {
    id: "out-of-scope-ref",
    bytes: encode(record("refs/tags/v1", COMMIT, "commit")),
    code: "RUNNER_SCOPE_STATUS_MALFORMED",
  },
  {
    id: "duplicate-ref",
    bytes: encode(record("refs/heads/main", COMMIT, "commit") + record("refs/heads/main", COMMIT, "commit")),
    code: "RUNNER_SCOPE_STATUS_MALFORMED",
  },
  {
    id: "non-commit-target",
    bytes: encode(record("refs/tags/v1", COMMIT, "tag").replace("refs/tags/v1", "refs/heads/main")),
    code: "RUNNER_SCOPE_STATUS_MALFORMED",
  },
  {
    id: "uppercase-hex-target",
    bytes: encode(record("refs/heads/main", "A".repeat(40), "commit")),
    code: "RUNNER_SCOPE_STATUS_MALFORMED",
  },
  {
    id: "short-hex-target",
    bytes: encode(record("refs/heads/main", "0".repeat(39), "commit")),
    code: "RUNNER_SCOPE_STATUS_MALFORMED",
  },
]);

describe("parseRefListing — refusals carry an exact code and the GIT_OBSERVER layer", () => {
  it("runs every hand-authored case exactly once", () => {
    // Guards the table itself: a sweep that silently produces zero cases passes
    // while testing nothing, so the count and the id set are both pinned.
    expect(MALFORMED_CASES.length).toBeGreaterThan(0);
    expect(MALFORMED_CASES.length).toBe(10);
    expect(new Set(MALFORMED_CASES.map((entry) => entry.id)).size).toBe(MALFORMED_CASES.length);
  });

  it.each(MALFORMED_CASES.map((entry) => [entry.id, entry] as const))(
    "refuses %s",
    (_id, entry) => {
      let thrown: unknown;
      try {
        parseRefListing(entry.bytes, "for-each-ref");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ScopeObserverError);
      const failure = thrown as ScopeObserverError;
      expect(failure.code).toBe(entry.code);
      expect(failure.layer).toBe("GIT_OBSERVER");
    },
  );

  it("accepts a well-formed listing, including the sha256 object format", () => {
    const listing = parseRefListing(
      encode(
        record("refs/heads/main", COMMIT, "commit") +
          record("refs/remotes/origin/main", COMMIT_SHA256, "commit"),
      ),
      "for-each-ref",
    );
    expect(listing.refs.map((ref) => ref.refName)).toEqual([
      "refs/heads/main",
      "refs/remotes/origin/main",
    ]);
    expect(listing.refs[1]?.targetCommit).toBe(COMMIT_SHA256);
  });

  it("treats a repository with no refs as a successful empty observation, not absence", () => {
    const listing = parseRefListing(new Uint8Array(), "for-each-ref");
    expect(listing.refs).toEqual([]);
    expect(listing.refCount).toBe(0);
    // The rail: an empty listing is never bare proof of absence. It still
    // carries a digest, so a caller can tell "observed, nothing there" apart
    // from "never observed".
    expect(listing.observationDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("sorts by code unit rather than locale", () => {
    const listing = parseRefListing(
      encode(
        record("refs/heads/b", COMMIT, "commit") +
          record("refs/heads/A", COMMIT, "commit") +
          record("refs/heads/a", COMMIT, "commit"),
      ),
      "for-each-ref",
    );
    // Locale collation would give A, a, b. Code-unit order puts uppercase first.
    expect(listing.refs.map((ref) => ref.refName)).toEqual([
      "refs/heads/A",
      "refs/heads/a",
      "refs/heads/b",
    ]);
  });
});

describe("listRefs overflow and spawn classification", () => {
  it("keeps the overflow ceiling at the existing observation bound", () => {
    expect(MAX_SCOPE_OBSERVATION_BYTES).toBe(8 * 1024 * 1024);
  });

  it("refuses a missing repository with the failure code and the observer layer", () => {
    const missing = join(tmpdir(), "moe-runner-refs-absent-directory");
    let thrown: unknown;
    try {
      observe(missing);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ScopeObserverError);
    const failure = thrown as ScopeObserverError;
    expect(failure.code).toBe("RUNNER_SCOPE_OBSERVATION_FAILED");
    expect(failure.layer).toBe("GIT_OBSERVER");
  });

  it("does not loosen the hermetic environment", () => {
    const environment = hermeticGitEnvironment({ GIT_DIR: "/hijack", PATH: "/usr/bin" });
    expect(environment["GIT_DIR"]).toBeUndefined();
    expect(environment["GIT_CONFIG_NOSYSTEM"]).toBe("1");
    expect(environment["GIT_OPTIONAL_LOCKS"]).toBe("0");
    expect(environment["LC_ALL"]).toBe("C");
  });
});
