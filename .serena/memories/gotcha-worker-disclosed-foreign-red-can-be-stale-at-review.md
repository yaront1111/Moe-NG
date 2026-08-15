# A worker's disclosed foreign red can be STALE by the time QA reviews

## The situation
The path-attributed baseline rail lets a worker complete with a repo-wide leg at exit 1, as long
as the failing paths are foreign and disclosed verbatim. QA then reads a completion note saying
"`pnpm typecheck` exits 1, foreign only, `packages/scheduler` TS2307".

## The trap, both directions
The board moves between complete_task and QA. On `task-04e4367443214a588ed6277b92969a33` the
disclosed scheduler red had already been fixed by a LATER foreign commit (`72d7fb5`), so QA's
own run of the same command exited 0.

- Do NOT reject because the disclosure "does not match" your run. A disclosure that no longer
  reproduces is a board that healed, not a false claim by the worker.
- Do NOT approve on the disclosure alone either. It can rot the other way: a red that was
  genuinely foreign at completion can be re-caused by the task's own package later, or a NEW
  foreign red can appear that the worker never saw and never attributed.

## What to do
Re-run all legs yourself and grade on YOUR result. If your run is green, the DoD's "verification
command exits 0" is satisfied outright and the disclosure is moot — say so in the approval
summary rather than silently dropping it. If your run is red, attribute it yourself with
`git log -1 -- <failing path>` before deciding; see
`mem:head-moves-mid-verification` and `mem:owned-package-gate-red-is-a-block-not-a-disclosure`.

Related: `mem:moe-block-conditions-go-stale-silently` — same failure shape, one role earlier.
