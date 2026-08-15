# Runner supervisor root surface — SHIPPED, commit 9bfaa3b

worker-964ae3f0, 2026-08-09. All 8 plan steps COMPLETED. Two files, explicit pathspec:

```
packages/runner/src/index-surface.test.ts | 304 +++  (new)
packages/runner/src/index.ts              |  92 ++   (70 -> 162 lines)
```

Gate: `pnpm --filter @moe/runner typecheck && pnpm --filter @moe/runner test &&
pnpm --filter @moe/daemon typecheck` -> exit 0. Runner suite **21 files/721 tests ->
22 files/799 tests**; +78 = exactly the added cases, zero regressions.

## What is on the root now

**66 runtime keys** (26 pre-existing + 40 supervisor) and **32 types**, curated named
exports, no `export *`.

- `effect-kernel.js` (14): 3 version constants, `EFFECT_CALLER_CONTRACT`, the 6 frozen
  vocabularies (`EFFECT_STATES`, `TERMINAL_EFFECT_STATES`, `EFFECT_COMMANDS`,
  `ATTEMPT_SLICE_STATES`, `GRANT_STATES`, `SUPERVISOR_LAYERS`), `SUPERVISOR_ERROR_CODES`,
  `supervisorFailure`, `withLeg`, `isTerminalEffectState` + 18 types.
- `effect-shape.js` (6): `MAX_SUPERVISOR_COUNT`, `MAX_SUPERVISOR_TEXT_CHARS`,
  `MIRRORED_LEASE_KINDS`, `MIRRORED_LEASE_STATES`, `parseMirroredLease`,
  `parseMirroredProof` + 4 types.
- `effect-parse.js` (9 parsers + 3 types), `effect-lifecycle.js`
  (`ADMITTED_EFFECT_TRANSITIONS`, `applyEffectCommand`, `applyEffectTombstone` + 2 types),
  `effect-grant.js` (6 + `CommitCheck`/`GrantOutcome`), `effect-activation.js`
  (`activateEffect` + 2 types), `lease-mirror.js` (`fenceMirroredLease` + `MirrorVerdict`).

## Decisions a later task must not re-litigate

- **effect-shape's generic guards stay internal** (`isStrictRecord`, `exactRecord`,
  `isRef`, `isDigest`, `isCount`, `oneOf`, `readList`, `readOwnDataProperty`,
  `hasOnlyOwnStringKeys`, `isPlainArray`, `DataPropertyRead`). No supervisor domain
  meaning, no stated consumer.
- **`MIRRORED_LEASE_KEYS` / `MIRRORED_PROOF_KEYS` are NOT published**, and this reverses
  the plan's step-2 list on purpose. They are the only NON-frozen arrays in the set and
  the mirror parsers read them every call — see
  `mem:gotcha-publishing-an-unfrozen-array-is-a-tamper-vector`. Freezing them = editing a
  supervisor module = forbidden by the task rail, so the seam narrowed instead. If child 4
  (`task-49acb856`) needs them for the daemon-side mirror-vs-`fenceAuthority` drift test,
  publish them in a task that can also freeze them.
- **`activationDigestInput`, `consumeActivationGrant`, `validateActivationCommit`,
  `CommitCheck`, `GrantOutcome` come from `effect-grant.js` ONLY.** `effect-activation.ts:36`
  re-exports those same five; taking them from both modules is a duplicate-export compile
  error that reads like a mystery.
- **No `.js` bridge added** — `@moe/runner` is still unloadable under plain Node; that
  package-wide sweep is `task-eb9ff081`'s. Vitest does not need bridges.

## For task-ba3a45f9 (daemon work services), the consumer

`apps/daemon/package.json` still lists only contracts/core/scheduler/store and imports
`@moe/runner` NOWHERE. So the gate's daemon-typecheck leg proves no regression but NOT
composability from the daemon. Adding that dependency is child 3's approved package.json
ownership amendment — do it there. The scheduler half of what you need is already on its
root (`mem:task-task-8ee125d0f05f4966abfcc49db37bbbf5-handoff`).

## Test design worth preserving

- Self-referencing ROOT specifier `@moe/runner` ONLY — `grep 'from "'` finds exactly
  vitest + two `@moe/runner` lines. A relative import here would make the suite green while
  testing nothing about the seam.
- Hand-transcribed 66-entry `[name, kind]` table + `it.each` so a loss reports BY NAME;
  cardinality guard `EXPECTED_EXPORTS.length === 66` so an emptied table cannot pass.
- **Mutation-drilled both axes**: deleting `withLeg` -> 3 red (named + set equality);
  adding an unreviewed `isRef` -> set equality red with `+ "isRef"`.
- All three `LifecycleOutcome` kinds obtained by CALLING `applyEffectCommand`, never by
  constructing literals: `REFUSED` keys are exactly `["failure","kind"]`, `MUST_DRAIN` has
  NO `ok` field (so `ok === false` cannot mistake a drain instruction for a refusal),
  `TRANSITIONED` keys are `["intent","kind","ok","result","versionDelta"]`.
- 10 reason codes pinned, plus the LAYER that refused; `codeOf`/`refusalOf` also assert
  membership in the published `SUPERVISOR_ERROR_CODES`/`SUPERVISOR_LAYERS`.
- All 32 types imported and USED — `noUnusedLocals` makes that coverage machine-checked.
- Fixtures hand-written; `protocolVersion` is the literal `"moe-effect-intent/1"` and a
  separate test pins the exported constant to the same literal
  (`mem:gotcha-fixture-derived-from-export-under-test-hides-every-assertion`).

Related: `mem:task-task-2580a578812f46a49cae0af79ff6fc16-handoff` (child 1),
`mem:gotcha-self-derived-universe-cannot-check-itself`,
`mem:convention-commit-by-pathspec-in-a-shared-index`.
