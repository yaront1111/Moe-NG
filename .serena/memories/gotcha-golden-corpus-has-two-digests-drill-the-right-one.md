# The golden-stream corpus has TWO digests; a mutation drill must target the cross-package one

Applies to `packages/testkit/src/providers/<provider>/<provider>-golden-streams.ts` (claude and codex both).

Two distinct pinned digests live in that file and they fail different suites:

1. **Per-case `"sha256"` INSIDE the marker-delimited DATA block.** This is the cross-package pin. Runner's `loadGoldenCorpus()` readFileSync's the file, slices between the markers, JSON.parses, and recomputes sha256 over the raw decoded bytes at module scope — so a nibble flip here kills **both** suites at module load, before any assertion consumes the fixture. Runner drops the whole test file (61 tests -> 48, one file failed); testkit reports literally `no tests`.

2. **`<PROVIDER>_GOLDEN_CORPUS_DIGEST`, a top-level constant near the end of the file, OUTSIDE the markers.** This is deliberately in-package only: it pins corpus-level stability for testkit and the runner never reads it. Flipping it fails **only** testkit, and the runner suite stays fully green.

Plan text that says "flip one nibble of the pinned corpus digest — both suites must fail" means (1). Targeting (2) produces a green runner suite that looks exactly like a missing cross-package gate, and it is not one.

Two adjacent drill traps found the same session:
- The JSON in the DATA block is formatted `"sha256": "..."` **with a space**. A grep for `"sha256":"` matches nothing, perl substitutes nothing, and the suite passes for the boring reason that the file was never mutated. Always echo the mutated line back and confirm it changed before scoring the run.
- A "delivery-order GAP" mutation written as `last - first + 1 !== seen.size + malformed` is **semantically identical** to the production set-based rule on the tested inputs, because `last` already tracks the max there. It passes and proves nothing. The mutation that actually bites is the consecutive-arrival rule `if (last !== null && sequence > last + 1) GAP`, which falsely fires on `(1,3,2,4)` and turns 3 tests red.

Restore drills by `sha256sum -c` against a copy taken before the edit, never by `git status` — see `mem:mutation-drills-in-shared-worktree` and `mem:gotcha-untracked-files-need-checksum-not-git-diff-for-drill-restores`.
