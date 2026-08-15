# Gotcha: root integration's actual release package case is win32-only

`tests/integration/release-supply-chain.test.mjs` always expects `pnpm release:evidence` to succeed. But `scripts/release/supply-chain.mjs` deliberately refuses when `input.platform !== "win32"` with `SUPPORTED_OS_EVIDENCE_MISSING@RELEASE_SUPPLY_CHAIN`; its CLI supplies `process.platform`. Therefore the exact root integration gate is predictably red on Linux at the final actual-package case even when all Vitest tests and the other Node tests pass.

When attributing a task's Linux QA gate, compare this guard/test to the merge-base and disclose it rather than claiming raw green or blaming an unrelated inventory change. Native Windows remains the authoritative positive lane until cross-host evidence tasks land.