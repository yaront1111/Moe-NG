# `SQLITE_VERSION_UNSUPPORTED` looks like a reason code and is not one

Found 2026-08-09 on `task-51d05520` while fact-checking a README sentence. The refusal is
real — it fails closed — but the code a caller can observe is the generic one.

```ts
// packages/store/src/sqlite-event-store.ts:171-173
if (compareVersions(sqliteVersion, MINIMUM_SQLITE_VERSION) < 0) {
  throw new Error(`SQLITE_VERSION_UNSUPPORTED: ${sqliteVersion} < ${MINIMUM_SQLITE_VERSION}`);
}
```

Three measured facts:

1. **The token is not in the vocabulary.** `DurableStoreErrorCode`
   (`store-contracts.ts:192-209`) does not contain it. The throw ~10 lines ABOVE uses the
   typed form, `new DurableStoreError("STORE_UNAVAILABLE", …)` — so the distinction is
   drawn deliberately elsewhere in the same function, which is what makes the plain
   `Error` read as an oversight rather than a convention.
2. **It is erased at the boundary.** The enclosing catch (`sqlite-event-store.ts:214-240`)
   rethrows a `DurableStoreError` unchanged but rewraps anything else as
   `DurableStoreError("STORE_UNAVAILABLE", "SQLite initialization failed")`. So a caller
   sees `STORE_UNAVAILABLE`, and the version token survives only as an unstructured string
   inside `error.cause.message`. **An unsupported SQLite build and a corrupt or unopenable
   database are indistinguishable to that caller.**
3. **Nothing pins it.** `grep -rn SQLITE_VERSION_UNSUPPORTED packages/store/src apps`
   returns exactly ONE hit — the throw site. No test asserts this path, so epic rail 6
   ("assert the reason code, not just the outcome") is unexercised here.

## Why this is easy to miss

Grepping the token finds it and it *looks* like the repo's other stable codes, so a
reader — or a doc author — reasonably writes "refuses with `SQLITE_VERSION_UNSUPPORTED`".
That sentence is wrong in the way that matters: it promises attribution the surface cannot
deliver. Same family as `mem:pattern-assert-which-layer-refused` and
`mem:gotcha-daemon-refusal-code-vocabulary-drift` — a string that names a reason is not
the same artifact as a reason code, and only reading the throw and its catch tells them
apart.

Knock-on: this directly limits design 4.1 criterion "exposes its SQLite version to
`doctor`". A doctor probe cannot report "SQLite unsupported" distinctly while the store
answers `STORE_UNAVAILABLE` for both cases.

Fix shape (narrow, not yet owned): add the code to `DurableStoreErrorCode`, throw the
typed error, pin it with a test that asserts the code and not merely that opening threw.
