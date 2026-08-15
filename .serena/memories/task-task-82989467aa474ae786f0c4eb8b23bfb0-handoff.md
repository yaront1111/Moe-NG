# Handoff: Pure projection fold engine — QA APPROVED (was: delivered, in REVIEW)

Commit `c27029a` on `moe/work-2026-08-08`, explicit pathspec, exactly 3 new files
(+501) under `packages/store/src/projections/`. Sizes at HEAD content
(`git show HEAD:<path> | wc -l`): `projection-fold.ts` 250, `projection-fold.test.ts`
250, `projection-fold.js` bridge 1. **Both TS files sit exactly ON the 250 target —
anyone adding here must compress something else first, or split the file.**

## The API SPIDR steps 3-5 wire against

```ts
foldProjection({
  checkpoint: { globalPosition: bigint },
  events: readonly StoredEvent[],
  reducers: Readonly<Record<eventType, ProjectionReducer>>,
  state: ProjectionState,          // recursively plain data
  upcaster: StoredEventUpcaster,   // from projection-upcast.js
}): ProjectionFolded | ProjectionFoldRefusal   // both frozen
```

- `ProjectionFolded = {ok:true, checkpoint, state}`
- `ProjectionFoldRefusal = {ok:false, code, layer, detail, eventId, upcast, checkpoint, state}`
- `layer` is `"INPUT" | "REDUCER" | "UPCAST"`; `upcast` carries the child's verbatim
  `UpcastFailure` (so `SCHEMA_VERSION_UNSUPPORTED` is readable) or `null`.
- Codes are a local `PROJECTION_FOLD_*` union, deliberately DISJOINT from
  `UpcastFailureCode`, so "which layer refused" is assertable, not inferred.

## Decisions a consumer will get wrong if it guesses

1. **An unregistered eventType is REFUSED (`PROJECTION_FOLD_REDUCER_MISSING`), not
   skipped.** A projection that ignores a type must register an identity reducer.
   A silent skip would advance the checkpoint past an event nobody folded.
2. **Every mid-batch failure echoes the cloned INPUT state + checkpoint**, never the
   partial accumulator — even when earlier events already reduced successfully.
   ONE EXCEPTION, see the hazard below.
3. **Preflight runs over the WHOLE batch before `reduceAll` is entered.** Proven by a
   call-recording reducer asserted to have zero calls, not by reading the code.
4. **Sequence rule: per aggregate, STRICTLY increasing within the supplied batch.**
   Equal = DUPLICATE, lower = OUT_OF_ORDER. NO contiguity, NO start-at-one — an
   incremental page legitimately begins midstream (sequences 7 then 9 fold fine).
5. **Events are REBUILT from values captured via `Object.getOwnPropertyDescriptor`**,
   so a proxy gets exactly one chance to answer and an accessor is refused not invoked.
   Byte fields re-wrapped `new Uint8Array(value)`, never `.slice()`.
6. **State is deep-CLONED then deep-frozen.** Freezing alone would not give detachment.

## Hazard left in scope for the relay (task-071173ab), flagged not rejected

`ProjectionFoldResult` is a union whose BOTH arms carry `checkpoint` and `state`, so
`saveCheckpoint(result.checkpoint)` typechecks WITHOUT narrowing on `ok`. Every
refusal arm echoes the caller's own state+checkpoint EXCEPT the entry-catch arm
(`projection-fold.ts:244-247`), which echoes `EMPTY_STATE` + `ORIGIN {0n}`. That arm
is reachable with a perfectly VALID caller state — the `throwingProxy` suite case hits
it: a hostile batch makes `Reflect.ownKeys` throw, the catch nulls `start`, and the
refusal reports checkpoint 0 though the caller's was 5. Fail-closed (`ok:false`), so
nothing is absorbed. The `EMPTY_STATE` doc comment ("supplied state or checkpoint is
itself unrepresentable") is NARROWER than the real trigger; the detail string
"state, checkpoint, batch, or wiring is not usable" is the accurate one. In-cap fix if
wanted: `start ?? EMPTY_STATE` / `point ?? ORIGIN`. See `mem:gotcha-union-refusal-echo-unnarrowed`.

Second known limitation, unfixed: `events` is typed `readonly StoredEvent[]` but
consumed with `for-of`, so a caller bypassing types with an infinite generator hangs
rather than refuses. Every other malformed batch is caught by the entry try.

## QA verification actually performed (qa-6fd67108, 2026-08-08)

- Gate re-run by QA, not taken on trust: `pnpm --filter @moe/store typecheck &&
  pnpm --filter @moe/store test` -> exit 0, 24 files / 184 tests.
- Worktree blobs byte-identical to HEAD for all 3 paths — no uncommitted drift behind
  the review. `git show --stat c27029a` = exactly the 3 owned paths.
- Purity verified against HEAD CONTENT (not the working copy): zero hits for
  `node:` / `DatabaseSync` / `readFile` / `writeFile` / `Date.` / `Math.random` /
  `process.`; zero DB construction in the test. An in-suite guard asserts the module
  specifier list is exactly `["../store-contracts.js", "./projection-upcast.js"]`.
- **5 independent QA mutation red-checks**, each restored and confirmed back to blob
  `95fbb9bc`: bypass the upcaster -> 2 red; `<=`->`<` on global position -> 1 red;
  echo the accumulator instead of input state -> 1 red; drop `Object.hasOwn` on the
  reducer table -> 1 red; return the caller object instead of a frozen deep clone ->
  3 red. Every one named the expected assertion.

## Landmines

- **vitest does not typecheck.** `upcastOne` originally returned `UpcastOutcome|Issue`
  and `!("ok" in outcome)` does NOT narrow to the `ok:true` arm — `outcome.event` was a
  TS2339 while the suite was fully green. It now returns `StoredEvent|Issue` and the
  caller discriminates on `"code" in current`, which narrows because `StoredEvent` has
  no `code` field. Always run the package typecheck, not just the focused suite.
- **Running the focused file from the repo root is a trap.** The package script is
  `vitest run --root ../..` and is meant to run FROM `packages/store`. Invoking
  `pnpm exec vitest run --root ../.. <path>` at the repo root resolves the root one
  level too high and yields "Test Files 2 failed / Tests no tests" — a COLLECTION
  failure that looks like a passing mutation red-check but proves nothing. Use
  `pnpm --filter @moe/store test` for mutation work. See
  `mem:gotcha-mutation-harness-windows-decode` for the sibling trap.
- Two real prototype-key defects were found in adversarial review and fixed here —
  see `mem:gotcha-prototype-chain-key-lookup` and
  `mem:gotcha-mutation-finds-the-untested-half-of-a-pair`.
