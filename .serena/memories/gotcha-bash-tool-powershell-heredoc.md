# Gotcha: PowerShell here-strings silently corrupt commit messages in the Bash tool

This repo's sessions expose BOTH a PowerShell tool and a Bash (Git Bash) tool. The
PowerShell tool's docs prescribe `git commit -m @'...'@` for multi-line messages. Sending
that exact syntax through the **Bash** tool does not error - bash parses `@'...'@` as a
literal `@`, a single-quoted string, and a trailing `@`. The commit succeeds with a
mangled subject:

```
@ refactor(store): split event read model ...
...
@
```

Use a heredoc in the Bash tool instead:

```sh
git commit -F - -- <owned paths> <<'EOF'
subject line

body
EOF
```

Fixing it after the fact: verify `git diff --cached --stat` is EMPTY first, then
`git commit --amend -F - <<'EOF' ... EOF`. With an empty index the amend rewrites only
the message, so the tree stays byte-identical - important under the epic rail that
forbids sweeping foreign work into a commit.
