# task-ddb3bf77 Runs / Resources / circuit-breaker — QA APPROVED (qa-5be1a8d6)

## Verdict: APPROVED. Gate green outright, all 7 DoD items pass, 5 independent mutation drills red.

Supersedes the worker's session-4 handoff (kept below in spirit; QA re-measured everything
rather than trusting it, and every claim it made held).

## Gate, run twice by QA in the foreground

- `pnpm --filter @moe/control-room test` -> 40 files / 578 tests, EXIT=0
- post-drill re-run -> **41 files / 584 tests, EXIT=0**

The +1 file / +6 tests between runs is FOREIGN drift in the shared worktree. It did not
matter because `git status --porcelain -- src/runs src/resources src/shell` was EMPTY at
both runs, so owned bytes were identical. **No rail-3 disclosed-red completion was needed
or used** — the 15:48Z governor unblock authorised one, but the foreign TDD-red had
cleared. If a later reader expects a path-attribution note, that is why none exists.

## The five QA mutation drills (epic rail 6). All red. Reusable.

Method: `cp f f.bak`, `perl -0pi -e`, focused `pnpm exec vitest run <file>`, `cp f.bak f`,
`rm *.bak`. **No git commands** — see `mem:mutation-drills-in-shared-worktree` for why
touching git during a drill in this tree is how you lose the revert.

| drill | mutation | result |
|---|---|---|
| A | `isSuspect` also true when `activitySilence` endsWith "m" | 3 FAIL, incl. CR-J5-001 "NO warning and NO revoke affordance while ACTIVE" |
| B | `RUN_FACTS` activitysilence repointed at `renewalSilence` | 1 FAIL "keeps renewal silence and activity silence as two separate labeled facts" |
| C | resources queue `.sort()` by priority | 1 FAIL "renders waiters in the SUPPLIED order" |
| D | "Fan-out held." -> "Fanout held." | 1 FAIL "names the correlated check in the exact section 7.5 sentence" |
| E | Runs renders zero rows (`partition(rows)` -> `[]`) | 13 FAIL, landing ON `expect(result.checked).toBeGreaterThan(0)` at runs-surface.test.tsx:225/231 |

**Drill E is the one worth repeating on any future surface**: it proves the `checked > 0`
guard is load-bearing and not decorative. Note `auditLiveRegions` correctly did NOT fail —
it counts `cr.banner.*` from the lagging frame, not from the surface.

## Spec copy verified against the PINNED spec, not against the plan text

`sha256 D:/projexts/moes/docs/plans/2026-08-05-moe-v1-control-room-spec.md` ==
`C55AF8A9FC7386E6492FD57E34A4B8321ABAAE4E4E08FF38703544B58B0BEF1F`, matching the task
rail. Then: `:703` Runs empty, `:704` Resources empty, `:572` the 7.5 sentence, `:594` the
8.2 sentence — all four byte-exact against the constants. Grepping the spec beats reading
the planningNotes quotation, because the quotation is a copy that can drift.

## What the surfaces actually guarantee (verified, not restated)

- **No derived authority.** `runs-surface.tsx:27` reads `leaseState?.value` and nothing
  else. Zero clock, zero timestamp subtraction, zero comparator in all four owned
  production files. The two silence datums are separate fields with **no folding helper —
  the absence IS the guarantee**, which is why drill B needed a repoint to break it.
- **Queue order is the daemon's.** `priority` is a displayed fact, never a sort key; the
  fixture supplies P3 before P1 on purpose.
- **Banner fails closed** at `circuit-breaker-banner.tsx:64` on missing OR BLANK values —
  no sentence with UNKNOWN wedged into it.
- **Coexistence survived a foreign refactor.** `shell-chrome.tsx:88-91` renders `<Banners>`
  and `<CircuitBreakerBanner>` as siblings. It survived *detectably* only because
  `circuit-breaker-banner.test.tsx:136` mounts the real `<ShellFrame>` rather than the
  immediate parent — see `mem:gotcha-mount-the-composed-root-not-the-parent`.
- Per-file sizes (`grep -c ''`): 86 / 134 / 246 / 163 / 208 / 76 / 158. All under 250.

## Flagged, deliberately NOT rejected

`runs-contract.ts:49,:54` declare `RunsCommandHandler` and `onActivateCommand`, but
`RunsSurface` never destructures or forwards it — dead type surface. `ResourcesSurfaceProps`
declares no equivalent; Board's version IS wired. No DoD item and no rail covers command
activation on these surfaces (they render affordances; the decision lands in the Approvals
inbox), and no call site exists, so nothing silently fails in shipped behaviour.

Rejecting it would have been grading against my own suggestion instead of the written
requirement — exactly `mem:qa-grade-against-the-written-requirement-not-your-own-suggestion`.
**Whoever wires the CR-J5-002 journey must not assume that callback fires.**

## Residual disclosed by the worker, confirmed harmless

`loading===true` AND non-empty rows renders skeletons ABOVE real rows (runs :114/:118,
resources :145/:150). Cosmetic, no derived authority, no caller produces it.

## Downstream, needs an owner

`cr.runs` and `cr.resources` now EXIST, so **task-fdf3e6aa's DoD-5 "not applicable"
exemption for the section 4.16 table clause is STALE** — re-measure there, never inherit
(`mem:moe-scope-clauses-do-not-self-expire`). Structural half already discharged by the two
`TABLE_SURFACES` parity rows in `approvals/narrow-parity.test.tsx`, which is the one real
consumer edge importing both new surfaces. Pixel half stays with **task-bc0b8f5b** because
jsdom measures every box at 0.

## Traps for anyone extending these files (from the worker, all re-confirmed)

- `buildNextAllowedCommands` returns **EMPTY silently** for an unknown command kind.
  `session.quiesce` is NOT a RUNTIME_COMMAND_KIND. Use `lease.extend`, `resource.release`,
  `graph.release_preparation`, and guard fixtures with an explicit length assertion.
- `queryByRole("button")` is the WRONG instrument for "no action rendered" — every `Fact`
  renders its truth chip as a `<button>`. Scope to `[data-command-id]`.
- `auditLiveRegions` counts only `[data-testid^='cr.banner.']`; neither surface renders one,
  so mount inside a LAGGING frame. Never drop the `checked > 0` guard to make it pass.
- `pnpm --filter X test -- <pattern>` does NOT filter. Use `pnpm exec vitest run <path>`
  from the package directory.
