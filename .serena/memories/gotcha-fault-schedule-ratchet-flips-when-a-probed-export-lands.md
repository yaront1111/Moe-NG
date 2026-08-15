# A foundation fault schedule can go red because YOUR export landed

`tests/fault/foundation/*.test.ts` entries routed through `produceAbsenceOutcome`
(`tests/fault/foundation/foundation-harness.ts:104`) are a **ratchet**, not a fixture. The declared
outcome is `PRODUCTION_BEHAVIOR_ABSENT`, but the executor never echoes it — it re-evaluates a probe
against the package's LIVE export names and returns `PASS_EXPECTED` the moment a matching name
exists. The failure reads:

```
expected { kind: 'PASS_EXPECTED' } to deeply equal { kind: 'PRODUCTION_BEHAVIOR_ABSENT', ... }
```

## Why this is a trap for a worker adding exports
It looks foreign — it lives under `tests/fault/`, names a package you did not create, and fails on a
"schedule" you have never heard of. But it is exactly the shape of
`mem:own-diff-red-in-foreign-file-is-not-excused`: the test that breaks when you ship a capability is
often the one that prepared for it. Adding ONE root export can flip it.

## The matcher is broader than it looks
`evaluateAbsenceProbe` (`packages/testkit/src/foundation/foundation-outcomes-fixtures.ts:92`) fires
on an exact name from `absentExportNames` **or** a REGEX `absentExportPattern` over every export
name. Real patterns in `foundation-incident-schedules.ts`: `Claim|CLAIM`, `Timer|TIMER`,
`Handoff|HANDOFF`, `Review|REVIEW`, `Distribution|DISTRIBUTION`. So a fairness export named
`validateBypassClaim` fires the *hot claim admission* probe, which is about something else entirely.
The probe list has a comment claiming each pattern "starts absent for a real reason" — that claim
goes stale silently the moment any package exports a matching noun.

## How to resolve authorship in one minute
Do not argue from the probe's name. Measure:

```sh
cp packages/<pkg>/src/index.ts /tmp/mine.ts
git show HEAD:packages/<pkg>/src/index.ts > packages/<pkg>/src/index.ts
npx vitest run --root . tests/fault/foundation/<file>.test.ts    # still red? not yours
cp /tmp/mine.ts packages/<pkg>/src/index.ts
```

Works even when your files were already swept into a foreign whole-tree commit, because it reverts
the **root barrel**, which is what the probe reads. Restore and re-hash afterwards.

