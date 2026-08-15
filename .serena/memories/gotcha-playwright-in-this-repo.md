---
title: Adding Playwright to moe-next — four things that bite before the first test runs
---

# Playwright in moe-next

Landed by task-5529a248 as `@playwright/test@1.62.1` (bare pin — `pnpm-workspace.yaml`
sets `saveExact: true`, so a caret range is a rail violation). Config lives at
`tests/e2e/control-room/playwright.config.ts`; script is `pnpm test:e2e:browser`.

## 1. The types need the DOM lib, and `tsconfig.base.json` does not have it

`tsconfig.base.json` is `lib: ["ES2024"]`. `tsc -p` over any directory importing
`@playwright/test` then fails inside playwright-core's own `types.d.ts`:

```
node_modules/.pnpm/playwright-core@1.62.1/.../types.d.ts(12447,111): error TS2304: Cannot find name 'SVGElement'.
```

40+ of these. Fix is `lib: ["ES2024", "DOM"]` in the leaf tsconfig — a real
requirement of driving a browser, not a workaround. **Side effect:** any `*.test.ts`
in the same directory now also sees DOM globals, so a Node-vs-DOM confusion
(`setTimeout` returning `number` vs `Timeout`) stops being a type error there.

## 2. Do not use `...devices["Desktop Chrome"]`

The generated-config idiom pulls a device descriptor whose channel handling can
reach for an installed Google Chrome. `pnpm exec playwright install chromium` does
not place that. Use `use: { browserName: "chromium" }` — one explicit browser, no
emulation, no dependency on a binary the install step never provided.

## 3. Browser binaries are NOT in pnpm-lock.yaml

`pnpm install` gives you the package; the browser is a separate 114.5 MiB download
from cdn.playwright.dev into `%LOCALAPPDATA%\ms-playwright`. **CI must run
`pnpm exec playwright install chromium`.** Without it the lane fails on a missing
executable, which reads as a real defect.

## 4. An empty lane FAILS — verified, not assumed

`playwright test --grep <no-match>` → `Error: No tests found`, exit 1. Playwright's
`--pass-with-no-tests` defaults off, so this mirrors the root vitest
`passWithNoTests: false` and a `testMatch` typo cannot silently empty the gate.
Measure it anyway when you add a lane; "0 tests reported as success" is a common
driver behaviour and the failure is invisible.

## Naming keeps the lanes disjoint

Root vitest includes `tests/**/*.test.ts` under `environment: "node"`. Browser specs
must be `*.spec.ts` or they get executed under Node with no browser. The converse is
deliberate and useful: a pure-logic `*.test.ts` beside them runs in the fast Node
lane. See `mem:gotcha-root-vitest-globs-tests-tree-into-node-lane`.

## Bonus, unrelated to Playwright: `vite build` here is ~0.6s

Vite 8 / Rolldown. A browser test that builds the bundle and still finishes in 800ms
looks like the build was skipped. Check `dist/index.html` mtime before concluding
anything.
