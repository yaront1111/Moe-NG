# task-cec84736d5 handoff — forbidden Origin header + daemon guard coverage gap

Status: REVIEW. Commit `48c6298`. Branch `moe/work-2026-08-08`.

## What shipped

`packages/control-room-client/src/client-transport.ts` `headersFor` no longer emits
`origin: options.origin`. `Origin` is a FORBIDDEN header name in the fetch spec —
a browser drops whatever the client sets and substitutes its own — so the entry was
inert in the browser and, in Node, satisfied the daemon guard by a route no browser
can take. `${options.origin}${path}` (URL prefix) and every other header untouched.

Three test surfaces:
- `client-transport.test.ts` pins the EXACT sorted header-name set (not a subset).
- `apps/daemon/src/http/http-listener.test.ts` gained the missing ADMITTED arm; its
  `send()` helper now sets `x-moe-protocol-version` (default `WIRE_PROTOCOL_VERSION`
  from `http-contract.js`) — without it a request that PASSES the listener refuses at
  the adapter's version stage and "admitted" cannot be expressed at all.
- `tests/integration/control-room/control-room-transport.test.ts` drives the REAL
  transport against a REAL daemon across all three arms.

## The design decision, if anyone reopens this

Non-browser callers MUST supply Origin through their own `options.fetch` wrapper.
That is recorded on `headersFor`. Do NOT reintroduce the header behind an
environment check (restores the illusion) and do NOT relax the daemon guard
(`http-listener-guards.ts:127`, exact match, absence refused). The integration test's
`fetchSupplyingOrigin(origin)` is the reference shape; `transportFor(daemon, undefined)`
means NO wrapper, which is how the absent-Origin arm stays honest.

## Two reds in this area that are NOT this task's

1. `pnpm --filter @moe/daemon test` exited 1 at the time of completion: 3 files /
   2 tests, all from a peer's UNTRACKED activation work
   (`src/activation/foundation-launch-authority.test.ts` imports a module that does
   not exist; `runtime-entrypoint.test.ts`'s .js-bridge sweep reddens on the same
   peer's untracked `foundation-activation-transition.{ts,js}`;
   `coordination-adapter.test.ts` was ` M`). Merge-base probe at `de936fe` gave the
   identical set. Likely gone by now — re-measure, do not inherit this claim.

2. STILL OPEN, worth its own task: the integration test
   "transports a committed read whose payload EQUALS the in-process handler's" fails
   on wall-clock skew. `observer.now()` at `apps/daemon/src/http/event-stream.ts:80,87`
   uses `DEFAULT_SEAM_OBSERVER`; the daemon and the in-process `readEventPage` take
   SEPARATE readings, so whole-payload equality can only pass inside one millisecond.
   `event-stream-fixtures.ts` exports `SEAM_READING` for injection, but neither
   `startDaemon` nor `http-listener.ts` accepts an observer — grep both, they have no
   `SeamObserver` parameter. The fix is that injection seam. Do NOT "fix" it by
   deleting the field from the comparison: whole-payload equality is what catches a
   transport that drops or renames a field.

## Nothing typechecks tests/integration

No tsconfig covers that directory (only `tests/e2e`, `tests/fault`, `tests/security`
have one) and the root gate is `pnpm --recursive typecheck`. A type error there is
invisible to every gate; vitest only transpiles. Check by hand:

    npx tsc --noEmit --strict --module nodenext --moduleResolution nodenext \
      --target es2024 --lib es2024 --types node --exactOptionalPropertyTypes \
      --noUncheckedIndexedAccess --verbatimModuleSyntax \
      --forceConsistentCasingInFileNames <file>

## Verification actually run

`pnpm --filter @moe/control-room-client typecheck` (0) && `... test` (6 files / 41)
&& daemon `src/http` (6 files / 82) && integration Origin-guard arm (1 passed).
See `mem:gotcha-forbidden-origin-header-illusion`.
