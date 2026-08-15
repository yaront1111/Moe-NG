# Gotcha: Bash tool is Git Bash — PowerShell here-strings corrupt commit messages silently

This repo's harness exposes BOTH a PowerShell tool and a Bash tool. The Bash tool is Git Bash
(POSIX sh). The tool description for PowerShell documents `@'...'@` here-strings for multi-line
commit messages; that syntax is **not** bash and does not error there.

Seen 2026-08-07 on task-84e875f9. Running in the Bash tool:

```bash
git commit -m @'
feat(scheduler): add anti-blocking admission
...
'@ -- <paths>
```

bash concatenated `@` + the single-quoted body + `@` into one argument, so the commit landed with a
literal `@` as its first line and another `@` as its last:

```
@
feat(scheduler): add anti-blocking admission
...
Co-Authored-By: ...
@
```

`git log --oneline` rendered the subject as `@ feat(scheduler): ...`. The commit was otherwise
correct — right tree, right pathspec — which is exactly why it is easy to miss.

## Rules
- Multi-line commit message in the **Bash** tool: write the message to a file and use
  `git commit -F <file>`, or use a real heredoc (`git commit -F - <<'MSG' ... MSG`). Use `@'...'@`
  ONLY in the PowerShell tool.
- Always verify after committing: `git log -1 --format='%B' | head -3` and `| tail -3`.
  `git show --stat --oneline` alone will not make a mangled body obvious.
- Fixing it is a message-only `git commit --amend -F <file>`; the tree stays byte-identical. Note the
  amend in the step note so it does not read as a silent history rewrite.

## RECURRED 2026-08-08 (task-556d87c3)

Same mistake, different session, after this memory already existed: `git commit -m @'...'@` in the
Bash tool, literal `@` in the subject again. Reading the memory is not what stops it — the habit is
formed by the PowerShell tool description sitting right there in the prompt. Treat "multi-line
commit message" as an unconditional trigger to write the message with the Write tool and pass
`-F <file>`. Never type `-m` with a newline in it.

In a SHARED working tree, guard the fix-up amend so it cannot rewrite a commit that appeared
underneath you: `if [ "$(git rev-parse HEAD)" = "$(git rev-parse <your-sha>)" ]; then git commit
--amend -F <file> --only -- <path>; fi`. See `mem:gotcha-shared-index-commit-capture`.

## Second Bash-tool trap from the same session
A `python - <<'PY' ... PY` heredoc whose body contained Python triple-quoted strings died with
`bash: -c: line NN: unexpected EOF while looking for matching \`''`. When a heredoc body has heavy
quoting, skip it: use the Write tool to emit the script (or the file content) directly. Also note the
Bash tool's working directory PERSISTS across calls — a bare `cd packages/scheduler` in one call
makes the next call's relative paths resolve from there.
