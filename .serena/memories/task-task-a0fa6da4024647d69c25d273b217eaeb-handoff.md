# Task task-a0fa6da4024647d69c25d273b217eaeb (Codex runtime adapter) — QA APPROVED

QA: qa-b2df68b9, 2026-08-09. Verified against the four DoD items, the six epic rails and the four task rails. Approved.

## Commands re-run by QA (all foreground, exit 0)
- `pnpm --filter @moe/runner test` (task.verification): **37 files / 1104 tests passed**.
- `pnpm --filter @moe/testkit test`: 19 files / 239 tests passed.
- `npx vitest run --root .` (repo-wide): **187 files / 3317 passed, 1 skipped**. Zero foreign red, so the path-attributed baseline is trivially empty.
- `pnpm --filter @moe/runner typecheck` and `pnpm --filter @moe/testkit typecheck`: both exit 0.
- Codex subtree alone: 7 files / 61 tests.

## DoD evidence
1. **Immutable probe/closure, unproven typed UNSUPPORTED** — `codex-probe.ts:67,90` deepFreeze profile + freeze result; `codex-observation.ts:191` deepFreeze observation. `codex-capabilities.ts:180-182` `record()` collapses every unproven case to `UNSUPPORTED`/`proofMethod:"NONE"`; RESUME hard-pinned false; frozen `UNPROVEN_PROBE_REPORT` is the fallback for throwing/partial/hostile ports (`codex-probe.ts:53-59,93-99`); `capabilityStatus` defaults UNSUPPORTED.
2. **Contract parity** — `codex-parity.test.ts` compares production surfaces of both providers, asserts non-empty before set-equality, drives EXITED/SIGNALLED/UNOBSERVED through both real reconcilers, compares actual outcomes over the shared cancel/exit table, and pins the one intentional difference (`CWD_OBSERVATION`) with two hand-written capability lists plus an empty reverse-diff.
3. **No authority from provider output** — `codex-render.test.ts:86-94` pins the exact sorted key list of the envelope AND of a layerManifest entry; `authority:"NONE"`, `advisoryOnly:true`, frozen, `renderedBase64` (never Uint8Array). No command/effect/lease/verification field anywhere.
4. **Focused tests pass** — see above.

## Mutation drills QA ran independently (restore verified by sha256sum -c, not git status)
- `record()` always SUPPORTED -> 2 files / 7 tests RED.
- Closure path sort removed -> 1 test RED.
- Per-case raw sha256 nibble flipped inside the corpus DATA block -> **BOTH** suites die at module load: runner 61->48 tests with one file dead, testkit reports "no tests".
- Real delivery-order GAP rule (`sequence > last + 1`) -> 3 tests RED, so the set-based rule is genuinely pinned.

## Rail checks
- Supervisor fence: grep for `child_process|spawn|\.kill|Date\.now|Math\.random|new Date|performance\.now|process\.env|require\(` over the whole codex tree returns **zero** hits.
- Per-file cap: largest production file is `codex-capabilities.ts` at 216 lines; every production source is under 250.
- Bridges: 8 `.js`, each exactly `export * from "./<name>.ts";` + LF, no CR; all load under Node v24.16.0 with non-empty export sets (3-11 each). Testkit corpus correctly has no bridge, asserted by `codex-golden-streams.test.ts:57`.
- Owned paths: `git status --porcelain` clean, 25 files tracked at HEAD, no debug/scratch/probe files, no CR bytes in any owned `.ts`.

## Attribution
Harness auto-commit again swept the 17 TS files into foreign commits 20c41a4 / 878538b; e21a3c1 carries the 8 bridges plus the max-event repair. Content at HEAD matches the working tree. History was correctly left alone. See `mem:gotcha-moe-wrapper-autocommit`.

## Downstream
Unblocks task-e87a7353 (Linux effect conformance) and task-e94b2055 (macOS effect conformance).
