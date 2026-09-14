# Durable replan context implementation plan

**Goal:** A successor's design and planning seats receive complete, provenance-checked findings and historical implementation decisions, including successors created by the older UI.
**Architecture:** Keep goal creation and review authority unchanged. Resolve the UI's replan reference against the predecessor's approved graph, terminal review, exact PRD and decision order, then append explicitly advisory JSON context to the durable goal instructions. A recognized but unverifiable reference stops staffing with a stable code.
**Tech Stack:** TypeScript, SQLite decision ledger, Vitest, physical Node JS bridges.

### Context reader

Files: new `apps/daemon/src/planning/replan-context.ts`, `replan-context.js`, `replan-guidance-history.ts`, `replan-guidance-history.js`, and `replan-context.test.ts`; modify `apps/daemon/src/orchestrator/wrapper-mission-inputs.ts`.

1. Test the production compiler input callback using a real approved graph, three failed host-prepared reviews, committed REPLAN, and source-bound successor. Put a dependency explanation after character 600 and a ninth finding outside the UI projection. Assert both appear in the actual instructions.
2. From `apps/daemon`, run `pnpm exec vitest run --config package.json --maxWorkers=1 --testTimeout=30000 src/planning/replan-context.test.ts` and observe missing-context failures before implementation.
3. Resolve only the exact predecessor goal/node, same source digest and bytes, and a committed terminal REPLAN preceding successor creation. Validate any structured reference against that same join; recognize the previous UI's exact header for compatibility. Return complete latest findings with their decision and digest; throw `REPLAN_CONTEXT_UNAVAILABLE` on incomplete or conflicting evidence. Bound the complete JSON at 256 KiB; never truncate it.
4. Follow only the latest review's validated consumed continuation to historical human guidance. If the terminal review is a host verifier diagnostic, follow its exact source binding to the immediately preceding clean submission; never search older grants. Re-prove the decision digest and approved review package source. Label this as historical context that grants no retry, acceptance or criterion waiver; preserve the continuation ledger unchanged.
5. Test different PRDs, missing/unreplanned nodes, creation before REPLAN, mismatched pins and unchanged ordinary instructions. Run focused tests and typecheck.

### Integration and delivery

The parallel design-seat fix consumes the same callback. The UI prepares a source-bound successor before retiring a node and retains failed creation for explicit retry. Repository recovery separately proves terminal REPLAN, positive containment and an unchanged clean checkpoint before releasing its reservation.

Run `pnpm typecheck`, `pnpm test`, `pnpm verify:foundation`, `pnpm verify:store`, full daemon and Control Room suites. Review explicit owned diffs, commit only those paths, package Windows, verify source identity and the real packaged startup protocol. Apply supported recovery to UnAI only after fresh live identity and Git checks; preserve user commits and unrelated work.
