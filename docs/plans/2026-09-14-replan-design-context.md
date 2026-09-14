# Replan design context implementation plan

**Goal:** Give a design worker the durable instructions of its exact successor goal.
**Architecture:** Reuse the existing project-bound `compilerInstructions(goalId)` reader. Resolve a design aggregate to its bare goal once through a shared pure helper, and carry the returned text as advisory goal context in the design mission. Leave compiler composition and all submit authorities unchanged.
**Tech stack:** TypeScript, real SQLite event store, production daemon wrapper, Vitest.

## Owned files

- `apps/daemon/src/orchestrator/agent-mission-text.ts` and its existing test: shared design-goal resolution and optional instruction paragraph.
- `apps/daemon/src/orchestrator/agent-wrapper.ts`: route the exact bare goal to the existing reader.
- `apps/daemon/src/orchestrator/agent-wrapper-config.ts`: clarify that the reader serves design and compiler seats.
- `apps/daemon/src/orchestrator/agent-wrapper-design-context.test.ts`: real durable goal, Gate 1, offered design step, session and claim, captured worker mission.

## TDD steps

1. Create two source-bound goals through the existing bootstrap command pipeline, approve the shared contract through the production Gate 1 service, and staff the first real offered design step with `createAgentWrapper`. Assert its mission contains the first goal's complete instructions and no second-goal marker. Run the focused test and observe the missing-text failure before production edits.
2. Add a pure resolver for `design:<goalId>` that returns null for null, unprefixed, or empty aggregate ids. Add a sixth optional instruction argument to `designMission`; resolve it in the wrapper with `config.compilerInstructions?.(designGoalRef(step.aggregateId)) ?? null`. Keep the offered aggregate unchanged for submit.
3. Encode instruction text as a JSON string without truncation or normalization. Explain that findings guide correction and operator choices can resolve open implementation questions within the approved contract; they cannot waive criteria, checks, or approval. Preserve absent-context behavior and compiler text.
4. Assert exact multiline/marker-shaped text, valid and malformed design ids, exclusion of another goal's instructions, legacy null instruction results, and reader exceptions. A throwing reader must spawn nothing and close its session/release its claim through the existing cleanup path. Preserve only the exact public `REPLAN_CONTEXT_UNAVAILABLE` error; sanitize arbitrary errors as `AGENT_SETUP_FAILED:mission:UNEXPECTED_ERROR`. The root's separate reader change validates recognized replan provenance and throws on unavailable evidence. This task does not weaken that refusal or alter legacy null results.
5. From `apps/daemon`, run `pnpm exec vitest run --root . --config package.json src/orchestrator/agent-wrapper-design-context.test.ts src/orchestrator/agent-mission-text.test.ts src/orchestrator/wrapper-mission-inputs.test.ts src/orchestrator/agent-wrapper-main.test.ts src/orchestrator/agent-wrapper.test.ts`. From the repository root, run `pnpm --filter @moe/daemon typecheck`. Report exact results and owned hashes. The root agent coordinates required full repository gates and publication; this task performs no commit, package, activation, or live-store write.

## Observed verification

- Initial real-wrapper and pure-mission regressions failed on missing instruction text (2 expected failures, 51 existing tests passed).
- Error propagation regression failed on the sanitized generic code instead of the known replan refusal before the narrow mapping was added.
- Focused five-file suite passed 178 tests with exit 0; daemon typecheck exited 0.

## Scope boundary

This repair transports instructions already bound to the successor goal. Copying predecessor findings or consumed operator guidance into a new goal is a separate provenance-producing change owned by the root agent. No old review result grants the new design any execution or acceptance authority.
