# A `grep -c $'\r'` line-ending check can silently become vacuous

Verifying that the required `.js` bridges were exact LF one-liners, I ran:

```
printf "CR=%s" "$(grep -c $'\r' "$p" || true)"
```

It reported `CR=1` for all four bridges — i.e. "every bridge contains a carriage return". That
would have been a rail violation and a rejection. It was wrong.

`$'\r'` did not survive into the pattern. grep received an EMPTY pattern, which matches every
line, so `grep -c` returned the line count (1) for each one-line file. The check could never have
returned 0 for a non-empty file, so it was incapable of passing — a false positive that reads
exactly like a real finding.

## How I caught it

Byte arithmetic disagreed. `export * from "./session-authority-contracts.ts";` is 49 characters;
`wc -c` reported 50. One extra byte = one LF, not CRLF. `od -c` then showed the tails literally:
`;  \n` with no `\r`. All four bridges were correct.

## What to do instead

Use `od -c <file> | tail -3` and read the terminator, or `file <path>` (it says "with CRLF line
terminators"), or compare `wc -c` against the visible character count. If you do use grep, spell
the pattern in a form that cannot collapse: `grep -c $'\015'`, or `grep -cP '\r'`, or
`rg -c '\r'`.

## The general shape

This is the same defect the epic's reason-code rail warns about, aimed at a shell check instead of
a test: an assertion that has quietly detached from the thing it was written to measure. Any check
whose pattern, path, or filter can degrade to "match everything" or "match nothing" must be
sanity-tested against a known-good and a known-bad input before you trust its verdict. Related:
`gotcha-gate-narrowed-by-exclude-reads-as-green`, and the QA rule that a generated table cannot
police its own generator.
