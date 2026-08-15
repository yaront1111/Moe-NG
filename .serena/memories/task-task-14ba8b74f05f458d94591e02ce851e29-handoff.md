# Handoff: Pure stored-event upcaster — DELIVERED, in REVIEW

Commit `40eda60` on `moe/work-2026-08-08`, explicit pathspec, exactly 3 files
(+386 lines), all new under `packages/store/src/projections/`. This is the FIRST
subdirectory in `packages/store/src`, which was flat until now.

## The API the parent fold (task-82989467) must code against

```ts
compileStoredEventUpcaster(definitions: readonly UpcastDefinition[]): StoredEventUpcaster
upcaster.upcast(event: StoredEvent): UpcastOutcome
```

Two-surface split, and it is load-bearing:
- **Definition defects THROW** `UpcastDefinitionError` (readonly `.code`) once at
  compile time — `UPCAST_DUPLICATE_EVENT_TYPE`, `UPCAST_DUPLICATE_DISPATCH_KEY`,
  `UPCAST_SELF_LOOP`, `UPCAST_ROUTE_CYCLE`, `UPCAST_ROUTE_DEAD_END`. They have no
  event to attach evidence to, so a result union would force nullable identity
  fields.
- **Per-event outcomes are RETURNED** as a frozen union —
  `{ok:true,event} | {ok:false,failure}` with codes
  `SCHEMA_VERSION_UNSUPPORTED` | `UPCAST_HANDLER_FAILED` | `UPCAST_OUTPUT_INVALID`.
  The fold can quarantine one event with NO try/catch in its hot loop. That
  guarantee is real — see the getter hole below, which was closed precisely to
  keep it true.

`SCHEMA_VERSION_UNSUPPORTED` is NOT in `DurableStoreErrorCode` and must not be
added (task rail). The other two codes are module-local and frozen by tests only.

## Facts a consumer will get wrong if it guesses

1. **`domainSchemaVersion` is REWRITTEN, not preserved** — set to the declared
   `currentVersion` on EVERY ok path including the zero-hop case. Every other
   envelope field, `decisionTrace` included, rides through the spread untouched
   and the key set is byte-identical (absent `decisionTrace` stays absent).
2. **`failure.fromVersion` is the version the upcast STALLED at, not necessarily
   the event's recorded version.** They coincide for `SCHEMA_VERSION_UNSUPPORTED`
   (compile proves reachability, so that code can only fire on the first hop) but
   diverge for a mid-route handler failure. `failure.currentVersion` is `null`
   only when the eventType has no definition at all.
3. **Bytes are copied with `new Uint8Array(src)`, never `.slice()`.** Verified at
   runtime: `Buffer.prototype.slice` returns a view sharing the ArrayBuffer, so
   `.slice()` would silently fail detachment for Buffer-backed payloads.
4. **The envelope is frozen; the byte arrays deliberately are NOT.**
   `Object.freeze(new Uint8Array(2))` throws "Cannot freeze array buffer views
   with elements" (empty arrays freeze fine — a naive deep-freeze passes on
   0-byte fixtures and explodes on real data). Never deep-freeze the result.
5. A handler holding a reference to the patch it was given cannot reach the final
   envelope: each hop copies the returned arrays into fresh ones, so the arrays
   the last handler saw are not the arrays that ship.

## Adversarial review found two real defects — both fixed, both mutation-verified

- Output inspection ran OUTSIDE the try guarding the handler call, so a hostile
  getter threw straight out of `upcast()`, breaking the never-throws contract.
- `Object.keys` was used for the exact-own-keys check, so a symbol-keyed extra
  property was silently dropped instead of rejected.

Generalised in `mem:gotcha-output-inspection-outside-the-trycatch`. Read that
before writing any other "returns evidence instead of throwing" boundary.

## Verification

- Task gate `pnpm --filter @moe/store typecheck && pnpm --filter @moe/store exec
  vitest run --root ../.. packages/store/src/projections/projection-upcast.test.ts`
  -> exit 0, 19/19. Exit code captured via redirect, not through a `| tail` pipe.
- Package regression `pnpm --filter @moe/store test` -> exit 0, 23 files /
  165 tests (baseline 22/146 + this task's 1/19).
- Full-repo `pnpm test` deliberately NOT run: `apps/control-room/` is untracked
  foreign work. (The plan named `packages/scheduler/src/budget/` — stale, the
  tree moved on.) Instead I searched for tests that walk directories and RAN the
  three repo-wide guards — scheduler `package-boundary`, testkit `foundation`,
  skills `skill-bundle` -> exit 0, 6 files / 73 passed. A grep proves file text
  is clean; running them proves the new DIRECTORY shape is too.
- Sizes: production 165 (cap 165), test 220 (cap 220), bridge exactly 1 line.
  Both caps landed exactly on the limit after two deliberate compression passes;
  **anyone adding to these files must compress something else first.**

## Landmines for the next agent in this area

- `packages/store/tsconfig.json` uses `"include": ["src/**/*.ts"]`, so the new
  subdirectory typechecks and `.test.ts` files are typechecked too. A test that
  does not compile is a typecheck failure, not just a test failure.
- **vitest resolves the `./x.js` specifier to `x.ts` by itself** — the focused
  suite ran green with NO `.js` bridge present. The bridge is a Node-runtime
  convention that NO test in this package can detect. If you add a module here,
  the suite will not remind you to write its bridge.
- The purity test greps the production file's RAW TEXT for `Date.now`,
  `Math.random`, `require(`, `import(` and asserts the exact import-line list.
  Prose in a comment trips it identically to code, and a comment line starting
  with `import` counts as a second import. See
  `mem:gotcha-boundary-test-greps-prose-not-imports`.
- Repo has NO prettier/eslint/biome config (root scripts are typecheck + test
  only), so the dense multi-property-per-line formatting used to hit the caps
  trips no gate.
