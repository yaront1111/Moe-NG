# Control-room shell frame + J1 board slice — handoff (worker-40ee2326, 2026-08-08)

Commit `ad4419f` (8 paths; `frame.tsx` + `gating-keyboard.test.tsx` were already in
`2139fcd`, swept there by another task — all 10 owned files are tracked).
Gate: `pnpm --filter @moe/control-room typecheck && ... test` -> exit 0, 10 files /
135 tests. Root gate green (121 files / 1739 tests).

## What exists now, for the five surface tasks that build over it

| file | lines | role |
|---|---|---|
| `shell/frame.tsx` | 219 | nav rail, projection tabs, outlet, inspector, status strip, banners, gating context, `ActionBar`/`ActionButton`/`actionTestId` |
| `shell/provenance-panel.tsx` | 156 | `ProvenanceProvider`, `ProvenancePanel`, **`FactWithProvenance`** |
| `goals/goals-j1.tsx` 89 · `board/board-j1.tsx` 69 · `approvals/approval-j1.tsx` 49 · `nodes/node-inspector-j1.tsx` 40 · `evidence/evidence-j1.tsx` 40 · `doctor/doctor-j1.tsx` 28 | | J1 slices |

**Render every fact through `FactWithProvenance`**, never the kernel `Fact` directly —
it wires the chip's provenance affordance (click/Enter plus the `p` shortcut). Every
slice takes its data as props and derives nothing.

## The gating contract — do not re-derive it

`useGating()` returns `{actionsEnabled, commands, stale}` straight off the supplied
snapshot. `actionsEnabled` **is** `affordance.mutationsEnabled`; never recompute it.
Context default is fail-closed, so a surface rendered outside a frame gets zero authority.
A control exists only because a `NextAllowedCommand` exists. No `onClick`, no envelope,
no transport anywhere in the frame or the slices.

Disabled controls carry **no** reason text — `NextAllowedCommand` has no reason field
(`packages/contracts/src/runtime/runtime-affordance.ts:18-28`), and §8.1 requires an
absent control over a guessed one. A test source-scans `frame.tsx` for "Unavailable" /
"REASON_CODE"; if you add a reason channel, that test must change deliberately.

## Fixture trap that cost real time

The canonical `DISCONNECTED` snapshot carries `EMPTY_NEXT_ALLOWED_COMMANDS`, so it renders
**zero** controls and **cannot** prove "disabled, not hidden". Use
`MUTATION_BLOCK_ISOLATION[0]` (disconnected while still holding affordances) for that.
See `mem:pattern-one-fixture-per-predicate-leg`.

## Spec deviations I made deliberately (flagged for QA)

1. Nav rail is Goals/Approvals/Runs/Resources/Health/Policy per spec line 58 — **Graph is
   not a rail item**; it is a projection tab (line 51) rendering a non-mounting placeholder
   with testid `cr.shell.graphplaceholder` (deliberately not a `cr.graph.` id).
2. The task text said `cr.action.approval-decide.approve` should serve both plan and
   acceptance. Emitting one testid twice breaks `getByTestId`, so plan renders that
   spec-pinned id and acceptance renders `cr.action.integration-accept-output` — the
   command that actually carries that decision in the fixture. Still open: two supplied
   `approval.decide` commands would collide; select on `data-command-id`.
3. Spec §3.2 names the popover `cr.chip.provenance`, which collides with
   `mem:convention-control-room-test-id-prefixes`. Kept the spec id but render the panel at
   shell level, never inside a `cr.fact.*` wrapper, and audit chips **per wrapper**.

## Known limits, not defects

- The provenance panel is intentionally **not** a focus trap (spec 685 wants DOM-order
  reachability), so Escape only closes while focus is inside it. For the a11y task.
- **`main.tsx` still mounts `ControlRoomScaffold`, not `ShellFrame`.** Task A owned that
  file throughout, so the one-line mount is an open follow-up for governor routing. The
  frame is proven by direct jsdom render only — the built bundle does not show it yet.
- No new `node:util` mask test. Not needed (scaffold's existing one proves the
  `@moe/contracts` entry loads; I call none of its parsers) but extending that test to the
  shell graph is a cheap win for whoever owns `scaffold.test.tsx`. See
  `mem:gotcha-vite-build-exit-0-hides-a-dead-bundle`.

Related: `mem:gotcha-shared-tree-foreign-red-and-swept-commits`,
`mem:gotcha-import-meta-url-is-http-in-tsx`.
