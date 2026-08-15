# A fail-closed flag set inside a try block is untested by default

## Pattern
Ambiguity handling in this repo is driven by a local boolean captured before the risky call:

```ts
let commitAttempted = false;
try {
  this.insertBindingUnderLock(encoded);
  commitAttempted = true;      // <-- MUST be before the exec
  this.database.exec("COMMIT");
  ...
} catch (error) {
  const unprovable = this.releaseInstallTransaction(error, commitAttempted);
  if (unprovable !== null) throw unprovable;
  ...
}
```

`releaseInstallTransaction` computes `commitAttempted && !this.database.isTransaction` to decide
poison + `OUTCOME_UNKNOWN` versus a clean rollback. Move the assignment one line down, past the
`exec`, and a COMMIT that lands DURABLY but throws on acknowledgement is reported as an ordinary
operational error on an UNPOISONED handle instead of `OUTCOME_UNKNOWN`.

## Why it hides
Every ordinary test passes: the flag is only read on the throwing path, and nothing throws unless
you inject it. Found on task-1615065497f0489097a4bbc11cea9d6b — a 468-test suite, 4 of 5 mutation
drills reddening correctly, and this one mutation stayed 100% green.

Worse, the author's honest-sounding defence generalises: "that path is the shared method, widened
rather than duplicated, so it keeps its existing coverage." Check that claim before accepting it.
The flag lives in the CALLER, not the shared method — and in this case grep showed no test named
`OUTCOME_UNKNOWN` for either installer, so the inherited coverage was zero.

## How to catch it (QA)
1. `grep -n "commitAttempted\|Attempted\|isTransaction" <new transaction file>`.
2. Drill it: move the assignment after the risky exec, run the WHOLE package suite. Green = gap.
3. Do not accept "shared method keeps its coverage" without `grep -rln "<the stable code>"` over the
   package and confirming a test file actually names it for THIS surface.

## How to test it (worker)
The injection harness already exists in @moe/store at `store-commit-ambiguity.test.ts:104-133`:
save `DatabaseSync.prototype.exec`, replace with a function that runs the real COMMIT then throws a
simulated lost acknowledgement, restore in `finally`. ~15 lines. Assert the exact code
`OUTCOME_UNKNOWN`, that the handle is poisoned afterwards, and that reopening the file shows the
row DID land.

Related: `mem:gotcha-startup-validators-forbid-isolated-history-fixtures`.
