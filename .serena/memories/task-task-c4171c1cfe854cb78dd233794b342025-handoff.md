# task-c4171c1cfe854cb78dd233794b342025 planning handoff (2026-08-15)

## Outcome
Reclaimed after the original bridge dependency became DONE, but reported BLOCKED again after re-reading the later prerequisite audit. No speculative plan was submitted.

## Current dependency truth
- `task-2d9696160e674f26a8d422c45829d80e` (scheduler admission-to-preparation bridge) is DONE.
- `task-2d37939dddde447bb98e53a2bd9e6c60` (sole current hold binding + target preservation) is landed/DONE.
- `task-e62e3828df234c66969a99b8223487f4` (durable current safe-release evidence) is BLOCKED on durable attempt dispatch.
- `task-738a12a816e8421a96edd84648565a38` (authenticated atomic full ACTIVE hold + exactly bound EXPANSION PlanningRun persistence) is BLOCKED on e62.
- This task is therefore blocked with `needsFrom=task-738a12a816e8421a96edd84648565a38`.

## Why planning now is invalid
The landed scheduler bridge is necessary but not sufficient. Until 738 lands, the daemon lacks a trusted durable current full-hold/PlanningRun pair. Any c417 plan would have to accept or seed caller/test-selected currentAuthority, recreate missing safe-release facts, or silently use the compact PlanningRun binding that lacks the full hold authority. All violate DoD 1 and the fail-closed rail.

## Resume gate
After 738 is DONE, independently remeasure:
1. durable full-hold writer and reader plus safe-release provenance;
2. exact binding between current goalVersion, ACTIVE hold, sealed EXPANSION PlanningRun, creation receipt, and version;
3. `bindExpansionAdmission` / `validateOpportunityAttestation` through the public `@moe/scheduler` root;
4. apps/daemon manifest, lock importer, and a deleted-after-use compiled bare-specifier probe.

Then plan strict durable reads -> inspect PlanningRun -> admit -> bind -> prepare -> manual approve -> one durable pre-activation record. Stop before child/run/lease/effect/graph activation authority.