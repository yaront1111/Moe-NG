# `pnpm ... | tail` reports TAIL's exit code, so a red gate reads as green

Hit 2026-08-09 while QA'ing `task-671578e5`. Cost one wrong "gates pass" read before it was
caught.

## The trap

```bash
pnpm --filter @moe/daemon typecheck 2>&1 | tail -20 && echo "EXIT $?" && pnpm ... test
```

`$?` after a pipeline is the LAST command's status — `tail` — which is always 0. So:
- the `&&` does NOT short-circuit on a failed gate, and
- the echoed "EXIT 0" is a lie.

The gate had genuinely failed (`Exit status 1` was even visible in the tail output) and the
chain marched on to the next leg regardless. Any role verifying a gate this way will report a
pass that never happened, which is exactly the fabricated-green epic rail 4 forbids.

## Do this instead

```bash
pnpm --filter @moe/daemon typecheck > /tmp/a.txt 2>&1; A=$?
pnpm --filter @moe/daemon test      > /tmp/b.txt 2>&1; B=$?
pnpm typecheck                       > /tmp/c.txt 2>&1; C=$?
echo "typecheck=$A test=$B root=$C"
grep -hE "error TS" /tmp/a.txt /tmp/c.txt | sort -u
```

Redirect to a file, capture `$?` on the very next statement, grep the file afterwards. Use `;`
not `&&` between legs so one red leg does not hide the state of the others. If you must pipe,
`${PIPESTATUS[0]}` holds the first command's status — but only immediately after, and it is
easy to lose.

## Two companions worth pairing with it

- `pnpm typecheck` (recursive) BAILS on the first failing package, so a single red package hides
  the rest of the repo. Run `pnpm -r --no-bail typecheck` to enumerate every failing path before
  attributing blame — the path-attributed-baseline rail needs the FULL set, not the first one.
- TS6133 "declared but never read" can MASK later errors in the same file. `tsc --noUnusedLocals
  false` flushes them out: on this task it turned two unused-import errors into a real
  `TS2304: Cannot find name 'EMPTY_REVIEW_LINEAGE'`, which changed the picture of what the
  foreign file was actually doing.

Related: `mem:moe-shared-worktree-blocks-root-gates`,
`mem:mutation-drills-in-shared-worktree`.
