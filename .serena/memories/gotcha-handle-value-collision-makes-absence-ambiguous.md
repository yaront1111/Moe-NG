# Proving a handle is ABSENT from a child needs a handle-value floor

Found 2026-08-10 proving `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` non-inheritance (task-05bf0e0f).

## The question and the only honest way to answer it
"Did the child inherit handle X?" cannot be answered from the parent. Asserting what the
parent put in the allowlist is the assumption restated — it stays green if inheritance leaked
every handle in the process, because the parent's list is unchanged. Only the child can see
its own table, so a cooperating child (`src/bin/handle_probe.rs`, discovered by cargo autobins,
reachable from tests as `CARGO_BIN_EXE_handle_probe`) calls `GetHandleInformation` on each
value and reports back.

**Measured proof that this matters:** with the child-side assertions removed and replaced by
a parent-side one, a genuinely leaked handle the child really held passed GREEN.

## The subtle flaw in the child-side answer
"Absent" is `GetHandleInformation` failing on a NUMBER. Windows allocates handle values as
low ascending indices **independently in each process**. A parent handle can therefore share
a value with something the child opened for itself, and the child truthfully reports
`present` for an object that is not the parent's at all.

That is a false ALARM, never a false pass — but a flaky proof gets deleted rather than
believed, so it must be closed.

## The fix: raise the floor, then assert it
Hold enough handles open in the parent before allocating anything the test asks about, so
every subsequent value is above what a small child can reach. Windows hands out the lowest
free index, so occupying the low ones is all it takes:

```rust
const HANDLE_VALUE_FLOOR: isize = 4096;   // index 1024
// duplicate GetCurrentProcess() (non-inheritable) until the returned value >= FLOOR
assert!(everything_asked_about.all(|v| v >= HANDLE_VALUE_FLOOR));
```

Assert the floor rather than trust it — that turns a probability argument into a checked
structural fact, and it fails loudly if the assumption ever stops holding.

Inherited handles keep the SAME numeric value in the child, which is what makes the whole
scheme work; child-local allocations fill the free low indices instead.

Related: `mem:gotcha-deliberate-double-close-corrupts-threaded-suite`.
