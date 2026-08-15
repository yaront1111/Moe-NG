# Expansion planning hold lifecycle — final worker handoff

## Status
- Moe task `task-7f089e11daea44e9a483197ff139d725` is DONE.
- QA `qa-b2df68b9` approved it at 2026-08-09T14:54:39Z in `msg-a60265435e9c416bb6ae4388ea94c81c`.
- A post-approval, test-only hardening commit `329d9bb` was disclosed to QA and the governor in `msg-97321b175f094e6c82cd12c654ac1d9d`; prior QA must not be treated as covering that commit unless they review/note it.

## Owned paths
- `packages/core/src/expansion/expansion-planning-hold.ts`
- `packages/core/src/expansion/expansion-planning-hold.js`
- `packages/core/src/expansion/expansion-planning-hold.test.ts`
- `packages/core/src/index.ts`

## Delivered behavior
- Pure, deeply frozen reducer for expansion-planning holds.
- Opens only from exact `DAEMON_VERIFIED` / `WORK_RELEASE_OR_PAUSE` safe release evidence.
- Binds parent node/run/revision, planning run, proposal hash, source fingerprint, graph epoch, generation, deadline, handoff, and release evidence.
- Allows only `ACTIVE -> RESOLVED | SUPERSEDED | CANCELLED`.
- Creation and terminal receipts are bounded for replay/idempotency.
- Hostile inputs fail closed with stable exact reason codes and refusal layers.
- Snapshot normalization preserves hostile own keys via a null-prototype copy, preventing `__proto__` key smuggling.
- Hash-like fields require actual strings; null-prototype objects cannot throw during coercion.
- Root exports are reachable through the exact LF `.js -> .ts` bridge.

## Explicit commits
- `645fcbd fix(core): reject prototype key smuggling`
- `3576e06 style(core): compact expansion vocabulary`
- `56cebfc fix(core): reject non-string hold hashes`
- `329d9bb test(core): pin expansion release evidence`

Earlier task bytes were also swept into foreign whole-tree commits; do not amend, reset, or rewrite them.

## Fresh verification
Command:
`pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test`

Result after `329d9bb`: exit 0, 18 files / 272 tests.

Mutation drills reddened the exact intended boundaries:
- weakened safe-boundary truth -> exact `SAFE_BOUNDARY` failure;
- removed terminal authority gate -> exact `TERMINAL_PROOF` failure;
- disabled same-command ID comparison -> exact `IDEMPOTENCY` failures;
- weakened `disposition.strongestReason` binding -> exact `SAFE_BOUNDARY` failure.

## Broader-tree note
Root-wide gates were red only in foreign in-flight recovery-inventory work and an existing scheduler package-boundary scanner defect. Do not expand this task into those paths. The exact owned-package gate above is green.

## Consumers
- Immediate: `task-fcad40b6d26243439cd19fd3e49c924d`
- Durable daemon integration: `task-9634ed3b72014fe781591c7df9674da2`
