# Gotcha: a 5s vitest timeout on /mnt/d reads as a logic failure

On this WSL2 box the repo lives on `/mnt/d` (Windows drive via 9p). Any test that walks the source
tree or spawns Node routinely blows vitest's **default 5000 ms** timeout under parallel load, and
the report looks identical to a real assertion failure until you read the error text.

Confirmed instances (2026-08-16), all of which PASS when re-run isolated with a longer timeout:
- `packages/runner/src/runtime-entrypoint.test.ts` — 2 "failures"; `--testTimeout=120000` -> 3/3 pass.
- `packages/testkit/src/foundation/foundation-spec.test.ts` and
  `foundation-incident-probe-precision.test.ts` — 3 "failures"; `--testTimeout=180000` -> 25/25 pass.
- `apps/daemon/src/recovery/recovery-completion.test.ts` — flaky the same way; failed in one full
  run and passed in the next with MORE code present.

How to tell them apart before blaming your diff: grep the output for
`Error: Test timed out in 5000ms`. A real defect prints an `AssertionError` with expected/received.

Corollary for the path-attributed baseline rail: do NOT compare raw failure COUNTS between two full
runs — they are not reproducible here. Move your owned files out, run the *same file subset*, move
them back, and compare the failing FILE SET. A HEAD set that is a subset of the baseline set is an
empty new-failure intersection.

Also: `pnpm` is not on PATH in these worker sessions. It resolves via `/tmp/moe-node24-bin/pnpm`
(corepack shim). `export PATH="/tmp/moe-node24-bin:$PATH"` first or every gate leg exits 127.
