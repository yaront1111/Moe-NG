# task-4b274fadc69b457abb1f68512853c41e — motion + colour-independence guards (REVIEW)

Commit `070a9b1` on `moe/work-2026-08-08`. Four test files, **zero production
changes**. Gate: `pnpm --filter @moe/control-room test` -> 44 files / 622 tests, exit 0.
Repo-wide also green (205 files / 3894 tests; `pnpm --recursive typecheck` 16/17 projects).

## What landed

| File | Lines | Property |
|---|---|---|
| `a11y/motion-inventory.test.ts` | 306 | motion is GATED (not banned) + JS motion absent + N/A record |
| `a11y/colour-independence.test.tsx` | 225 | spec 11.1 bullet 1, non-chip half, over real renders |
| `a11y/banner-politeness.test.tsx` | 144 | invalidated + circuitbreaker polite; banner-id set pinned |
| `shell/gating-keyboard.test.tsx` | +18 | `role="alert"` no longer accepted for `cr.banner.disconnected` |

## Every count in the task description was stale — re-measure before trusting it

Description claimed: one 77-line stylesheet, ZERO motion, zero colour literals, three
banners, `cr.banner.circuitbreaker` absent. All false as of 2026-08-09:

- **16** `.css` files. **7** motion declarations across 4 sheets: `styles/chrome.css`
  (`@keyframes cr-shell-enter` + its `animation`), `styles/shell.css` x2,
  `styles/surfaces.css`, `shell/shell-layout.css` x2.
- **4** reduced-motion blocks: `approvals/approval-layout.css`, `board/board-layout.css`,
  `shell/shell-layout.css`, `styles/responsive.css`.
- **65** colour literals over six sheets (tokens 39, chrome 8, shell 6, surfaces 5,
  inspector 4, responsive 1). WCAG AA already asserted in `styles/design-system.test.ts`.
- **4** banners, all already polite: `cr.banner.disconnected` + `cr.banner.lag`
  (`shell/shell-chrome.tsx`, NOT frame.tsx — they moved), `cr.banner.invalidated`
  (`approvals/approval-detail-plan.tsx`), `cr.banner.circuitbreaker`
  (`shell/circuit-breaker-banner.tsx`). `cr.banner.revision` / `cr.graph.refusal` do not exist.

## The design decision QA will ask about

The governor's corrected DoD said every motion declaration must be overridden inside a
reduced-motion block **in the same stylesheet**. Not satisfiable: chrome/shell/surfaces
carry motion with no same-file block, and adding one is a production CSS edit that
taskRail 2 forbids. Their gate is the global `*, *::before, *::after` `!important` reset
in `styles/responsive.css`, `@import`ed by `styles/control-room.css`.

So the guard asserts: **each motion-bearing sheet has its own block OR is imported into
`control-room.css` while `control-room.css` still imports the reset.** It does not ban
motion (the governor's explicit rejection condition) and does not ban `scroll-snap`
(asserted positively so a future guard cannot).

### RATIFIED — the governor superseded their own correction (architect-705f0380, 18:37Z)

The deviation above is **authorised, not a liberty taken.** governor-42b952c9 re-measured
independently and superseded the 15:44Z "same stylesheet" note in `#governors`
(`msg-f91f6d76788e4ceb82fe19d7b35e3bf8`):

> "proving motion is GATED via the global reset at `responsive.css`, imported at
> `control-room.css`, **satisfies DoD 1**. Do not require a same-stylesheet `@media`
> block. Do not reject on deviation from the 15:44Z note — I am superseding it here
> with measurement."

Their reasoning: the correction was written against an incomplete measurement (it found
`shell-layout.css` and missed the other five motion sites plus the reset entirely), and
**an unsatisfiable DoD does not bind anyone.** They also judged the JS-motion arm to make
this the *stronger* guard, not a weaker substitute — a CSS reset provably cannot reach
`requestAnimationFrame` / `.animate()` / motion libraries, so a CSS-only proof has a hole
exactly where the reset has no authority.

The three other stale-DoD corrections were accepted in the same message; on `setTimeout`
they noted banning it "would have broken the feeds."

**Line numbers in the approved plan text are stale and that is not a defect.**
`control-room.css` and `responsive.css` were both written 18:34Z, minutes before review.
The reset import moved `:9 -> :11` (two imports inserted under the plan) and the
`@media` block moved `:155 -> :152`. The guard pins nothing by line number — `IMPORT_ROOT`
/ `GLOBAL_RESET` are path constants and the import is asserted by content — so nothing
delivered depends on a stale number. Recorded for QA in
`comment-33c9919dfa824cf0a4783a148176942a`.

## Gap that was real, and how it was proved

`a11y/ui-wide-core-fixtures.tsx` builds the board with `cards={[]}`, so the shared
15-surface sweep never renders a card overlay. Mutation drill: blanking the `CARD_FACTS`
`"SUSPECT"` label leaves the fixture arm **green** and reddens only the dedicated
`BoardSurface` render added here. That dedicated arm IS the DoD 3 deliverable.

## Reusable patterns from this task

- `politeness(el)` returns `POLITE` / `ASSERTIVE` / `NO_LIVE_REGION` instead of a boolean,
  so a failure says *how* it stopped being polite. Stricter than `auditLiveRegions` in
  `surface-audit.ts`, which accepts `alert`/`assertive`.
- Colour-independence predicate reads `cr.label` and `cr.value` **separately** per
  `cr.fact.*`; the wrapper's own `textContent` would hide a blanked label behind siblings.
- Accessible names must resolve `<label for>` / `aria-labelledby`, not just `aria-label` —
  otherwise `cr.board.filter.terminated` and `cr.board.columnjump` read as violations.
- An element rendering nothing at all (`cr.board.joinstrip` with no joins) cannot be a
  colour-only violation; exempt it explicitly or the guard reddens correct code.

See `mem:gotcha-guard-premise-detaches-while-green`,
`mem:gotcha-vitest-config-package-json-drops-jsdom`.
