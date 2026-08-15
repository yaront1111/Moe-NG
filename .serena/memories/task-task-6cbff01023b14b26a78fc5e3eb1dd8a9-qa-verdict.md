# QA verdict: Durable Claude attempt dispatch

Rejected from REVIEW to WORKING on 2026-08-16.

## Verification
- Reviewed committed task diff at `5e7247683589f063bbb099f6ddf8268b0e7acb7f` over the five owned paths.
- Re-ran the persisted scoped gate under Linux Node 24.16 / pnpm 11: focused daemon suite executed 1 file / 16 tests and passed; scoped typecheck grep found no task-path errors.
- Production line counts: `foundation-attempt-contracts.ts` 359; `foundation-attempt-service.ts` 294. This fails the task's explicit DoD 6 and approved step-7 <=250 checks, notwithstanding the broader split-before-400 rail.
- Worker disclosed production preceded the literal RED run, violating the task's TDD rail.

## Independently reproduced defects
1. A test-injected whole `launch` function can return only `{kind:"OBSERVED", truthClass:"PROVEN"}`; service accepts it and persists PROVEN without runner grant consumption, PREFLIGHT/STARTED observation, or real registration evidence.
2. Replay identity hashes only `activationRequestBytes`. Same activation with changed `launchTemplate.cwd` is accepted as idempotent success rather than `FOUNDATION_ATTEMPT_RECORD_DRIFT@DAEMON_FOUNDATION_ATTEMPT`.
3. Cross-session durable binding is checked only after `runEffectActivateCommand`; the service refuses binding mismatch but leaves an `EffectActivationCommitted` event behind.
4. Revoked proxies and throwing `ownKeys` proxies escape as exceptions from request decoding instead of typed `FOUNDATION_ATTEMPT_REQUEST_MALFORMED@DAEMON_FOUNDATION_ATTEMPT`.
5. Both production sources exceed the explicit 250-line DoD.

Failed DoD items: 1, 2, 3, 5, 6. Reopen must add named RED tests first, split production modules, bind replay to the full request, preflight the session/node binding before authority writes, contain hostile JS values, and replace the whole-launcher test seam with a real runner-consumption path or sufficiently narrow non-authoritative seam.