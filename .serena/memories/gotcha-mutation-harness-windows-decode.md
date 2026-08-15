# Gotcha: a mutation harness that crashes on Windows console decoding leaves the file MUTATED

Second incident in this repo's mutation-testing story, distinct from
`mem:gotcha-mutation-testing-restore-safety` (which is about *how* you restore). This one is about
the harness dying before it reaches the restore at all.

## What happened (2026-08-08, task-318c0732, budget-reservation.ts)

Python harness: write mutant -> `subprocess.run(..., capture_output=True, text=True)` -> read the
verdict -> restore by copy. It never reached the restore:

```
UnicodeDecodeError: 'charmap' codec can't decode byte 0x9d in position 39
TypeError: unsupported operand type(s) for +: 'NoneType' and 'NoneType'
```

`text=True` decodes with the Windows ANSI codepage (cp1252). **vitest emits UTF-8 box-drawing and
check/cross glyphs**, so the reader threads died, `r.stdout` and `r.stderr` both came back `None`,
and the harness crashed on `r.stdout + r.stderr` — with the mutant still on disk.

The file was untracked (new module), so `git checkout` could not have saved it. It was only
recoverable because the out-of-tree backup already existed.

## Rules

1. **Never `text=True` for a Node/vitest subprocess on Windows.** Capture bytes and decode
   yourself: `(r.stdout or b"").decode("utf-8", "replace")`. The `or b""` also survives the case
   where a reader thread died.
2. **Restore in a `finally`**, not on the happy path — the crash is exactly when you need it.
3. **Take the out-of-tree backup BEFORE the first mutation**, unconditionally, even if you are
   confident the harness is correct. It is what turned this from a lost file into a 30-second fix.
4. After any harness crash: restore by copy, re-verify `git hash-object` against the recorded
   hash, and grep for mutation artefacts (`[false,` etc.) before trusting the tree.

## Second bite: the ENCODE side kills you too (2026-08-08, task-3602672f)

Same repo, harness written *following* the decode rules above — bytes captured, decoded with
`.decode("utf-8","replace")`, restore in a `finally`. It still crashed:

```
UnicodeEncodeError: 'charmap' codec can't encode characters in position 0-6
```

Not the subprocess read this time — the `print()`. The vitest summary line I extracted contains
UTF-8 box/check glyphs, and Python's **stdout** on Windows is cp1252, so printing the captured
line raised. The `finally` restore fired and the file survived, which is exactly why rule 2 exists.

5. **Sanitize before you print, not just when you read.** `print(re.sub(r"[^\x20-\x7e]", "", s))`,
   or set `PYTHONIOENCODING=utf-8`. Decoding safely is only half the round trip.

## Worth keeping

The eleven mutations themselves were all load-bearing (eleven red). The highest-value one was
flipping the refund direction `shiftView(view, totals, -1)` to `+1`: exactly one test went red,
which is the correct signal — only the refund test asserts the direction, and it does so by
deep-equalling the restored buckets against a pre-reserve JSON snapshot rather than by re-deriving
production's own arithmetic. Cf. `mem:gotcha-assertions-detached-from-their-subject`.
