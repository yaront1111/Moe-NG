# A deliberate double-close is a SUITE-WIDE corruption, not a local test smell

Found 2026-08-10 in `packages/runner/src/platform/windows/native/broker` (task-05bf0e0f).

## The trap
To test that a failed `CloseHandle` is surfaced rather than swallowed, the obvious fixture
closes the handle out from under its owner first, so the owner's own close lands on a freed
handle:

```rust
calls.inner.close_handle(handles[2]).expect("...");   // now the owner's close must fail
descriptors.close().expect_err("...")
```

It works exactly once and then poisons everything around it. **Windows reuses handle
values.** Between the first close and the owner's doomed second close, another test —
`cargo test` runs integration tests THREADED within a binary — can be handed that same value
for a brand-new pipe. The second close then destroys a live handle belonging to a test that
has nothing to do with this one.

## How it presents
Two *unrelated* tests fail, in a file you did not touch, on the run where you added something
elsewhere. Re-running is green. It reads exactly like flakiness or like the new code being at
fault, and the failing test names point away from the real cause.

## The fix
Refuse at the SEAM instead. A delegating decorator over the real boundary that fails one
chosen close keeps the production logic under test — the error mapping, and first-error-wins
across the remaining closes — while making the double-close unrepresentable:

```rust
fn close_handle(&self, raw: isize) -> Result<(), u32> {
    self.closed.borrow_mut().push(raw);
    if self.refuse_close_of == Some(raw) { return Err(ERROR_INVALID_HANDLE); }
    self.inner.close_handle(raw)
}
```

The test got stronger, not weaker: it can now also assert every close was ATTEMPTED, and
assert the exact `ERROR_INVALID_HANDLE` survived to the caller rather than merely "nonzero".

## Generalises to
Any process-global resource whose identifiers are reused after release — Windows HANDLEs,
POSIX fds, slot indices in a pool. Never free one twice on purpose in a threaded suite to
provoke a failure; script the failure at the boundary.

Related: `mem:gotcha-handle-value-collision-makes-absence-ambiguous`.
