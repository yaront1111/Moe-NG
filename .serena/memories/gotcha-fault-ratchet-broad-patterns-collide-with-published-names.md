# The foundation fault-ratchet's broad probe patterns collide with legitimately published symbols

Measured 2026-08-11 while governing. `pnpm test:fault` was RED at HEAD:
2 files failed, 41/43 tests passed.

## The mechanism

`packages/testkit/src/foundation/foundation-incident-schedules.ts` (142 lines)
declares `FOUNDATION_INCIDENT_PROBES` — six probes, each pairing **required
capability symbols** with a deliberately **broad name pattern**. The broad
pattern exists so a probe cannot be gamed by a near-miss rename.

The file states its own invariant at lines 40-41: *"none of them matches an
already-exported runtime name, so every probe starts absent for a real reason
rather than because its pattern was chosen to miss."*

**That invariant is now false for three of six**, measured on package roots:

| probe | pattern | matches on root |
|---|---|---|
| contracts-distribution-handshake | `Distribution\|DISTRIBUTION` | **17** in contracts |
| scheduler-hot-claim-admission | `Claim\|CLAIM` | 2 in scheduler |
| core-release-handoff | `Handoff\|HANDOFF` | 1 (`ExpansionHandoffBinding`, core index.ts:221) |

Clean at time of measurement: `Review|REVIEW` 0, `Timer|TIMER` 0, and
`core-terminal-release` which already carries a hand-narrowed pattern **plus an
explanatory comment** — that is the shape to copy.

## Why it keeps costing unrelated tasks

The capabilities are genuinely ABSENT — `verifyDistributionManifest` and
`admitClaim` appear in exactly one file each, the probe file itself, as string
literals. So `PRODUCTION_BEHAVIOR_ABSENT` is the *correct* answer and the
ratchet is right to demand it. The probes are not wrong about the world; their
patterns catch unrelated published names.

A pattern like `Distribution|DISTRIBUTION` matches, by construction, every
symbol a task publishing distribution vocabulary is REQUIRED to export. So a
task lands correctly and turns a mandatory gate red **with no owned-path fix**:
it cannot rename its symbols (task rail, and root-namespace tests pin them) and
cannot flip the row to `PASS_EXPECTED` (that asserts a capability grep proves
absent — epic rail 4). `task-2411ed9c` hit exactly this and escalated for an
authorisation nobody was awake to grant.

**Third collision in the same file** (core-terminal-release,
scheduler-hot-claim-admission, now distribution). Expect a fourth in
core-handoff territory.

## If you hit this

Don't absorb it into your task. `task-40983c7c` (CRITICAL) now owns the repair —
narrow every pattern to a capability-specific alternation with a comment naming
the collision, and add a regression test that enumerates the probes against
current root exports so a re-broadening fails loudly.

**A pattern narrowed until it matches nothing is as broken as one that matches
everything — and worse, because it fails silently.** Any narrowing must still
catch a plausible near-miss rename of its own capability, and that must be
tested.
