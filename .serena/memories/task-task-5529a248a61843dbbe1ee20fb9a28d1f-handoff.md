# task-5529a248 — Static browser journey harness — COMPLETE 9/9 (worker handoff)

Epic M3 `epic-923660dc`. Two commits, both explicit pathspec:
`7b21c99` (steps 2-3, lifecycle) and `cc68056` (steps 4-6, browser lane; 7 files,
298 insertions, 0 deletions).

## Final verified state

- `pnpm test:e2e` → exit 0, **3 files / 44 tests**, definition byte-unchanged
- `pnpm test:e2e:browser` → exit 0, **1 passed** in real Chromium
- `git status --porcelain` over owned paths → EMPTY

## What shipped

| file | lines | role |
|---|---|---|
| `harness.ts` | 152 | pure lifecycle, all effects injected ports, 4 frozen codes |
| `harness.test.ts` | 211 | Node lane, 10 tests, drives every failure branch with fakes |
| `static-ports.ts` | 168 | the REAL `vite build`, static server, HTTP probe |
| `control-room-smoke.spec.ts` | 30 | the ONE smoke journey |
| `playwright.config.ts` | 43 | `testMatch: "*.spec.ts"`, one browser |
| `tsconfig.json` | 11 | nothing typechecked this dir before |
| `.gitignore` | 6 | `test-results/`, `playwright-report/` |

Root `package.json`: exactly 2 added lines — `"@playwright/test": "1.62.1"` and
`"test:e2e:browser": "tsc -p tests/e2e/control-room/tsconfig.json && playwright
test -c tests/e2e/control-room/playwright.config.ts"`. `pnpm-lock.yaml` +38/-0,
every line attributable to playwright.

## The seam, for whoever composes the daemon-connected lane (task-667b1085)

`withStaticControlRoom(ports, body)`. `harness.ts` is PURE — swap `static-ports.ts`
for daemon-connected ports and nothing in the harness changes. That purity is
also why every reason code is provable in the Node lane with no browser and no
socket. Caveat posted as comment-c4a14002 on task-667b1085.

## Five things that cost real time

1. **`@playwright/test` needs DOM lib.** `tsconfig.base.json` is `lib: ["ES2024"]`,
   and playwright-core's `types.d.ts` then throws 40+ `TS2304: Cannot find name
   'HTMLElement' / 'SVGElement'`. The sibling tsconfig sets
   `lib: ["ES2024", "DOM"]`. Side effect worth knowing: `harness.test.ts` in that
   same directory now also sees DOM globals, so a Node-vs-DOM mix-up
   (`setTimeout` → `number` vs `Timeout`) is no longer caught there.
2. **`browserName: "chromium"`, NOT `...devices["Desktop Chrome"]`.** The
   generated-config idiom pulls a device descriptor whose channel handling can
   reach for an installed Google Chrome — a gate silently depending on a browser
   the install step never placed.
3. **`spawn("pnpm", [...], {shell:true})` emits DEP0190.** Windows needs
   `shell: true` for `pnpm` (a .cmd) but Node deprecates the argv-array form with
   it. Pass ONE fixed command string instead.
4. **`server.close()` alone is not teardown.** It waits for the keep-alive socket
   a just-loaded page still holds. Call `closeAllConnections()`. On Windows the
   survivor keeps file handles and resurfaces later as EBUSY.
5. **`vite build` here really is ~0.6s** (Vite 8 / Rolldown). The whole smoke test
   is 800ms, which looks like the build was skipped. It is not — `dist/index.html`
   mtime moves on every run. Verify by mtime, not by disbelief.

## Two properties MEASURED, not assumed

- **An empty browser lane FAILS**: `playwright test --grep <no-match>` → `Error: No
  tests found`, exit 1. Mirrors root vitest `passWithNoTests: false`, so a future
  `testMatch` typo cannot silently empty the gate and stay green.
- **The lanes are disjoint by NAMING only.** `vitest list tests/e2e` collects three
  files, zero `*.spec.ts`; `playwright --list` shows 1 test in 1 file, no
  `*.test.ts`. See `mem:gotcha-root-vitest-globs-tests-tree-into-node-lane`.

## Mutation drills (epic rail 6) — 6 run, 6 red, all reverted

Node lane: build code → wrong code (red naming `E2E_BUNDLE_BUILD_FAILED`);
readiness code → wrong code (red, TWO tests, incl. the precedence guarantee);
`failures.push(name)` → literal (red: `['not-the-real-name']` vs `['server']`).
Browser lane: `BUNDLE_DIR` → absent (red, `E2E_BUNDLE_BUILD_FAILED` — and note
`vite build` still exited 0, so what refused was the *entry-missing-afterwards*
check, i.e. the mis-resolved-`REPO_ROOT` guard is not dead code); probe → always
false (red, `E2E_READINESS_TIMEOUT` at **30.8s** wall clock, terminated not hung);
`cr.shell.root` → absent id (red, `14 × locator resolved to 0 elements`).

**Every drill asserted its own mutation applied** (`git diff --quiet` → abort as
VACUOUS) before running. A `perl -pi` that misses leaves the file untouched and
the suite green, which reads as "drill ran, test is weak". See
`mem:pattern-guard-the-case-list-not-just-the-cases`.

Committing `cc68056` BEFORE the drills is what made every `git checkout --` revert
exact — see `mem:mutation-drills-in-shared-worktree`.

## For QA

- **CI must run `pnpm exec playwright install chromium`** before `test:e2e:browser`.
  114.5 MiB from cdn.playwright.dev, NOT in `pnpm-lock.yaml`. Stated, not assumed.
- `test:e2e` moved 2 files/34 tests → 3 files/44 tests. Its DEFINITION is unchanged
  and it exits 0; the third file is the deliberate Node-lane lifecycle test. DoD 2
  is "keeps its exact definition and still exits 0" — not "never gains a test".
- Nothing imports `tests/e2e/foundation/**`; the two grep hits are doc comments
  naming the mirrored convention.
- Not done, disclosed: no OS process-table check after the run. Teardown is proven
  by the port test, by `closeAllConnections()`, and by two real browser runs that
  failed and still exited — that is the code path, not a process observation.

## Related

`mem:gotcha-root-vitest-globs-tests-tree-into-node-lane`,
`mem:convention-commit-by-pathspec-in-a-shared-index`,
`mem:mutation-drills-in-shared-worktree`,
`mem:gotcha-fs-stat-throws-instead-of-falsy`.
