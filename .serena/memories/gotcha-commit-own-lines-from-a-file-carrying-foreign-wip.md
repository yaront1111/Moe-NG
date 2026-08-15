# Committing only YOUR lines out of a file that also holds foreign WIP

In this shared worktree a file you must touch often already carries another
task's uncommitted work — `apps/daemon/src/index.ts` and `index-surface.test.ts`
are the repeat offenders, because every new exported symbol or result-union
branch forces an edit to the hand-written package-root closure guard.

**`git commit -- <path>` takes the WORKING TREE copy of that path and ignores the
index.** So the obvious "commit by explicit pathspec" move — the one epic rail 3
asks for — is exactly what steals the foreign work. Staging a hunk first does not
help; the pathspec overrides it.

## The move that works, non-interactively

`git add -p` is unavailable (no interactive flags). Build the blob you want and
put it in the index directly:

```bash
tmp=$(mktemp -d)
git show HEAD:apps/daemon/src/index.ts > "$tmp/index.ts"
# apply ONLY your lines to $tmp/index.ts (sed by line number is fine;
# perl s{}{} breaks on a literal } in the replacement — use a different form)
git show HEAD:apps/daemon/src/index.ts | diff - "$tmp/index.ts"   # eyeball it
sha=$(git hash-object -w "$tmp/index.ts")
git update-index --cacheinfo 100644,"$sha",apps/daemon/src/index.ts
git diff --cached                    # MUST show only your lines
git commit -F -  <<'EOF'             # NO pathspec — the index is the commit
...
EOF
git show --stat HEAD                 # confirm nothing rode along
```

The committed blob is `HEAD` + your lines. The foreign lines stay uncommitted in
the working tree, byte-untouched; when their owner commits, their pathspec commit
carries your already-landed lines harmlessly.

Uses no forbidden verb — no `reset`, no `stash`, no `add -A`. `mktemp -d` keeps
the scratch file out of the repo, so no probe file can land in a commit.

## When this is required rather than optional

When YOUR commit reddened a file you do not own. Widening a result union reddens
`index-surface.test.ts` (daemon `tsconfig.json` includes `src/**/*.ts`, so
`expectTypeOf` mismatches are real `tsc` errors, not runtime no-ops). Leaving it
"disclosed but uncommitted" leaves a landmine at HEAD that your own diff planted
— that is not foreign red and rail 3's path-attribution does not excuse it.

Related: `mem:gotcha-clean-package-reddened-by-foreign-uncommitted-contract`.
