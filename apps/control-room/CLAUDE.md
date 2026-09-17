# @moe/control-room

The browser UI: a Vite + React 19 app that renders the offers `/affordances/read` folds and
nothing else. It is `private`, has **no** `exports` map and no Node entry — the one workspace
package `tests/runtime/package-loadability.test.ts` justifies by name ("browser-only Vite
application; no Node entry by design"). Everything authority-bearing it sends is copied off a
daemon-issued offer; it authors only payload, correlation id, request digest and credential, and
its refusals are its own, stamped `CONTROL_ROOM_*`, never a recoded daemon refusal.

## Seams

- No package entry point: callers reach in by deep relative path, always `.js`-spelled.
- `src/main.tsx` — composition root: `mountControlRoom(container, clock, hostname)`,
  `BROWSER_CLOCK`, `CONTROL_ROOM_ROOT_ELEMENT_ID`, and `CONTROL_ROOM_ROOT_MISSING` thrown rather
  than mounting nothing. Module graph walked by `http-listener-read-dispatch.test.ts`.
- `src/live/live-dispatch-payloads.ts` (`DEV_PAYLOADS`, `PLANNING_CHAIN_STEPS`, `payloadFor`) —
  loaded at *runtime* by the daemon's wrapper through `loadPayloadHints`
  (`apps/daemon/src/orchestrator/wrapper-payload-hints.ts`), staged by `pack-windows.ts` and
  required by `REQUIRED_STAGED_PATHS` in `tools/packaging/pack-inventory.ts`; type-only imports
  so it runs as staged.
- `src/live/dev-proxy-paths.ts` (`DEV_PROXY_PATHS`, `buildDevProxy`) — consumed by
  `vite.config.ts`, read as *source text* by `http-listener-read-dispatch.test.ts` and
  `apps/daemon/src/daemon-main-activation-boot.test.ts`.
- Reached by `tests/integration/control-room/*` and `tests/security/*-hostile-cases.ts`:
  `live/live-board-feed.ts` (`frameOfSurface`), `live/live-dispatch.ts` (`dispatchAffordance`),
  `live/live-planning-authorities.ts`, `live/live-handshake.ts`, `live/live-budget-commitment.ts`,
  `live/live-bootstrap-receipt.ts`, `v2/goals/plan-approval.ts`, `v2/goals/gate1-approval.ts`,
  `v2/goals/use-goal-prd.ts`, `v2/ops/activation-port.ts`, `v2/resources/resources-model.ts`,
  `v2/projects/project-manager-client.ts` and `performance/effort-collector.ts`.
- `v2/shell/nav-rail.tsx` carries the release series string as markup. Deps run one way
  (`@moe/contracts`, `core`, `control-room-model`, `control-room-client`); none reach the daemon.

## The model

- **Route is chosen before React.** `resolveProjectManagerMode` (`entry-project-manager.ts`):
  the fixed loopback host `PROJECT_MANAGER_HOSTNAME = "127.0.0.2"` always selects the project
  manager, `?projects=1` only under `import.meta.env.DEV`. Manager mode beats every query route
  and short-circuits pairing, so no one-use project credential is minted. `gateDevelopmentQuery`
  (`entry-route.ts`) drops `v1` always, `fixtures` in a production build. `main.tsx` scrubs
  `location.hash` first and starts each handshake promise once outside React, so both StrictMode
  effect passes observe the same promise.
- **Attachment is `resolveLiveSetupFromHandshake`** (`live/live-handshake.ts`): GET `/bootstrap`,
  restore a saved session via `/session/validate`, else `/session/pair/request`. Exactly four
  refusal codes (`LIVE_CONFIG_REFUSAL_CODES`): `LIVE_CONFIG_MISSING`, `LIVE_COMPAT_REFUSED`,
  `LIVE_BOOTSTRAP_UNAVAILABLE`, `LIVE_PAIRING_REFUSED`. Terminal availability rides the response
  header `x-moe-operator-channel`, out of the compatibility-frozen
  `[confirmationLabel, ok, requestId]` body, and anything but `"true"`/`"false"` is refused
  rather than defaulted to available. `commandAuthorityPlane` is whatever the daemon *states*;
  `live/live-config.ts` is the legacy build-time path (`VITE_MOE_LIVE_CREDENTIAL`,
  `VITE_MOE_LIVE_CSRF`) and states `"V1"` explicitly because it reads no bootstrap.
- **Three connection facts, not two.** `frameOfSurface` returns `CONNECTED` only for a valid
  surface; a *delivered* answer the board cannot act on (daemon refusal or unreadable body) is
  `LAGGING`, with the daemon's own fields; `DISCONNECTED` means the round trip never delivered.
- **Planning authority is per run.** `planningGoalRefs` is the map; the singular
  `planningGoalRef` is compatibility only and never widened into it. Sealed material lives in a
  module-private WeakMap keyed by the exact frozen offer objects `frameOfSurface` mints, so a
  structurally identical literal carries nothing (`dev-payload-parity.test.ts`).
- **Dispatch adds the caller half only.** `dispatchAffordance` reports `ANSWERED`,
  `BUILD_REFUSED` or `UNDELIVERED`; its two caller-side refusals are spelled
  `PLANNING_OFFER_BINDING_ABSENT @ CONTROL_ROOM_LIVE_DISPATCH` and
  `BUDGET_COMMITMENT_READER_ABSENT @ …`. No card moves on a dispatch — the next poll moves it.
- **Every wire body is exact-key decoded** by `live/live-wire-primitives.ts` (`exactDataRecord`,
  `listOf`, `sha256Hex`) or `live/live-effect-read.ts` (`effectRecord`, `effectList`,
  `effectOffer`): plain prototype, exact key set, own enumerable *data* properties, frozen
  null-prototype copy. An accessor or a proxy is refused without ever being invoked.
- **`v2/approvals/offer-wire.ts` is the one spend path** for inline decisions and returns the
  refusing authority's own `code`, `layer` and optional `detail` unsummarised. `*-port.ts` files
  are the browser half of one command each, stamping their own `CONTROL_ROOM_*` layer.
- **`v2/shell/shell-routes.ts` is the only route source.** `CORDUM_ROUTE_KINDS` derives the
  `CordumRoute` union, `boardRoute()` is the only board-route constructor, and a nav id absent
  from `BUILT_NAV_ROUTES` renders DISABLED with `NAV_DESTINATION_NOT_BUILT`, never merely inert.
- **`v2/truth-class.ts` owns presentation, not validity**: `sayWho` defers to
  `describeTruthClass` (`@moe/control-room-model`); absent and malformed both render UNKNOWN but
  carry `CORDUM_ABSENT_NOTE` vs `CORDUM_INVALID_NOTE`. `useEffectRead`
  (`v2/components/use-effect-read.ts`) returns `null` whenever the reader identity changes, so a
  credential or goal switch blanks stale data.
- `main.tsx` is the only production module that reads a clock or `location`, and `BROWSER_CLOCK`
  is **monotonic** (`performance.now`) so an NTP step cannot fake a negative span and
  `TIMING_NEGATIVE_INTERVAL` stays reserved for real daemon/client skew. **No production module
  imports `node:*`** — all 37 `node:` importers are tests, and
  `tests/e2e/control-room/dev-module-graph.spec.ts` fails the browser lane on `node:crypto` or
  "externalized for browser compatibility".

## Gotchas

- **Ten `.js` bridges, under `src/live` and `src/performance` only** — the closure plain Node
  must load (`live-wire-primitives.ts` states the rule); the rest of the folder needs none. The
  2026-08-20 incident in `wrapper-payload-hints.ts`: `live-dispatch.ts` grew a `.js` import with
  no bridge and every wrapper mission shipped hintless. Vitest rewrites `./x.js` back to `.ts`,
  so no suite here can see a missing bridge.
- **Neither `pnpm test` nor `pnpm typecheck` sees this folder** (the root vitest include has no
  `apps/**`). Four hand-mirrored censuses elsewhere pin it:
  - `tests/security/boundary-roster.security.ts` pins `"apps/control-room": 14`. Its scanner is
    `.ts`-**only**, so `NEW_PRODUCT_LAYER` in `v2/products/live-new-product.tsx` is invisible to
    it. A new `export const *_LAYER` in a `.ts` file reds `pnpm test:security` alone.
  - `tests/security/layer-visibility-cases.ts` is a *second* roster: a layer stamp whose refusal
    never reaches a wire is enrolled in its `UNSCANNED_PRIVATE_LAYERS` /
    `EXPECTED_PRIVATE_COUNT = 82` instead of the boundary roster.
  - `apps/daemon/src/gates-roster-coherence.test.ts` walks `apps/control-room/src` for
    hand-transcribed `contractSchemaHash: "<64 hex>"` and `CONTRACT_DIGEST = "..."`. Three live
    in `.tsx` here (`approve-plan.test.tsx`, `approve-plan-reject.test.tsx`,
    `plan-run-resolution.test.tsx`) and a regeneration means editing all three by hand.
  - `tests/integration/release/release-version-surfaces.test.ts` pins the literal
    `className="cr2-brand-version">v0.1</span>` in `nav-rail.tsx` against the release series.
- `http-listener-read-dispatch.test.ts` keeps an **empty** census of daemon JSON routes the dev
  server does not proxy: adding a route without its `DEV_PROXY_PATHS` pin reds there, and so does
  adding a pin without retiring its census entry. A route missing from `DEV_PROXY_PATHS` is
  answered by Vite itself — for `/backups/read` or `/deployments/health/read` the operator then
  reads fabricated state. `MOE_DAEMON_ORIGIN` retargets the proxy (`http://127.0.0.1:39123`).
- **jsdom 30 has no `matchMedia`, no media-query evaluation, and `document.styleSheets.length`
  is 0** because Vitest stubs CSS imports. Every style assertion reads stylesheet *bytes* from
  disk: `a11y/motion-inventory.test.ts` (≥13 stylesheets, the
  `@media (prefers-reduced-motion: reduce)` gate in `cordum-shell.css`) and
  `v2/styles/cordum-contrast.test.ts` (WCAG AA computed from `cordum-tokens.css` hexes).
- Under jsdom the global `URL` resolves a relative specifier against the document base, so
  `new URL(".", import.meta.url)` yields `http://localhost:3000/...`; convert `import.meta.url`
  directly. Other suites read **cwd-relative** paths and only pass with this package as cwd —
  `design-version-note.test.tsx` and `statement-folds.test.tsx`; the frame the first reads,
  `v2/goals/design-read-frame.captured.json`, is a captured real daemon answer.
- `vite.config.ts` **replaces** the root vitest config outright (it also serves dev and build)
  and owns `environment: "jsdom"` and `sequence.concurrent: false`. `v2/cordum-fonts.ts`
  self-hosts `@fontsource` faces because the host's `default-src 'self'` CSP blocks Google Fonts.

## Testing

- Whole package: `pnpm --filter @moe/control-room test` (195 test files, 100 of them `.tsx`).
  One file: `pnpm --filter @moe/control-room exec vitest run src/v2/goals/goal-card.test.tsx`.
- `pnpm --filter @moe/control-room build` writes `dist/`, served by
  `tests/e2e/control-room/static-ports.ts`; the browser lane is `pnpm test:e2e:browser`
  (`tsc -p tests/e2e/control-room/tsconfig.json`, then Playwright), whose fixture specs attach
  no daemon — `?fixtures=1` renders the committed `v2/workspace/fixtures/*` data.
- Outside coverage: `pnpm test:security` (`boundary-roster`, `layer-visibility-cases`,
  `runtime-provider-control-room`, `transport-hostile-*`, `scheduler-activation-hostile-cases`,
  `recent-*-hostile-cases`); `pnpm vitest run tests/integration/control-room`, where
  `dev-payload-parity.test.ts` carries real `resolvePlanningAuthorities` output over
  `frameOfSurface` before the browser authors anything; `pnpm test:e2e`, which runs
  `tests/e2e/control-room/journey-coverage.test.ts` in the Node lane (20 declared scenarios, each
  COVERED or UNKNOWN with a named cause) and scans production source for the `cr.`-prefixed
  `data-testid`s it records absent, so shipping one flips an UNKNOWN red; and
  `pnpm --filter @moe/daemon test` for the two daemon-side censuses above.
