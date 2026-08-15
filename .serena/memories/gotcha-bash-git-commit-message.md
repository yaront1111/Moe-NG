# Gotcha: `git commit -m @-` does NOT read the message from stdin

`@-` is a **`gh` CLI** convention (`gh pr create --body-file -`, `gh issue comment -F -`).
Plain `git` treats `-m @-` as the literal message, so:

```sh
git commit -m @- -- <paths> <<'MSG'
subject line
...
MSG
```

silently produces a commit whose entire message is `@-`. The heredoc is consumed by the shell and
discarded; git exits 0, so nothing looks wrong until `git log -1 --format=%B`.

## Correct forms (Bash tool = Git Bash on this repo)

```sh
# preferred: write to a temp file OUTSIDE the repo, then -F
cat > "$TEMP/msg.txt" <<'MSG'
subject

body
MSG
git commit -F "$TEMP/msg.txt" -- <owned paths>
rm -f "$TEMP/msg.txt"
```

Repeated `-m` flags also work (`-m subject -m body`) but mangle multi-paragraph bodies.

Never write the temp message file under the repo root — the Moe wrapper auto-commit sweeps
untracked files (see `gotcha-moe-wrapper-autocommit`). `$TEMP` on Windows Git Bash resolves
outside the worktree.

## Recovery

Message-only `git commit --amend -F <file>` immediately after, before any further work. It
rewrites only your own just-created, unpushed commit, and is not one of the rail-forbidden
operations (`add -A`, push, merge, reset, stash). Verify with `git log -1 --format=%s` and
re-check `git show --stat` afterwards, since amend produces a **new SHA** — quote the new one in
handoff notes.
