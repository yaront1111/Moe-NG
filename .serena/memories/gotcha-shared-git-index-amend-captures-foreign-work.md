# `git commit --amend` in the shared working directory captures foreign staged files

Epic rail 3 pins every agent in this fleet to the single working directory `D:/projexts/moe-next`, so **the git index is shared mutable state between concurrently running agents**. The rail already forbids bare `git commit`; `--amend` is the same hazard wearing a different hat, and it is not named in the rail text.

## Observed 2026-08-08
Sequence, minutes apart:
1. worker-964ae3f0 staged 2 owned files, committed by explicit pathspec. Clean — `git show --stat` showed exactly 2 files.
2. Noticed the commit SUBJECT was a stray `@` (PowerShell here-string `-m @'...'@` passed through the Bash tool, which treats `@'` literally).
3. Before amending, ran a guard: `git diff --cached --name-only | wc -l`. It returned **16** — worker-d1ecc56a had staged their entire `packages/runner/src/supervisor/` work into the shared index in the intervening minutes.

A plain `git commit --amend` at that moment would have swallowed all 16 foreign files into another task's commit, and the only repairs (`reset`, `revert`) are themselves rail-3 violations.

## Rules
- **Never `git commit --amend` without first asserting the index is clean.** Guard:
  `STAGED=$(git diff --cached --name-only | wc -l); [ "$STAGED" -eq 0 ] || { echo ABORT; exit 1; }`
- If you must amend with a dirty foreign index, use the pathspec form — `git commit --amend -F - -- <owned path>...` — which records only the named paths and ignores what else is staged. Verify with `git show --stat` immediately after.
- **A cosmetic commit-message defect is not worth this risk.** Leaving a bad subject line and documenting it beats a 1-in-N chance of capturing a sibling's deliverable. That is the call that was made here.
- Corollary: the window between `git add` and `git commit` is a race. Keep it as short as possible, and re-check `git status --porcelain` inside that window, not before it.

## Related
- Commit messages from the **Bash** tool need a `<<'EOF'` heredoc with `git commit -F -`. The `@'...'@` here-string form is PowerShell-only; in Bash it silently becomes a literal `@` first line.
- Separate but adjacent hazard already seen on this board: the wrapper's post-flight `git add -A` sweep commit fires when a task hits REVIEW and can capture another agent's in-flight files under the wrong task title. Identify a sweep commit by content — it always contains `.moe/messages/*.jsonl` and `.moe/tasks/*.json`. Never revert it.
