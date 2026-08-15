# Gotcha: `grep -c $'\r'` through the Bash tool FALSELY reports CRLF on LF-only files

Found on `task-386fcb4c` (2026-08-09) while byte-verifying `.js` bridges.

## The symptom

```sh
grep -c $'\r' packages/core/src/index.js   # -> 1   ("CR present!")
wc -c        packages/core/src/index.js    # -> 28  = 27 chars + LF, so NO CR
od -c        packages/core/src/index.js    # -> ... " ; \n     confirms LF only
```

The `$'...'` ANSI-C quoting is mangled before bash evaluates it, so the pattern
degrades to empty. An empty pattern matches every line, and `grep -c` returns the
line count — which on a one-line file is `1`, indistinguishable from a real hit.

## Why it matters

This is a **false positive on a check whose entire job is to be trusted**. On a
Windows repo where CRLF really is a live hazard
(`mem:gotcha-python-inplace-edit-flips-line-endings`), a bogus CR alarm sends you
rewriting correct files, and the same broken pattern would report `1` afterwards
too — there is no way to make it go green, so you can chase it forever.

## Use instead

```sh
cr=$(od -An -tx1 "$f" | tr -s ' ' '\n' | grep -c '^0d$')     # 0d = CR
last=$(od -An -tx1 "$f" | tr -s ' ' '\n' | grep -v '^$' | tail -1)   # want 0a
```

Cross-check with arithmetic: compute the expected byte length from the expected
content (`printf '...' | wc -c`) rather than hand-typing it, so the length check
cannot agree with a typo in the content.

## Check the BLOB, not just the working tree

This repo has `core.autocrlf=true` globally; only `.gitattributes` line 1
`* text=auto eol=lf` keeps files LF. Verify what was actually committed:
`git show HEAD:<path> | od -An -tx1`. Confirmed round-tripping as LF.

## Prove the checker can fail

Before trusting a sweep that reports `BAD=0`, feed it a deliberately corrupt file
**outside the repo** and confirm it says BAD. A sweep that has never produced a
failure is not evidence. Same reasoning as asserting a sweep generated non-zero
cases: a loop run from the wrong cwd printed `PROBED=0 FAILED=0` on this task and
read exactly like a pass.

Related: `mem:gotcha-python-inplace-edit-flips-line-endings`, `mem:gotcha-scheduler-js-shims`.
