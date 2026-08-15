# QA: re-run the mutation drill yourself — a claimed drill is a claim, not evidence

Epic rail 6 ends with "verify a failure-path test by mutating the production surface and confirming
the test goes red." A worker note saying it drilled is exactly the kind of unverifiable claim QA
exists to check. Re-running it is cheap (two vitest runs on one file) and it is the only way to
know a surface assertion is load-bearing.

## Do it safely in the SHARED worktree

Every agent shares `D:/projexts/moe-next`, and another agent's whole-tree hook can COMMIT your
drill edit — `git status` then looks clean while the mutation is live
(`mem:mutation-drills-in-shared-worktree`). So:

- Back up to a path **outside git** (`/tmp/...`) and restore with `cp`. Do NOT restore with
  `git checkout --` (`mem:gotcha-git-checkout-restore-resolves-pathspec-against-shell-cwd`) and
  never `git stash` (epic rail 3 forbids it).
- Put edit + run + restore in **one** tool call with `trap restore EXIT`, so the window is seconds.
- Finish with `git diff --quiet -- <file> && echo CLEAN_RESTORED_OK`.

```sh
F=packages/x/src/index.ts; BK=/tmp/qa-bk-$$.ts; cp "$F" "$BK"
restore() { cp "$BK" "$F"; }; trap restore EXIT
sed -i '/^  fenceAuthority,$/d' "$F"
npx vitest run --root . packages/x/src/index-surface.test.ts 2>&1 | grep -E "Test Files|Tests  |fenceAuthority"
restore
git diff --quiet -- "$F" && echo CLEAN_RESTORED_OK
```

## Drill BOTH axes of a set-equality surface test

A namespace contract has two independent failure modes and one drill only covers one:

- **loss** — delete an export. Good test fails **by name** (`publishes fenceAuthority on the
  package root as a function`), not merely by a count mismatch.
- **addition** — append `export { existing as existingAlias } from "./m.js"`. This is the safe
  addition drill: it needs no symbol you have to go verify exists, and it must produce
  `expected [ …(37) ] to deeply equal [ …(36) ]`.

A test that only catches loss lets an unreviewed export ship.

## Also drill the HARNESS, not just the code

Type-level DoDs ("a consumer can name every parameter and every union arm") are only proven if the
typechecker actually reads the test file. Prove it, don't infer it from `include` globs: append
`const QA_PROBE: number = "not a number"; void QA_PROBE;` and confirm the error is reported AT that
test path, then restore. Same shape of check applies to any gate you are trusting to fail.

Related: `mem:gotcha-self-derived-universe-cannot-check-itself`,
`mem:gotcha-fixture-derived-from-export-under-test-hides-every-assertion`,
`mem:gotcha-guard-order-mutant-survives-when-only-one-guard-can-refuse`.
