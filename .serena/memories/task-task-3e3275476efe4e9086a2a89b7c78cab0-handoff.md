# task-3e3275476efe4e9086a2a89b7c78cab0 handoff

## Delivered
- `viewport.ts`: frozen COMFORTABLE >=1200 / FUNCTIONAL 960..1199 / NARROW <960 ladder, total classifier, exact `INVALID_VIEWPORT_WIDTH`, and innerWidth+resize hook with exact cleanup.
- `nav-rail.tsx`: preserved `cr.nav.*` ids/order, icon presentation, and accessible names identical to wide labels.
- `inspector-sheet.tsx`: narrow-only dialog semantics and Escape dismissal separate from persistent operator `[ / ]` expansion choice; children/identity remain mounted.
- `frame.tsx`: composes narrow marker, nav, inspector and the existing help dialog populated from the same frozen nav-label source.
- `shell-layout.css`: imported responsive shell grid/icon rail/inspector sheet, <=959px media query, and independently pinned reduced-motion block without content-removal rules.
- Tests drive real `window.innerWidth` resize state, explicit non-empty wide/narrow id-set parity (nav/tabs/skiplink/inspector/facts/cards), action parity, two-dialog Escape targeting, and loading/empty/degraded/lag survival. CSS assertions are source pins, never pixel claims.

## Verification
- Fresh completion command: `pnpm --filter @moe/control-room test` => 32 files / 478 tests passed, exit 0.
- `pnpm --filter @moe/control-room typecheck` => exit 0.
- Fresh repo `pnpm test` => 191 files, 3489 passed / 1 skipped, exit 0.
- Five byte-backed drills went red in the intended named tests and restored hashes: 959/960 boundary, resize cleanup, narrow-only dialog role, help nav label, narrow-only nav id.
- Repo `pnpm typecheck`, `verify:foundation`, and `verify:store` are foreign red only because untracked `apps/daemon/src/http/http-listener.test.ts` imports absent `./http-listener.js`; no failing path intersects owned `apps/control-room/src/shell/**`.

## Shared-tree attribution
Task started at HEAD `174c07ba13e7940b0cdfc24c368084ebbb228c57`; foreign commits advanced HEAD during work. Final explicit task commit is `866db6eaf537bb72c89ef427d67f8b87fc88d0a6`, containing only the seven owned shell paths. Owned working blobs were clean and matched that commit after the named gate. Do not attribute concurrent performance/store/runner/daemon work to this task.

## Explicit non-coverage
Actual pixel geometry cannot be certified in jsdom. Section 4.16 surface-level reflow remains `task-fdf3e6aaaa4a4b7c86a08d9d8fc4f919`. Graph zoom/minimap/legend and table wrapping remain explicit N/A: production still mounts GraphPlaceholder with no `cr.graph.*`, and no table/thead/tbody/role=grid or Runs/Resources surfaces exist.

## Worker completion — 2026-08-09

Delivered in explicit-path commit `866db6eaf537bb72c89ef427d67f8b87fc88d0a6`:
- `viewport.ts`: frozen 1200/960/0 ladder, total classifier with `INVALID_VIEWPORT_WIDTH`, resize hook and exact cleanup.
- Shell composition: rendered `data-narrow`, accessible icon rail, complete help-label list, narrow-only inspector dialog with Escape dismissal independent of the operator's `[`/`]` expanded choice.
- `shell-layout.css`: <=959px rail/sheet source rules and a local reduced-motion block.
- Non-vacuous explicit wide/narrow id-set parity plus loading/empty/degraded/lag preservation and source-text pins.

Five required production mutation drills were visibly applied, killed by named tests, and raw-hash restored: boundary, resize cleanup, narrow-only dialog role, omitted help label, and narrow-only nav id. A further `display:none` no-whitespace drill confirmed the CSS no-removal regex is whitespace-insensitive.

Fresh committed-state evidence:
- `pnpm --filter @moe/control-room test`: 32 files / 478 tests passed, exit 0.
- `pnpm --filter @moe/control-room typecheck`: exit 0.
- `pnpm test`: 191 files / 3489 passed / 1 skipped, exit 0.
- `pnpm typecheck`: foreign red only in untracked `apps/daemon/src/http/http-listener.test.ts` missing `./http-listener.js`; no shell path intersects.
- All seven owned working blobs matched HEAD after the final gate.

Explicit non-coverage remains actual pixel reflow, surface-level section 4.16 work owned by `task-fdf3e6aaaa4a4b7c86a08d9d8fc4f919`, and graph/table clauses for the recorded not-applicable reasons.
