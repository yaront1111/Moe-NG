# Handoff — task-d23a913f (Bind Claude model and effort launch selection), reopen #2

Commit **a7932ae**, 6 files, +305/-22, all under
`packages/runner/src/providers/claude/`. Gate at that HEAD:
`pnpm --filter @moe/runner typecheck && pnpm --filter @moe/runner test`
-> 58 files / 1880 tests, exit 0.

## What the two rejected defects actually were

1. **A guard that was real but unreachable.** `verifyLaunchSelection` called
   `types.isProxy` before reflecting — correct. But `launchClaude` ran
   `snapshotClaudeLaunchRequest` FIRST, and that module's own argv/environment
   snapshotters used `Array.isArray`/`Object.keys`/descriptor reads with no
   proxy check, normalizing a hostile value into a plain frozen copy. The
   verifier then only ever saw the sanitized copy. A **transparent**
   (Reflect-forwarding) proxy therefore executed 15 traps and the launch
   completed `OBSERVED`. The previously-shipped hostile test passed because its
   proxy traps THREW and the try/catch answered — containment after the fact,
   not refusal.
2. **Resume argv.** See `mem:gotcha-resume-argv-defeats-a-model-proof`.

## Design decisions QA should grade rather than assume

- Hostile argv/environment answer a distinct exported Symbol
  `HOSTILE_LAUNCH_OPERAND`, NOT `null`. `null` would restamp them as
  `CLAUDE_LAUNCH_REQUEST_MALFORMED`/`LAUNCHER`, making
  `TELEMETRY_CONFIGURATION` unreachable for exactly the inputs worth naming.
- That refusal sits BEFORE the duplicate-delivery short-circuit while the
  CONTENT gate stays after it. So hostile argv refuses even on adoption, but
  resume argv still adopts. Deliberate: hostile shape is an input-trust
  failure; a resume flag on an adoption launches nothing.
- `CLAUDE_LAUNCH_RESUME_FLAGS`, `HOSTILE_LAUNCH_OPERAND`,
  `snapshotLaunchSelection`, `verifyLaunchSelection` are all deliberately NOT
  root-published.

## Traps for the next agent here

- `CLAUDE_LAUNCH_ERROR_CODES` has **no** length pin (only `toContain` +
  `isFrozen`), so the selection vocabulary can gain a member with zero test
  edits. `CLAUDE_LAUNCH_SELECTION_CODES.length` IS pinned — currently 8.
- Removing a `REQUEST_KEYS` entry fails as a NAMED `TS2344` at
  claude-launcher-input.ts:29 (the `RequestKeyIsDeclared`/`DeclaredFieldHasKey`
  `extends never` pair), not as the silent malformed wave the plan predicted.
- `COMMIT` in claude-launcher-test-fixtures.ts is an exported `let` assigned in
  `beforeAll`. `export const COMMIT` is a dead edit anchor.
- Rail: never grow `claude-launcher-lifecycle.ts` (249) or
  `claude-launcher-port-results.ts` (250).
- One cosmetic wart: my `complete_step` for step-10 has a typo in
  `modifiedFiles` — `packagesges/runner/...` for the selection test. The commit
  and the diff are correct; judge scope on the diff.

Related: `mem:gotcha-late-hostile-input-guard-is-not-a-guard`,
`mem:gotcha-descriptor-mirror-transparent-proxy-and-nested-freeze-alias`.
