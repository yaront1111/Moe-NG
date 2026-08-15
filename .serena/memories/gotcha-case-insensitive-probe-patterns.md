# Gotcha: case-insensitive substring patterns collide with ordinary camelCase

Found at the verification gate of task-18c7921f (foundation absence probes), before commit.

## The trap
A "does this export exist yet" probe used `new RegExp(source, "iu")` so it would still fire
when the surface landed under an unguessed name. Under `/i`, ordinary camelCase collides:

| pattern | falsely matches | why |
|---|---|---|
| `/timer/i` | `historicalRuntimeResult`, `freshRuntimeResult` | `...Run` + `timeR` + `esult` |
| `/lease/i` | every `Release*` name (`PlanningReleased`) | `Re` + `lease` |
| `/review/i` | every `Preview*` name (`GraphPreviewResult`) | `P` + `review` |
| `/claim/i` | `Phase0FreezeAuthorizationClaim` | direct |

Each would turn an unrelated export into a "surface landed" signal and fire a FALSE red the
day such a name became a runtime export — in the exact mechanism that is supposed to be the
trustworthy one.

## Fix
1. Match **case-sensitively** (`"u"`, not `"iu"`) and write patterns as `Timer|TIMER`,
   `Lease|LEASE|Fence|FENCE`, `Review|REVIEW`, `[Aa]cknowledg|ACKNOWLEDG`. camelCase gives
   you a free word boundary that `\b` cannot: `Timer` does not match `RuntimeResult`
   (`timeR` has a lowercase `t`), and `Lease` does not match `Released`.
2. Even case-sensitively, check the pattern against names the TARGET package already uses.
   `Release|RELEASE` still matched the real `@moe/core` name `PlanningReleased`; narrowed to
   `WorkRelease|WORK_RELEASE|releaseTerminal|ReleaseTerminal|TERMINAL_RELEASE`.
3. Keep a **decoy regression test**: feed every probe a list of real camelCase names that a
   sloppy pattern would catch and assert `{ absent: true }`. That test is what caught #2.
4. Compare against `Object.keys(namespace)` — runtime values only. TypeScript type-only
   exports erase, so `AcceptanceClosureWitness` etc. never appear and cannot collide.
5. Assert that each pattern matches at least one of its own declared names. Don't assume the
   FIRST declared name matches — `fenceAuthority` does not match `Fence`.

## Third collision, 2026-08-10: `CamelCase|UPPER` has no defence against SCREAMING_SNAKE

Case sensitivity solved the camelCase half and the authors documented exactly that reasoning
in `foundation-outcomes-fixtures.ts:74-82`. It does nothing for the other half. A bare
`Distribution|DISTRIBUTION` looks narrow but `DISTRIBUTION` matches every
`DISTRIBUTION_<ANYTHING>` constant by prefix — so the day task-2411ed9c published
`DISTRIBUTION_MANIFEST_VERSION` and six siblings from the `@moe/contracts` root,
`probe:contracts-distribution-handshake` fired and `pnpm test:fault` went red, blaming a worker
whose landing was correct. That is the THIRD probe in this file to collide with a legitimate
landing (`core-terminal-release`, `scheduler-hot-claim-admission`, now this).

Still standing in the same hole and unfixed as of 2026-08-10: `Handoff|HANDOFF`, `Timer|TIMER`,
`Review|REVIEW`. Any of them reddens the moment someone publishes a `TIMER_*` or `REVIEW_*`
constant.

The file's own header (`foundation-incident-schedules.ts:38-41`) states the invariant this
violates — "none of them matches an already-exported runtime name". That header is the cheapest
authorship test available: if a probe matches a live export name, the fixture is wrong, not the
landing. Note the header does not self-enforce; nothing re-checks it, so it rotted twice without
anyone noticing until a worker got blamed.

## Narrowing is constrained in BOTH directions — the trap when you APPLY the fix

Point 5 above is the one that bites the person repairing the collision, so it is worth restating
concretely: `foundation-spec.test.ts:171` ("goes red on a pattern match even when the eventual
name is unknown") does
`absentExportNames.find((name) => pattern.test(name))` then `expect(named).toBeDefined()`, and
then feeds `` `${named}FromAnotherAuthor` `` back through `evaluateAbsenceProbe` expecting
`absent: false`. So a narrowed pattern must:

- match ZERO live exports of the target package (or it keeps firing), AND
- still match at least ONE of its own `absentExportNames` (or testkit's own suite goes red).

Overshoot fails the second and the repair looks like a fresh defect. For the distribution probe,
`verifyDistribution|checkDistributionCompatibility|DISTRIBUTION_HANDSHAKE|DistributionHandshake`
satisfies both. Also check `:153` (`["unrelatedExport"]` -> absent), `:160` (name-Set driven,
pattern-independent) and the `:185` decoys. The manifest digest pinned at `:199` is built from
`probeRef`, not the pattern, so a pattern edit is outside the digested identity.

## Rule
Any substring matcher over identifiers is a latent false positive. Write it case-sensitively,
test it against real names from the package it targets, and keep the decoys in the suite —
the collision is invisible until the colliding name becomes a runtime export.

See `mem:task-task-18c7921fb1f34a8cb1ed39509bf67a31-handoff`.
