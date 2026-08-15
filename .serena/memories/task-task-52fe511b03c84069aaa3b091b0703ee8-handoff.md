# Scheduler validator decomposition handoff

- Live Moe lookup on 2026-08-08 shows task `task-52fe511b03c84069aaa3b091b0703ee8` is already `DONE`, despite the session's stale injected PLANNING snapshot.
- The approved implementation was committed as `4840573` and QA-approved after the exact focused gate passed (16 files / 120 tests).
- Public `validateGraphSnapshot` remains in `packages/scheduler/src/validate-graph.ts`; parsing moved to `validate-graph-input.ts` and graph-wide topology to `validate-graph-structure.ts`, with required one-line `.js` bridges.
- Current physical sizes observed: facade 80 lines, input 331 lines, structure 241 lines, validator test 467 lines. The completed task's DoD cap was <350 production, so it passed; the newer user preference of <=250 for both production and tests would require separately scoped follow-up refactors, not reopening or resubmitting this completed task.
- The authoritative design hash was reverified as `1D9D1EC97D3F07247FBBC088045E0BA2FD6DA8307F10A9026C55106419383191`.
- Foreign shared-tree work exists outside the validator paths; preserve it and stage only explicit owned files.

Do not call `moe.submit_plan` for this task unless a human/governor explicitly reopens it. Live Moe state is authoritative over the stale wrapper context.