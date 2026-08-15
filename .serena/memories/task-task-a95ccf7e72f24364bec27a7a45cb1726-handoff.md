# Handoff: task-a95ccf7e72f24364bec27a7a45cb1726 — Colour token layer for WCAG AA

## Status: COMPLETE, in REVIEW. Commit 14e9af9. All 8 steps done, all 6 DoD items discharged.

Supersedes the earlier BLOCKED handoff by worker-a0eaa020 — that block was correct at the
time and is now fully resolved. Do not act on its recommendations; its premise is closed.

## What shipped (2 NEW files, ZERO edits to anything existing)

- `apps/control-room/src/styles/truth-tone-tokens.ts` (75 lines) —
  `TRUTH_TONE_TOKENS: Record<TruthSemanticTone, TruthToneTokenPair>` mapping each prose
  tone to custom-property NAMES, never hex. Plus `TRUTH_TONE_COLOUR_SCHEMES`.
- `apps/control-room/src/styles/truth-tone-contrast.test.ts` (294 lines, 10 tests) —
  parses `tokens.css` + `surfaces.css`, proves each parse live, computes every ratio from
  the hex the stylesheets actually declare, light and dark.

Reason codes: `CR-CONTRAST-001` (tone with no resolvable token), `-002` (pair below AA,
carries the measured ratio), `-003` (typed map vs stylesheet disagree, BOTH directions).

## Three stale claims you will meet in the task text — all disconfirmed by measurement

1. **"Zero colour literals exist"** — false. `tokens.css:21-25` already had all five truth
   tones; `surfaces.css:20-38` already mapped every prose tone. The gap was never colour,
   it was that **nothing derived from it**.
2. **The 15:46Z governor "adopt the untracked styles/ directory" ruling** — closed.
   `styles/` is tracked (13 files) and clean, landed in 501030b. Nothing to adopt.
3. **"CR-A11Y-001"** — that code does not exist in the repo. `grep -rn` returns nothing.
   The real predicate is `auditTruthClassMonochrome` (`src/a11y/surface-audit.ts:187`),
   codes `TRUTH_CLASS_COUNT_MISMATCH` / `TRUTH_CLASS_MONOCHROME_COLLISION`. Its
   `monochromeTuple` (:163-166) is `[glyph, shortLabel, borderStyle]` — semanticTone is
   genuinely excluded, which is exactly why a colour layer cannot weaken it.

## DoD 6 is internally contradictory — resolved, not worked around

It forbids non-token stylesheet edits AND requires a reduced-motion block in every
token-carrying stylesheet. `tokens.css` has none, so satisfying the second breaks the
first. Resolved by governor-42b952c9's 18:37Z ratification: one global universal reset in
`responsive.css:152-160`, per-file blocks NOT required. `tokens.css` declares zero motion
anyway (`--cr-ease` is a value no rule there applies). See
`mem:decision-motion-gating-global-reset-not-per-file`. **Zero stylesheets were edited.**

## Verification

- `pnpm --filter @moe/control-room test` -> **46 files / 641 tests, exit 0**
  (baseline before I wrote a byte: 45/629 — the plan's 44/622 was already one sibling stale)
- `pnpm --filter @moe/control-room typecheck` -> exit 0
- `pnpm -r test` -> exit 0, zero failing packages repo-wide
- Four mutation drills all red-then-green: sixth tone breaks the BUILD
  (`TS2741 ... missing in type ... Record<TruthSemanticTone, TruthToneTokenPair>`);
  washed-out token gives `CR-CONTRAST-002` tone `green` ratio `1.1543551587184668`;
  rewired `[data-tone]` gives `CR-CONTRAST-003` for both `amber` and `ochre`;
  empty parse reddens 8/10 on liveness preconditions.

## Read before touching this area

- The certification function lives in the TEST file, by plan design. DoD 3 constrains the
  **values** to be production, not the computation. Drills 2 and 3 are what prove the
  assertions are attached to production bytes.
- `design-system.test.ts:63-71` still computes contrast over hex written in its own body.
  Deliberately left alone — it PINS the literals while the new test DERIVES from them, and
  `motion-inventory.test.ts:301-305` pins design-system's text. Editing it breaks that.
- The `CR-CONTRAST-001` / `-003` tests build fixtures from the REAL parsed token map, so
  corrupting a production token reddens them too. That is evidence of correct coupling,
  not a bug — do not "isolate" them.
- Commit 14e9af9 also carries 7 foreign `packages/core/src/planning` files from a shared-
  index race. Not a scope violation. See
  `mem:gotcha-shared-index-race-defeats-pathspec-commit`.
