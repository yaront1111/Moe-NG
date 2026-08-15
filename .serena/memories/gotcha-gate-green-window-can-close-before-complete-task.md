# A green gate window can close before you reach complete_task

In this shared worktree several agents write into `apps/daemon` at once. On
2026-08-15 the plan gate for one task flickered as follows over ~40 minutes:

    21:09  green (85 files)      21:11  red  (telemetry/, untracked peer tree)
    21:25  GREEN, full gate      21:26  red  (mcp-dispatch-port.test.ts, peer edit)
    21:47  red  (configuration/, recovery/effect-inventory*, daemon-entry.ts)

`moe.complete_task` requires `verification.exitCode === 0`, so a green run you
took ten minutes ago is not evidence you can still reproduce.

## What to do

1. **Run the gate BEFORE you spend time on the write-up.** The moment it is
   green, capture the verbatim output — that is your evidence.
2. **Poll, do not narrow.** A bounded foreground loop (`for i in 1..12; ...;
   sleep 50`) is honest; `--exclude` is not
   (`mem:gotcha-gate-narrowed-by-exclude-reads-as-green`).
3. **Attribute before you submit.** `git log -1 --format='%h %s' -- <path>` on
   every failing file. If none of the owning commits is yours, and no error
   names an owned path, the failing-path delta intersected with owned paths is
   empty and the project rail permits completion on an owned-path-scoped run —
   *with the foreign red disclosed verbatim, including the commit shas*.
4. **Prove the bytes.** `git diff HEAD -- <owned paths>` empty means the bytes
   you gated are the bytes you committed, so an earlier full-gate green still
   describes the committed state.

## The trap

`git status --porcelain` on a failing file coming back EMPTY does not mean the
file is yours or fine — it means a peer **committed** it. HEAD itself can be
red. That is the cleanest possible attribution (the red predates nothing you
did and exists with or without your diff), but only if you actually check the
owning commit instead of assuming a clean file is innocent.

Related: `mem:repo-wide-red-can-be-untracked-peer-file`,
`mem:peer-write-during-test-run-fakes-a-red`,
`mem:owned-package-gate-red-is-a-block-not-a-disclosure`.
