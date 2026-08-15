# Turning a fixture `export const` into `export let` + `beforeAll` breaks module-scope consumers

## The trap
A shared test-fixture module exports a derived record as `const`. You need it to
depend on something async, so you convert it to
`export let X; beforeAll(() => { X = ... })`.

You check every consumer and confirm the references are inside `it(...)` bodies,
so lazy assignment is safe. Then a DIFFERENT consumer — often one that landed
after you measured — reads `X.field` at MODULE scope to build its own fixture
table, sees `undefined`, and its whole suite dies at COLLECTION:
`TypeError: Cannot read properties of undefined (reading 'grant')`, reported as
`Tests  no tests`. Your own suite is perfectly green, so the focused run you
were using during TDD never showed it.

Two compounding factors, both real in moe-next:
- The measurement was taken at planning time; HEAD moves under a shared
  worktree, so "every reference is inside an `it()`" is stale by default.
- A collection failure prints no assertion name, so it reads like an
  environment problem rather than a contract break you caused.

## The fix that beats editing the consumer
Ask what part of the derivation is ACTUALLY async. Very often the expensive
async step (here `prepareClaudeRuntimePin`) is not the step the export depends
on; the value it needs comes from a PURE builder over plain data
(`buildProviderRuntimeObservation` never touches the filesystem — it takes the
closure entries as data). Hoist only the pure prefix, including any sync
`mkdtempSync`/`writeFileSync` it needs, to module scope and leave the async tail
in `beforeAll`. The export stays a `const` and blast radius is zero.

Editing the foreign consumer is the worse option in a shared worktree: it is
another task's in-flight file, and the reference is usually repeated at ten
sites.

## Generalisation
Before converting any exported `const` in a shared fixture to a hook-assigned
`let`, grep EVERY importer for module-scope reads, not just the file you are
working in — and re-grep at implementation time, not at planning time. The
signal to look for is a reference outside any `it`/`beforeEach` callback.

Related: `mem:task-task-de496f4785a242569aa4ffc3ef6f1d69-handoff`,
`mem:head-moves-mid-verification`,
`mem:own-diff-red-in-foreign-file-is-not-excused`.
