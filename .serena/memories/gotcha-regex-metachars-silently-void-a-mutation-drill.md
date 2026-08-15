# A mutation drill can be a no-op and read as "the mutant survived"

Two shell traps hit while drilling `packages/import/src/import-reconcile-graph.ts`.
Both produced a GREEN suite, which reads as "the test does not cover this" —
the opposite of the truth.

## 1. `$` and `{}` interpolate inside the perl one-liner

```bash
drill 'cycle:${ref}' 'cycle:${legacyId}->${ref}' 2
perl -0pi -e "s/\Q$2\E/$3/g" "$F"
```

Bash leaves `${ref}` alone (single-quoted args), but the perl PROGRAM is in
double quotes, so `$2`/`$3` are pasted into the source and **Perl** then
interpolates `${ref}` as its own undefined variable. `\Q...\E` quotes
metacharacters, it does NOT stop interpolation. Pattern collapsed to `cycle:`,
replacement to `cycle:->`, so the file gained a cosmetic `cycle:->${ref}` —
still target-keyed, behaviour unchanged, 21/21 green.

## 2. `grep -c` treats the anchor as a regex

```bash
grep -c -- '[...dependsOn(entry.record)].sort(byCodeUnit)' "$F"   # -> 0
```

`[...]` is a character class. The anchor-count guard reported 0 and aborted —
that one at least fails loudly, but `[`/`.`/`(` in an anchor can equally
OVER-count and let a wrong edit through. Use `grep -F`.

## The fix

Do literal replacement outside the shell. A tiny python helper that takes
(old, new, expectedCount), asserts `s.count(old) == expected`, and writes
`s.replace(old, new)` removes both traps at once. Keep it OUTSIDE the repo
(`%TEMP%`) so a foreign whole-tree commit cannot sweep the harness in.

## Second-order: a surviving mutant may be a real coverage hole

After fixing the mechanics, one drill (dropping the per-node `.sort(byCodeUnit)`)
genuinely survived: every fixture happened to list its refs already sorted, and
the single unsorted fixture produced the same emission sequence either way. The
answer was a new fixture whose payload order and walk order disagree — not
accepting the green. Classify before rewriting: see
[[mutation-drill-green-may-indict-the-mutation]] and
[[qa-mutation-drill-can-redden-for-wrong-reason]].
