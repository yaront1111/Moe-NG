import { describe, expect, it } from "vitest";

import { ScopeObserverError } from "./scope-contract.js";
import { classifyRefFailure } from "./scope-git-classify.js";

/**
 * The classification listRefs applies to a spawn failure, driven directly.
 *
 * This is the production classifier, not a reimplementation of it: listRefs'
 * catch is literally `throw classifyRefFailure(error)`. Driving it end-to-end
 * instead would need a throwing spawn, and there is no spawn port —
 * createNodeGitObserver closes over a private runGit that calls execFileSync,
 * so the only shapes real git can be made to produce are the pass-through ones.
 *
 * Every case asserts `code` and `layer` as SEPARATE expectations. A single
 * assertion covering both halves is how the previous round of this branch
 * stayed dark: a mutation replacing the code and the layer together reddened
 * nothing.
 */

/** Mirrors how runGit attaches the spawn fault, which is a bare assignment. */
const withCause = (error: ScopeObserverError, cause: unknown): ScopeObserverError =>
  Object.assign(error, { cause });

describe("classifyRefFailure", () => {
  it("keeps an already-overflowed refusal at the overflow code and the observer layer", () => {
    const classified = classifyRefFailure(
      new ScopeObserverError("RUNNER_SCOPE_OBSERVATION_OVERFLOW", "git for-each-ref exceeded"),
    );

    expect(classified).toBeInstanceOf(ScopeObserverError);
    expect(classified.code).toBe("RUNNER_SCOPE_OBSERVATION_OVERFLOW");
    expect(classified.layer).toBe("GIT_OBSERVER");
  });

  it("promotes an ENOBUFS spawn fault to the overflow code", () => {
    // The win32 shape: execFileSync reports the truncation as ENOBUFS rather
    // than ERR_CHILD_PROCESS_STDIO_MAXBUFFER, so runGit coded it FAILED and only
    // the preserved cause says it was an overflow.
    const classified = classifyRefFailure(
      withCause(
        new ScopeObserverError("RUNNER_SCOPE_OBSERVATION_FAILED", "git for-each-ref failed"),
        { code: "ENOBUFS" },
      ),
    );

    expect(classified.code).toBe("RUNNER_SCOPE_OBSERVATION_OVERFLOW");
    expect(classified.layer).toBe("GIT_OBSERVER");
  });

  it("does not promote a spawn fault whose cause is any other errno", () => {
    // The negative control. Without it the ENOBUFS comparison could be replaced
    // by "has a cause at all" and every case above would stay green.
    const classified = classifyRefFailure(
      withCause(
        new ScopeObserverError("RUNNER_SCOPE_OBSERVATION_FAILED", "git for-each-ref failed"),
        { code: "ENOENT" },
      ),
    );

    expect(classified.code).toBe("RUNNER_SCOPE_OBSERVATION_FAILED");
    expect(classified.layer).toBe("GIT_OBSERVER");
  });

  it("passes an unrelated observer code through unchanged", () => {
    const classified = classifyRefFailure(
      new ScopeObserverError("RUNNER_SCOPE_STATUS_MALFORMED", "git for-each-ref emitted garbage"),
    );

    expect(classified.code).toBe("RUNNER_SCOPE_STATUS_MALFORMED");
    expect(classified.layer).toBe("GIT_OBSERVER");
  });

  it("preserves the refusal message it was handed", () => {
    const classified = classifyRefFailure(
      new ScopeObserverError("RUNNER_SCOPE_OBSERVATION_FAILED", "git for-each-ref failed"),
    );

    expect(classified.message).toBe("git for-each-ref failed");
  });

  const FOREIGN_THROWS: readonly (readonly [string, unknown])[] = Object.freeze([
    ["a plain Error", new Error("spawn EACCES")],
    ["a thrown string", "spawn EACCES"],
    ["undefined", undefined],
    ["null", null],
    ["a coded object that is not a ScopeObserverError", { code: "ENOBUFS" }],
  ]);

  it("generated a non-zero number of foreign-throw cases", () => {
    expect(FOREIGN_THROWS.length).toBeGreaterThan(0);
    expect(FOREIGN_THROWS.length).toBe(5);
  });

  it.each(FOREIGN_THROWS)("codes %s as a bare observation failure", (_label, thrown) => {
    const classified = classifyRefFailure(thrown);

    expect(classified).toBeInstanceOf(ScopeObserverError);
    expect(classified.code).toBe("RUNNER_SCOPE_OBSERVATION_FAILED");
    expect(classified.layer).toBe("GIT_OBSERVER");
  });
});
