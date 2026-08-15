# Foundation Preview journey spec — transcribed BY HAND from the pinned design

Source (read-only, epic rail 1):
`D:/projexts/moes/docs/plans/2026-08-05-moe-rebuild-design.md`
SHA-256 `1D9D1EC97D3F07247FBBC088045E0BA2FD6DA8307F10A9026C55106419383191`

Transcribed 2026-08-08 by `worker-e46fb0dc` on `task-97554aa4` step 1, BEFORE reading any
implementation, so the canary asserts the design's claim and not the system's behaviour.
If you regenerate this list from the code you have destroyed its only value
(`mem:gotcha-self-derived-universe-cannot-check-itself`).

## J1 — small Tuesday bug (design line 1095, verbatim)

> **J1 - small Tuesday bug.** After the one-time project bootstrap journey, one causal bug
> remains one worker node. Per-goal happy-path human actions are exactly: (1) `goal.create`,
> (2) exact plan/initial-graph approval, and (3) final acceptance of the verified/reviewed
> result. Graph canvas is unnecessary. The UI shows exact diff/receipts and total
> control-plane overhead.

Assertions:
- J1-A one causal bug produces EXACTLY ONE execution-bearing (worker) node.
- J1-B per-goal happy-path human actions number EXACTLY 3 — not >=3, not <=3.
- J1-C the ordered kinds are exactly `["goal.create", "plan.approve", "result.accept"]`
  (set equality AND order; names are design concepts — bind to the real command ids at
  implementation time and record the binding).
- J1-D no graph canvas is required to complete the journey.
- J1-E the run surfaces exact diff AND receipts.
- J1-F total control-plane overhead is reported as a number.

## J3 — crash recovery (design line 1099, verbatim)

> **J3 - crash recovery.** Kill agent/runner/daemon at declared boundaries. Restart shows
> adopted, suspect, quarantined, and reconciliation records with truth chips. Healthy
> continuation is one safe action or an already-approved policy action; it creates a
> traceable continuation/binding, not edited history.

Assertions:
- J3-A kill targets, set equality: `{agent, runner, daemon}` — all three, real termination,
  at DECLARED boundaries.
- J3-B after each restart the record kinds present are drawn from and cover the set
  `{adopted, suspect, quarantined, reconciliation}`; assert by SET EQUALITY so an
  unexpected recovery outcome fails rather than passing unnoticed.
- J3-C every such record carries a truth chip (truth/provenance), never bare state.
- J3-D healthy continuation is ONE safe action, or one already-approved policy action.
  Exactly one — two actions is a failure.
- J3-E continuation creates a traceable continuation/binding record.
- J3-F history is NOT edited: pre-crash records compared BYTE-FOR-BYTE after recovery.

## J4 — rejection and re-plan (design line 1101, verbatim)

> **J4 - rejection and re-plan.** Findings link evidence to required changes. Delta approval
> shows changed hashes and invalidated/carry-forward nodes. Three-round counter is visible
> and escalation is explicit. Old plans, attempts, receipts, and reviews remain readable.

Assertions:
- J4-A every finding links evidence to a required change; a finding with no evidence link
  FAILS.
- J4-B delta approval shows changed hashes.
- J4-C delta approval classifies each node as invalidated or carry-forward.
- J4-D the three-round counter is VISIBLE (readable value, not inferred).
- J4-E escalation is EXPLICIT and tested AT THE BOUNDARY: round 2 does NOT escalate,
  round 3 DOES.
- J4-F after re-plan the old plans, attempts, receipts and reviews remain READABLE and
  BYTE-IDENTICAL — not merely "a new plan exists".

## Supporting normative text (design line 1087) for J4 routing

> implementation-only rejection routes `WORK_REVIEW -> EXECUTION_READY`; plan/requirements/
> dependency rejection holds the old `WORK_REVIEW` run and opens a separate successor draft
> in the Plan column. Approval/supersession, not a backward phase mutation, creates the next
> executable run. A human acceptance decline must choose a typed category; it cannot use
> ambiguous "back to planning."

## Exit condition (design line 1324, verbatim)

> Exit: Foundation Preview passes J1, J3, J4 and hostile-client/release-handoff incident
> fixtures on Windows+Claude. It is explicitly not yet the graph/fan-out or "best tool"
> release.

So the exit set is exactly: `{J1, J3, J4, hostile-client, release-handoff}` on
Windows + Claude-pinned runtime. J2, J5, J6 are explicitly NOT in Foundation Preview
(they are Phase 5 / Phase 6 — see design lines 1097, 1103, 1105, 1330, 1336).

## release-handoff, the only other design anchor (line 337, verbatim)

> `LEASED` or `LAUNCH_REQUESTED -> FAILED | CANCELLED | SUPERSEDED | RELEASED | UNKNOWN`
> when launch cannot or should not proceed **and every effect/resource is proven absent or
> released**; `RELEASED` additionally requires a committed safe-release handoff;

So the release-handoff incident asserts: an attempt released mid-flight reaches `RELEASED`
ONLY with a committed safe-release handoff and every effect/resource proven absent or
released; otherwise the honest outcome is `UNKNOWN`, never a silent `RELEASED`.

## What the design does NOT say (do not invent it)

The design does not enumerate hostile-client cases. The hostile sweep is bounded by this
task's own deliverable text: oversized bodies, malformed envelopes, replayed commands,
stale cursors, forged/absent authentication, and free-form session/terminal text attempting
a state change. Each refused with its stable code AT THE BOUNDARY, and NONE producing a
durable mutation — proven by reading the store back, not by trusting the response.
