# Gotcha: scripted in-place edits silently convert a file to CRLF on Windows

Hit on `task-2580a578` (2026-08-08) while batch-wrapping long lines with a Python
heredoc. Everything typechecked and all tests passed, then `git add` printed:

```
warning: in the working copy of 'packages/runner/src/supervisor/effect-activation.ts',
CRLF will be replaced by LF the next time Git touches it
```

## Why

`open(p, encoding='utf-8')` reads with universal newlines, turning CRLF **and** LF into
`\n`. Writing back with `open(p, 'w')` translates every `\n` to `os.linesep`, which is
`\r\n` on Windows. So a scripted edit rewrites the WHOLE file's line endings even though
the diff you intended was three lines. The rest of the repo is LF, so the file becomes
the odd one out in the working tree.

This is invisible to `tsc`, to `vitest`, and to `wc -l`. It only surfaces at `git add`,
and if `core.autocrlf` were set differently it might not surface at all — it would just
land a whole-file diff on the next person who touches the file.

## Fix

Write binary, or normalize before staging:

```python
d = open(p, 'rb').read().replace(b'\r\n', b'\n')
open(p, 'wb').write(d)
```

Detect before committing (`file` reports "CRLF line terminators"):

```sh
file packages/<pkg>/src/<dir>/*.ts | grep -i crlf
```

## Rule

After ANY scripted (python/sed/awk) in-place rewrite on this machine, run the CRLF grep
before `git add`, and re-run the gate after normalizing — the normalization is itself a
file rewrite, so its evidence must be fresh.

The `Edit` tool does not have this problem; only shell/Python rewrites do. Prefer `Edit`
for one or two hunks and reserve scripted rewrites for genuinely repetitive passes.

Related: `mem:task-task-2580a578812f46a49cae0af79ff6fc16-handoff`.
