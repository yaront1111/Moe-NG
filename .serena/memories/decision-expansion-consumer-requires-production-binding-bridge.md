# Expansion daemon composition requires a production scheduler→core binding bridge

Measured on 2026-08-12 at HEAD `ff292f0`.

A pure admission package is not composable merely because scheduler and core shapes can be hand-mapped in a test. Before a daemon may treat scheduler admission as `DAEMON_VERIFIED` core evidence:

1. The scheduler must expose a verified fairness opportunity identity. Never synthesize `opportunityRef` from `workItemId`.
2. The scheduler admission identity (or a single non-duplicating canonical projection of it) must make every authority-relevant admitted byte load-bearing in core preparation. Do not silently drop graph epoch, lineage, capacity, bypass, or resource-intent facts.
3. The reducer-produced expansion hold must be paired with a daemon-current goal version through a total production binder; an unrelated hand-written `PlanningExpansionHoldBinding` is test-owned authority.
4. Dependency direction remains core ← scheduler ← daemon; core must not import scheduler. A scheduler-owned bridge may consume core public types because scheduler already declares `@moe/core`.
5. Only after the bridge lands may daemon persist the exact prepared/approved binding. That pre-activation record is useful production composition but is not child activation; it must expose zero run/lease/effect/slot/graph-activation authority.

This was the missing seam behind QA's rejection of the Expansion admission protocol shell. See `mem:task-task-005c9896f9724ece80b27f44789d0435-handoff`.