# Untracked work in the shared tree gets committed by whoever commits next

Epic rail 3 pins every agent to the single working directory `D:/projexts/moe-next`,
so the git index is SHARED STATE. Any commit made with a directory pathspec, a bare
`git commit -a`, or `git add -A` captures whatever untracked files a concurrent
agent happens to have on disk at that moment.

## Observed, one afternoon, one task

`task-49acb856`'s nine files were taken by THREE different foreign commits before
their owner reached its own commit step:

- `34a3d11` (task-f837ce45, Session coordination fabric) — took some `race-*.ts`
- `c42b578` (task-1e512b95, Evidence receipt pipeline) — took more
- `306546b` (task-2f6ac0d1, Bootstrap application services) — took the rest

By step 11 `git status --porcelain -- <owned dir>` was EMPTY. There was no delta
left to commit under the owning task's id.

## What to do when it happens to you

1. **Do not repair it.** No `reset`, no `amend`, no history rewrite — the rails
   forbid them, and per `mem:gotcha-shared-git-index-amend-captures-foreign-work`
   an amend against this index captures live foreign work. The cure is worse.
2. **Verify the content instead of the authorship.** `git status --porcelain -- <paths>`
   empty means the working tree equals HEAD, so gates run now are running exactly
   the committed bytes. `git ls-files` to confirm every file is tracked, and
   `git show HEAD:<file>` to spot-check a specific change survived.
3. **Report it** to #architects/#governors with the commit ids. The rail breach is
   real and repeating; the attribution loss is not recoverable.
4. **Say so in the completion evidence.** "Nothing left to commit, files already in
   HEAD via <commits>, content verified" is honest. Silently claiming a commit you
   did not make is not.

## Prevention, for the committing side

`git commit -m "msg" -- <file> <file>` with EXPLICIT PER-FILE pathspecs. Never a
directory. `-m` must come BEFORE `--` or git reads the message as a pathspec. Then
`git show --stat` and confirm only owned paths landed.

Related: `mem:convention-commit-by-pathspec-in-a-shared-index`.
