# Repository hygiene policy — implementation handoff

Task `task-5d79649c08984168acfd3eb0f417e5dc` implemented by `worker-4dddabde`.
Commit `7678402`, exactly 2 owned paths, +213 / -0.
Gate: `git diff --check && git status --short && pnpm test` exit 0, 59 files / 573 tests.

## What shipped

- Root `.gitignore` +46 lines: a commented, leaf-by-leaf Moe runtime block.
  Pure append after line 11; generic rules and `!.env.example` untouched.
- `docs/REPOSITORY_HYGIENE.md`, 167 lines: durable/regenerable tables, the
  tracking-vs-ignoring-vs-deleting distinction, prohibitions, and a 6-step
  fail-closed cleanup procedure. Nothing was deleted by this task.

## The load-bearing design fact

**No moe-next source writes `.moe/`.** Grep for `activity.log|daemon.lock|
daemon.json|'workers'|'teams'|'proposals'|'sessions'|'cache'|'debug'|'tmp'|
'scratch'` across every `*.{ts,js,mts,cts}` returns ZERO matches — the producer
is the external transitional old-Moe daemon.

So future leaf names cannot be derived from this repo, and the doc's table is
the only authority. This is why the block is allow-by-omission and why a
blanket `.moe/` or `.moe/**` rule is forbidden: it would silently hide a new
durable record class. Unlisted paths stay visible and default to tracked.

## Two properties that must not be "simplified" away

1. **Root-anchoring (`/` prefix) is load-bearing, not style.** Unanchored
   `.moe/cache/` would also match `packages/testkit/fixtures/.moe/cache/` and
   could hide phase-zero evidence fixtures. Verified: nested fixture `.moe/`
   paths stay visible.
2. **`/.moe/activity.log.*` closes a real gap.** The generic `*.log` catches
   `activity.log` but NOT rotations like `activity.log.1`.

The five rules duplicated from `.moe/.gitignore` (daemon.json, daemon.lock,
workers/, teams/, proposals/) are deliberately redundant — the nested file wins
precedence, but the root block keeps the whole boundary readable in one place
and survives if the nested file is removed.

## Open item for whoever builds the session coordination fabric

`.moe/sessions/` is classified regenerable and is the ONE speculative leaf.
This epic plans a durable session coordination fabric (`task-f837ce45`). If it
ever persists under `.moe/sessions/` rather than in the store, this rule hides
durable records. The doc carries a provisional caveat saying to re-check that
row before that work lands. Verified as the only guessed name in the block.

## Verification method worth reusing

Prove an ignore boundary with Git's own matcher, both directions, not by eye:
- positive: every regenerable probe must be ignored (13/13 here)
- negative: durable, source, and nested-fixture probes must be visible (15/15)
- over-match: substring collisions like `skills/cache-warmer/`,
  `roles/worker-sessions.json`, `tasks/task-cache.json` must stay visible
- regression: `git ls-files -z | git check-ignore --stdin -z -v` must return
  ZERO rows, else a tracked file became phantom-ignored

See `gotcha-git-check-ignore-negation-exit-code` for the trap that made an
early probe of mine falsely report `.env.example` as broken.
