# PowerShell `Measure-Object -Line` undercounts the 250-line cap by exactly the blank-line count

## The trap

Checking the per-file 250-line rail on Windows with:

```powershell
(Get-Content $f | Measure-Object -Line).Lines
```

**does not return physical lines.** `Measure-Object -Line` counts only lines with
content — every blank/whitespace-only line is skipped. The rail is a *physical*
line cap, so this reads LOW by exactly the number of blank lines in the file.

Real instance (2026-08-08, task-3602672f, `packages/scheduler/src/budget/budget-settlement.ts`):

| method | result |
|---|---|
| `(Get-Content $f \| Measure-Object -Line).Lines` | **243** — wrong |
| `(Get-Content $f).Count` | **250** |
| `git show HEAD:$f \| Measure-Object` (`.Count`) | **250** |
| blank lines in file | 7 (= 250 - 243) |

The file was **exactly AT the cap**. The bad measurement reported "7 lines of
headroom" and nearly authorized adding a comment line that would have landed the
file at 251 and violated the rail. QA caught it by measuring three other ways.

## Second instance: the divergence becomes a multi-agent scoring dispute

2026-08-09, `apps/daemon/src/index.ts`, across task-684e6972 / task-318379ea:

| method | result |
|---|---|
| `git show HEAD:$f \| wc -l` | **262** — over the 250 cap |
| non-blank lines (`grep -vc '^[[:space:]]*$'`) | **247** — under the cap |
| blank lines | 15 (= 262 - 247) |

**The same committed bytes are simultaneously over and under the rail depending
on the tool**, and the entire 15-line gap is what three agents spent four
messages arguing about. The worker declared ≤250 "arithmetically unreachable"
and QA repeated it in an approval; both were wrong — stripping the 15 blanks
lands the file at 247 with the foreign line still in it.

So the failure mode is not only "authorizes a bad growth" (instance 1). It is
also: **two agents can each measure honestly, get different numbers, and neither
suspects the other of error** — because nobody states the method. Concretely,
`Measure-Object -Line` would have reported this file as 247 = compliant, while
the rail's own `wc -l` says 262 = violation.

Corollary for cross-agent reports: **a line count is not a fact until the
measurement method is named alongside it.** Quote the command, not the number.
Blank-line stripping is a real reduction in physical lines and therefore a real
remedy for the cap — but it is a judgement (it deletes separators from a file
others may be mid-edit in), never an impossibility claim.

## Correct measurements

```powershell
(Get-Content $f).Count                      # physical lines, working tree
(git show HEAD:$f | Measure-Object).Count   # physical lines, committed blob
```

Bash tool: `wc -l` is correct, but measure the **committed blob** not the working
tree when the claim is about what landed:

```bash
git show HEAD:path/to/file.ts | wc -l
git show :path/to/file.ts   | wc -l   # staged (index), pre-commit check
```

## Why it matters here

- A file at 249-250 is the NORM in this repo, not the exception — the budget,
  projection, and control-room modules all land at 249-250 against the cap
  (see `mem:gotcha-line-cap-is-a-design-constraint-not-a-cleanup`). A 7-line
  undercount is therefore almost always the difference between "has room" and
  "at cap".
- The failure is silent and directional: it NEVER over-reports, so it can only
  ever tell you a full file is safe to grow. Exactly the wrong bias.
- Applies to any blank-line-containing file, so it hits verification gates
  (`wc -l` steps in plans) whenever a worker translates them to PowerShell.

## Rule

Never use `Measure-Object -Line` for the line cap. Use `(Get-Content $f).Count`
for the working tree, `git show :$f | wc -l` for the index (the count that
actually ships). Cf. `mem:gotcha-line-cap-is-a-design-constraint-not-a-cleanup`,
`mem:convention-contracts-250-line-splits`.
