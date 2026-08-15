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

It is NOT only the 5000 ms default — an explicit multi-second budget can lose too. Confirmed
2026-08-16 at HEAD 6ca5da0: `apps/daemon/src/runtime-entrypoint.test.ts` (distinct from the
runner file above) sets its own `RUNTIME_FILESYSTEM_PROBE_TIMEOUT_MS = 30_000` at line 10, and
its succession-surface probe still times out because a cold `import("@moe/daemon")` in a real
child Node costs **33.5s** on this fs. Running that probe's exact source by hand returns
`{"outcome":"IMPORTED", ...}` with every expected export. Same run reported transform 105.92s /
import 108.06s. So: a `runtime-entrypoint` red here is an I/O budget miss, not a broken surface.

Do NOT read that timeout as a missing `.js` bridge. Those bridges (e.g.
`orchestrator/verifier-process-runner.js`, a one-line `export * from "./verifier-process-runner.ts"`)
are git-TRACKED next to their `.ts`. An actually-absent bridge fails the probe's `toEqual` with
`{outcome: "FAILED", code: "ERR_MODULE_NOT_FOUND"}` — it can never produce `Test timed out`.

## Toolchain PATH (two different dirs — don't conflate)
- Default `node` on this box is **v18.19.1**, but the repo needs `>=24.16.0 <25` for native TS
  type-stripping. Under v18 an entire package suite dies at startup with
  `SyntaxError: Unexpected token '{'` and reports ZERO tests — easy to misread as a missing module.
- Node 24 lives at `/tmp/moe-node-24.16.0/bin` (verified v24.16.0).
- `pnpm` is not on PATH in these worker sessions; it resolves via `/tmp/moe-node24-bin/pnpm`
  (corepack shim), which also carries a `node`. `export PATH="/tmp/moe-node24-bin:$PATH"` first
  or every gate leg exits 127.
- The daemon gate has no `vitest.config.ts`; its own script is
  `npx vitest run --root . --config package.json src` run from `apps/daemon`.
