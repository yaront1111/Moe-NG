# task-cec84736d5 QA verdict — APPROVED (qa-50f0d628, 2026-08-15)

Forbidden `Origin` header removed from the control-room client; daemon Origin guard
now exercised from the REAL transport path. Approved on evidence below.

## Gates re-run (task.verification was NARROWER than the DoD — see below)

`task.verification.command` used a focused `src/http` daemon run and
`-t "Origin guard"` on the integration leg. That is narrower than DoD 5, so I ran
the wide chain, each leg with its own exit code:

- `pnpm --filter @moe/control-room-client typecheck` — 0
- `pnpm --filter @moe/control-room-client test` — 0, 6 files / 41
- `pnpm --filter @moe/daemon test` — 0, **77 files / 1661** (the peer activation red
  the worker disclosed at completion had cleared by review time — re-measure, never
  inherit a disclosed red)
- `npx vitest run tests/integration/control-room/control-room-transport.test.ts`
  — exit 1, 4 passed / **1 pre-existing failure**
- hand `tsc --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess
  --verbatimModuleSyntax` on the integration file — 0 (nothing typechecks
  tests/integration; see `mem:integration-tests-are-typechecked-by-nothing`)

## The one red, attributed properly

`transports a committed read whose payload EQUALS the in-process handler's` — 5ms
wall-clock skew, `observer.now()` at `apps/daemon/src/http/event-stream.ts:80,87`.
Deterministic at HEAD (4/4 runs). Proven pre-existing by restoring merge-base
`de936fe` bytes for BOTH `client-transport.ts` AND the integration test: same single
failure, 1 failed / 3 passed. Delta ∩ owned paths EMPTY.
**Getting the probe wrong first is the reusable lesson — see
`mem:gotcha-mixed-state-base-probe-fakes-a-base-red`.**
Still open, wants its own task: no `SeamObserver` seam through `startDaemon` or
`http-listener.ts`. Fix must be positive (inject/pin the clock); deleting the field
would hide a dropped-field transport.

## Drills I ran myself (epic rail 6)

- Re-add `origin: options.origin` to `headersFor` → `client-transport.test.ts`
  "sets the EXACT header set" RED (1 failed / 7 passed — precisely targeted) AND the
  integration Origin arm RED, because the ABSENT arm's request became admitted.
- Daemon guard → `if (true) return "LISTENER_ORIGIN_INVALID"` → the arm this task
  ADDED (`ADMITS the matching Origin`) RED, with 4 others that need admission.
- Both restored by `git checkout HEAD -- <path>`; sha256 re-matched
  (`cd1e11b8…` client, `e490e48d…` integration), owned-path `git status` clean.

## Why the fetch-layer wrapper is NOT a task-rail-2 violation

Task rail 2 bans hand-setting Origin *to satisfy the guard*. `fetchSupplyingOrigin()`
sets it in the FETCH layer, which is exactly what a browser does and exactly what
plan step 4 prescribed. The honest arm is `transportFor(daemon)` with **no wrapper**:
the shipped transport sends what it sends. Those two arms are each other's control —
the absent arm being REFUSED is what proves undici does not auto-supply Origin, so
the admitted arm is not vacuous.

## Other checks

Guard untouched (`git diff de936fe..HEAD --` empty for `http-listener-guards.ts` and
`http-listener.ts`). `generated-client.ts` untouched. `client-transport.ts` 158 lines
by `grep -c ''`. Vite dev proxy supplies Origin itself
(`apps/control-room/vite.config.ts:59-66`, `changeOrigin: true` +
`headers: { origin: DAEMON_ORIGIN }`) so the dev path never depended on the client
header. Task bytes were split across foreign whole-tree commits (`79d9651`, `702b28a`
carry the two test files; `48c6298` is this task's own) — not a rejection reason;
verified by base-ref diff and a clean owned-path status.
