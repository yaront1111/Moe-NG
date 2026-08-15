# Blocked handoff: Claude runtime pin request hydrator

Task `task-75ee4a84bdd14d06b672abb18ed48cba` was measured and reported BLOCKED at committed HEAD `6ca5da07`; no bytes were written.

Hard dependency `task-32eddfd3c9644558b7218778e1f07e92` is still PLANNING and actively owned by `architect-09b5f32a`. All promised producer paths are absent:
- `packages/runner/src/providers/claude/claude-host-runtime.ts`
- `claude-host-runtime.js`
- `claude-host-runtime.test.ts`

Search found no production observer/factory/result API to consume. Only the existing injectable `ClaudeRuntimeFactsPort.observe` remains in `claude-runtime-pin.ts`; planning around it would violate the requirement that callers/tests cannot supply runtime authority.

Current task's three new request files are absent as expected, and existing `claude-surface.ts` / `index-surface.test.ts` were clean.

Exact unblock condition: prerequisite task reaches DONE; all three committed files exist; re-read and grep the actual factory/result/refusal symbols and signatures; confirm the current factory can compose them internally without publishing fs/facts/process/clock capabilities; only then plan `createClaudeRuntimePinRequest`. Do not invent the producer API from the dependency description.
