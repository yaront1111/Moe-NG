# Identity session core — implementation handoff

Task `task-5fa383732c674c9ca00b1bc782153916` implemented by `worker-4dddabde`.
Commit `0a305cd`, 10 owned paths under `packages/core/src/identity/**`, +1047.
Gate `pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test` exit 0
at 4 files / 119 tests (95 of them mine).

## Modules

    identity-session.ts     183  Principal/Session/Credential + rotation
    identity-capability.ts  145  exact-tuple grants, canonicalize, match
    authenticate-command.ts 196  the authentication decision
    index.ts                 39  identity-only public seam

Root `packages/core/src/index.ts` was deliberately NOT edited — the root
re-export belongs to a separate integration task. `identity/index.ts` is the
owned seam.

## Security properties that must survive refactoring

- **The proof challenge is REBUILT, never read from the caller's proof.**
  commandId/requestDigest come from the envelope, credentialId and clientKeyId
  from the daemon records. `input.proof` is checked for binding equality in
  `bindingsHold` and then never read again — so an attacker field like
  `verified: true` has no code path to the verifier. `tsc` TS6133 on an unused
  `proof` binding is what PROVED this; if someone reintroduces that binding,
  the property is at risk.
- **Precedence is total and order-sensitive:** AUTHENTICATION_FAILED ->
  SESSION_REPLAYED -> SESSION_EXPIRED -> CAPABILITY_DENIED. Structural/binding
  integrity is checked before freshness so a forged record that merely looks
  stale cannot select a softer, more specific error. Three combined-fault tests
  pin this.
- **`SCOPE_ID` excludes `*` and `?` by charset.** Stronger than rejecting `"*"`
  as a special case: a grant cannot even carry glob syntax.
- **Expiry is EXCLUSIVE** (`now < expiresAt`); usable at 999, expired at 1000.
  Pinned identically in both suites.
- **Injected seams are hostile.** verifier/replay-guard throw, non-true result,
  or any outcome outside FRESH/REPLAYED all fail closed. UNKNOWN never
  authorises.
- **Same-command retry is NOT replay.** Command idempotency is a store concern.

## Gotchas hit

- `@moe/contracts` exports `RUNTIME_COMMAND_KINDS` but NOT `isCommandKind`. The
  tuple is public, the guard is not. Same trap as @moe/skills — build the Set
  locally. See `mem:gotcha-contracts-guards-not-exported`.
- A broad `try/catch` in a fail-closed validator SWALLOWED that bad import: the
  TypeError became a `null` return, so a programming error looked exactly like
  a validation rejection and 10 tests failed with no useful signal. Guard only
  the untrusted property READS; validate outside the catch.
- Run `typecheck` BEFORE the suite on any step adding a cross-package import —
  tsc reports TS2305 immediately, tests just fail mysteriously.
- `it.each` with heterogeneous object literals infers a union of tuple types
  the callback cannot absorb. Fix with `as [T, string][]`, never by loosening
  assertions.
- A stray NUL byte made a source file `data` rather than text — see
  `mem:gotcha-nul-byte-in-source`.

## Shared-package coordination

Three tasks were live inside `@moe/core` simultaneously (project, goal,
identity) and all share the package-wide gate, so any one worker's TDD RED
phase reds the other two. The goal RED cleared on its own here. Consider
directory-scoped gates (`vitest run packages/core/src/identity`) for sub-package
tasks — raised with the governor.

`packages/core`'s own scaffold (package.json, tsconfig.json, src/index.ts) was
still UNCOMMITTED when I committed, so identity currently sits on an untracked
base. Not mine to commit.
