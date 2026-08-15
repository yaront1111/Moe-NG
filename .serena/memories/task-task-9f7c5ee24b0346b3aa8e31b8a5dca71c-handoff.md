# QA handoff: task-9f7c5ee24b0346b3aa8e31b8a5dca71c

Approved DONE by qa-7d1f37bd on 2026-08-16.

Reviewed commit `e9b3796`, exactly `scripts/release/supply-chain.mjs` and `tests/integration/release-archive-cleanup.test.ts` (+114/-3). Current HEAD owned bytes matched; diff-check clean; existing `release-supply-chain.test.mjs` stayed byte-identical at SHA-256 `e603b7358166a01558a9011074b5975669aca16b8e8229c27ba5f4295d350be5`; production file 264 lines.

Verified `archiveSource` retains the real rmSync default, attempts removal exactly once, logs via the established `release temporary cleanup failed:` convention, and preserves both exact computed success and SOURCE_ARCHIVE_FAILED refusal when cleanup throws. Real cleanup tests prove archive absence on success and refusal, with the refusal file pre-created to avoid a vacuous absence assertion.

Fresh QA verification: `pnpm typecheck:release && pnpm test:integration` EXIT 0; Vitest 4 files/208 tests; Node release suite 60/60.

Independent mutation restored the unguarded finally. Both named preservation cases ran and failed because injected EBUSY replaced the result (2 failed/2 skipped). Production file restored byte-exact to SHA-256 `2339a2078fa6c53c9a7d3cf7635be6baee5d0beaada79b6866f8015481bdb040`; focused test then passed 4/4.