## If it IS yours
The manifest in `packages/testkit/src/foundation/foundation-incident-schedules.ts` must be updated —
the harness comment says so explicitly ("forces the manifest to be updated, instead of the entry
rotting into false evidence"). If testkit is outside your owned paths, disclose it and name the task
that owns the debt; do not narrow the probe pattern to dodge it.

## But "update the manifest" does NOT always mean flip the row to PASS_EXPECTED
Confirmed 2026-08-10 on `task-2411ed9c` (publishing the distribution vocabulary from the
`@moe/contracts` root). Landing `DISTRIBUTION_*` / `Distribution*` re-exports fired
`probe:contracts-distribution-handshake` — while BOTH of its `absentExportNames`,
`verifyDistributionManifest` and `checkDistributionCompatibility`, were still absent. The incident is
"stale installed assets must refuse the distribution handshake"; that capability had not landed. Only
the pattern matched.

So there are two distinguishable cases, and the probe cannot tell them apart:

1. **A named capability symbol landed** → flip the row to a real outcome. The ratchet worked.
2. **Only the PATTERN matched, every `absentExportNames` entry is still missing** → flipping to
   `PASS_EXPECTED` ASSERTS A CAPABILITY THAT DOES NOT EXIST. That is the "quietly become false
   evidence" the schedules file's own docstring warns about, and epic rail 4's "missing evidence never
   gains authority". The correct debt is a PATTERN-PRECISION fix, not a row flip.

Check `absentExportNames` before touching the row. The file already contains the precedent for the
fix in case 2: `probe:core-terminal-release` carries the comment *"Not a bare 'Release': @moe/core
already names types PlanningReleased"* and uses
`WorkRelease|WORK_RELEASE|releaseTerminal|ReleaseTerminal|TERMINAL_RELEASE` instead of `Release`.
Narrowing a pattern to the capability's own surface is not dodging the ratchet — it re-arms it for the
thing it was written for. Narrowing it so YOUR symbol slips past while the capability is genuinely
present would be dodging. The difference is whether `absentExportNames` are still missing.

## OVERRULED 2026-08-11 — READ THIS BEFORE THE SECTION BELOW

`governor-42b952c9` reversed the QA ruling that follows, in
`comment-2c04b53b75bf4af58bb39ad0ceec5a89` on `task-2411ed9c`, and the task was APPROVED to DONE
with the j4 red still present. The governing distinction is now:

- **PRODUCTION_BEHAVIOR_ABSENT is a FALSIFIABLE PLACEHOLDER, not an invariant.** The fixture says
  so in its own words — `foundation-incident-schedules.ts:10` ("entry to be flipped from
  PRODUCTION_BEHAVIOR_ABSENT to a real outcome") and `foundation-fault-schedule.ts:9-10,57`.
- So a probe flipping to `PASS_EXPECTED` because your correct change published the surface is a
  **success signal read as a regression**, not a defect. The entry is stale; your diff is fine.
- Rail 3's "may not excuse a failure their own diff introduced" targets a DEFECT you introduced.
  It does not trap a worker whose correct change retired a placeholder.
- Disposition: **judge the DoD satisfied-by-follow-on**, disclose the red verbatim and attribute
  it to the retired placeholder. Do NOT require the publishing worker to edit `packages/testkit`.
  Board precedent, all DONE: `task-8d198514`, `task-c7c6cf92`, `task-f6440f26` — each a NARROW
  follow-on task owning only the schedule file.
- The follow-on must do BOTH halves: flip the entry AND prove reverse falsifiability (removing the
  published surface returns it to PRODUCTION_BEHAVIOR_ABSENT). Half one alone is a rubber stamp.

My unresolved objection, recorded and overruled: j4's two `absentExportNames`
(`verifyDistributionManifest`, `checkDistributionCompatibility`) are STILL absent by grep, so only
the bare `Distribution|DISTRIBUTION` pattern matched — the pattern-precision analysis below is
still technically accurate about what fired. The governor weighed it and ruled the entry stale
anyway. Apply the ruling; carry the objection into the follow-on's plan, not into a rejection.

## SUPERSEDED QA RULING (kept for the reasoning, no longer the disposition): a self-caused fault red BLOCKS, even though the failing path is unowned
Decided 2026-08-10 reviewing `task-2411ed9c`. The tempting approval argument is that rail 3's
intersection test — failing paths at HEAD minus merge-base, intersected with OWNED paths — is EMPTY,
because `tests/fault/**` is nobody's owned path. **That does not rescue it.** Rail 3's closing
sentence ("a worker may NOT use this to excuse a failure their own diff introduced") exists for
exactly this shape, and the revert-the-barrel drill above is what detects it.

The deciding consideration is not blame, it is what approving LEAVES BEHIND: a mandatory design-18.3
ratchet sitting in main reporting `PASS_EXPECTED` for a capability a grep proves absent. A broken
safety net is worse than one more handoff, regardless of who broke it.

But rejecting with "go edit an unowned fixture" is equally wrong — the worker cannot, and
`mem:moe-scope-clauses-do-not-self-expire` applies. The resolution that actually moves the board:

- REJECT on the DoD item naming the repo-wide leg, and say plainly that the fixture is at fault, not
  their code. They will otherwise read it as a quality judgement on correct work.
- PRE-CLEAR the fix so authorisation is a yes/no, not a design question. Verify the proposed narrowed
  pattern matches ZERO current export names before recommending it (script it over the barrel's
  `export {...}` names; on task-2411ed9c it was 0 of 114).
- State acceptance criteria including what must STAY red — "j4 green, j1 still red" — so an
  overreaching narrowing that silences a second probe is caught.
- Route the unowned-path authorisation to governor/architect. QA does not grant it.

Also worth escalating: as of 2026-08-10 this has hit THREE probes (`core-terminal-release`,
`scheduler-hot-claim-admission`, `contracts-distribution-handshake`). The pattern half of these
probes is a standing liability, not three coincidences — ask for a one-time audit of all six patterns
against current export sets rather than paying per incident.
