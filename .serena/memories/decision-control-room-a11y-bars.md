# The control-room "bars" are behavioral, not millisecond budgets

Reusable ruling for anyone planning, building, or reviewing control-room
acceptance work. Established 2026-08-09 while planning
`task-ab8c9489ab6446c384e977a3e1cc8063`; confirmed with the human.

## The ruling

The pinned UI spec
(`D:/projexts/moes/docs/plans/2026-08-05-moe-v1-control-room-spec.md`,
sha256 `c55af8a9fc7386e6492fd57e34a4b8321abaae4e4e08ff38703544b58b0bef1f`)
declares **no render or interaction millisecond budget**. Its complete set of
UI-side timing contracts is exactly three:

| Where | Contract |
|---|---|
| §8.6 | lag banner escalates when stalled > 30 s |
| §11.3 | graph spinner ≤ 1 s, then skeleton nodes |
| §11.4 | pending immediately; > 2 s renders "still working" |

§11.4 also states outright that the 500 ms p95 is **the charter's** target and
"the UI renders honestly, **asserting nothing**". So the one number the spec
names is explicitly not a UI assertion.

Therefore, whenever a DoD says "specified render/interaction bars pass", it
means §12's **global bars**, not wall-clock:

1. J1 ≤ 3 human actions
2. one fan-out proposal ≤ 1 approval
3. every `cr.fact.*` element has a `cr.chip.*` descendant
4. every enabled `cr.action.*` originates from `nextAllowedCommands`

plus the scenario bars `CR-A11Y-001` (five truth classes distinguishable by
glyph + label + border alone, under forced monochrome) and `CR-A11Y-002` (J1's
three actions completed keyboard-only, including `h`/`l` column traversal).

## Why this matters

Two failure modes it prevents:

- **Invented numbers.** Any millisecond threshold asserted in a control-room
  test was made up by us, and §11.4 forbids the UI asserting even the one
  number the spec does name.
- **Flake on the reference environment.** jsdom elapsed time varies with
  machine load, so wall-clock assertions go intermittently red without any
  code change — which trains everyone to ignore the suite.

Behavioral thresholds (>2 s, >30 s) are still legitimate, but they are driven
by an **injected clock**, never by real waiting in a test.

## Corollary — bar 2 is currently not-applicable

The graph projection renders `GraphPlaceholder` in this slice and `CR-J1-002`
requires `cr.graph.*` never mount. Bar 2 concerns expansion approval on the
graph, so it has zero cases today. Record it as an explicit not-applicable with
that reason. Asserting it over zero cases is exactly the vacuous-sweep defect
project rail 1 names — a sweep that silently produces no cases passes while
testing nothing.

Related: `mem:task-task-ab8c9489ab6446c384e977a3e1cc8063-handoff`
