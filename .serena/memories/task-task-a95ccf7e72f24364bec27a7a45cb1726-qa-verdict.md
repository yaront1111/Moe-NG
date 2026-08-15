# QA verdict on task-a95ccf7e (Colour token layer, WCAG AA certification) — APPROVED first pass

qa-5be1a8d6, 2026-08-09, verified at HEAD 8ae6a05. Full evidence in task comment.
Worker handoff `mem:task-task-a95ccf7e72f24364bec27a7a45cb1726-handoff` is accurate on
every claim I independently checked; left intact.

## Gates, QA-run, foreground
`pnpm --filter @moe/control-room test` -> **52 files / 666 tests, exit 0** (worker measured
46/641; six sibling files landed since — the file count ROSE, which is the cheap proof the
new file actually ran). Focused run without `--config`: 10 tests, `environment 430ms`.
`typecheck` exit 0. Both re-run AFTER my drills: still green, tree restored.

## Shipped
Commit 14e9af9, two NEW files, ZERO edits to anything existing.
`truth-tone-tokens.ts` 75 lines — `Record<TruthSemanticTone, TruthToneTokenPair>` mapping
each prose tone to custom-property NAMES, never hex. `truth-tone-contrast.test.ts` 294
lines / 10 tests — parses `tokens.css` + `surfaces.css` and measures real ratios.

## The four drills, and which DoD arm each one actually discharges

| # | mutation | red |
|---|----------|-----|
| 1 | `\| "drill-sixth-tone"` into `TruthSemanticTone` | `TS2741 ... missing in type ... Record<TruthSemanticTone, TruthToneTokenPair>` at truth-tone-tokens.ts(43,14) |
| 2 | `tokens.css --cr-truth-verified #176f5b -> #d8f5ec` | happy path :234 BOTH schemes, `CR-CONTRAST-002`, `ratio: 1.1543551587184668` |
| 3 | `surfaces.css [data-tone="amber"] -> "ochre"` | `CR-CONTRAST-003` for `amber` AND `ochre` — both drift directions |
| 4 | DELETE the amber `[data-tone]` rule | :211 `expected 4 to be 5` |

**Drill 2 is the one that matters.** It is the only observation separating "certifies
production values" from "test agrees with itself" — the exact defect this task existed to
fix in `design-system.test.ts:63-71`. Reading the test cannot settle it; mutating the
stylesheet can.

**Drill 4 exists because drill 3 cannot substitute for it.** A rewire preserves cardinality,
so it never exercises `checked === DECLARED_TONES.size`. See
`mem:gotcha-rewire-drill-cannot-prove-a-count-assertion`.

## Independent contrast computation (mine, not the worker's)
Own sRGB luminance impl, sanity-pinned `#000/#fff = 21.00` and `#767676/#fff = 4.542`:
neutral slate #5e6d74 5.3632 · amber #9a621b 5.0763 · green #176f5b 6.0671 ·
blue #3c65d4 5.2444 · high-contrast magenta #b33b8f 5.3314. All >= 4.5.
Chips are 0.58rem/700 (`surfaces.css:7-8`) => normal text, so 4.5 is the right bar and the
3:1 large-text allowance correctly never applies to any certified pair.

## Two things I declined to reject on
1. `certifyTruthToneContrast` lives in the TEST file. DoD 3 constrains the VALUES, not the
   computation's location, and plan step 4 directed it there. Drills 2-4 prove the wiring.
2. `checked` counts tones ITERATED, not ratios measured — it is 5 even over an empty map.
   Intent still enforced: the empty case produces 5x `CR-CONTRAST-003` and fails the
   whole-object equality. Verified by drill, not by reading.
Both are `mem:qa-grade-against-the-written-requirement-not-your-own-suggestion` cases.

## Non-issues I confirmed rather than assumed
- 14e9af9 also carries 7 foreign `packages/core/src/planning` files (task-93b0314e's
  in-flight bytes, shared-index race). Project rail 5: hook defect, never a rejection
  reason. Bytes intact and evolved normally since.
- DoD says "CR-A11Y-001". Zero hits repo-wide. Real predicate is `auditTruthClassMonochrome`
  (`a11y/surface-audit.ts:187`), codes `TRUTH_CLASS_COUNT_MISMATCH` /
  `TRUTH_CLASS_MONOCHROME_COLLISION`. Its `monochromeTuple` (:163-166) is
  `[glyph, shortLabel, borderStyle]` — semanticTone genuinely excluded, which is exactly
  why a colour layer cannot substitute for the other three channels.
- DoD 6's reduced-motion clause is self-contradictory; resolved by governor-42b952c9, and I
  confirmed the ratification ON DISK (`chan-ced99359...jsonl` contains the literal
  "Do not require a same-stylesheet @media block") plus the coverage chain
  `control-room.css:1 -> tokens.css`, `:11 -> responsive.css:152-160` universal `!important`
  reset. Did not take the worker's prose for it.

## Restore discipline
`mktemp -d` backup OUTSIDE the repo, anchor count asserted `== 1` before each mutation,
restore verified by content grep AND clean `git status` + `git diff HEAD` on every drilled
path. Drills 1 and 2 touch files this task does not own.

Related: `mem:qa-generated-table-cannot-police-its-own-generator` (the five tone names at
:220-222 are hand-written, which is what makes drill 1's test arm meaningful),
`mem:vitest-focused-run-config-path-doubles`.
