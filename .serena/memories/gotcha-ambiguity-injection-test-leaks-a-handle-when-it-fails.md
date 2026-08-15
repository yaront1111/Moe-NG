# An ambiguity-injection test leaks its SQLite handle on exactly the failing path

## Pattern
Testing `OUTCOME_UNKNOWN` in @moe/store means patching `DatabaseSync.prototype.exec` to run the real
COMMIT then throw. The obvious shape restores the prototype in a `finally` and closes the store
inline afterwards:

```ts
try { store.installInitialRecoveryBinding(...) }
catch (error) { caught = error }
finally { DatabaseSync.prototype.exec = originalExec }   // prototype safe...
expect((caught as DurableStoreError).code).toBe("OUTCOME_UNKNOWN");
// ...assertions...
store.close();                                            // ...handle is NOT
```

## Why it bites only when the test fails
On the SUCCESS path `poison()` has already called `this.database.close()`, so the handle is gone
before `store.close()` is ever reached — the leak is invisible. On the FAILING path (a drill, or a
regression) nothing poisoned anything, the assertion throws, `store.close()` never runs, and the open
handle reaches the Windows `afterEach` rmSync as EPERM. That can kill the vitest worker with zero
test output, which reads as a native crash and HIDES the assertion that actually failed — on the one
run where you needed to read it.

So the failure mode is: the test is correct when green and uninformative when red.

## Fix
Put the prototype restore AND `store.close()` in one `finally` spanning every exit path, with the
assertions inside the `try`. Closing an already-poisoned handle is safe and idempotent.

## Check it stayed attached
Re-run your mutation drill AFTER the restructure, not just before. A restructure that moves
assertions into a `try` can change which one fires first. Found on
task-1615065497f0489097a4bbc11cea9d6b; the drill stayed red on the same line.

Related: `mem:gotcha-fail-closed-flag-inside-try-is-untested-by-default`.
