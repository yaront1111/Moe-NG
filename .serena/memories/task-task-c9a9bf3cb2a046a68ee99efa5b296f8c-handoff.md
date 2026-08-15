# task-c9a9bf3cb2a046a68ee99efa5b296f8c handoff

- Status: REVIEW after QA-reopen fix.
- Original MCP stdio implementation commit: `55ecf7e`.
- Reopen regression-test commit: `0734ea7` (`test(mcp): lock adapter-owned fields`). The reopen commit changes only `packages/mcp/src/stdio/stdio-server.test.ts`; production stdio bytes are unchanged.
- QA gap fixed: command and query dispatched envelopes are decoded and every adapter-owned field is asserted via `ADAPTER_SUPPLIED_COMMAND_FIELDS` / `ADAPTER_SUPPLIED_QUERY_FIELDS`, using hostile valid alternate kinds plus hostile schema version, credential, and command digest.
- Mutation proof: moving only `commandKind` before `...args` fails the new command test; moving only `queryKind` before `...args` fails the new query test. Both production mutations were restored before commit.
- Fresh exact gate: `pnpm --filter @moe/mcp typecheck && pnpm --filter @moe/mcp test` exited 0 with 2 files / 49 tests passed.
- Broad gate passed before commit with 81 files / 1066 passed, 1 skipped. A later post-commit broad rerun was transiently blocked by foreign untracked `packages/scheduler/src/dependencies/dependency-contract.test.ts` importing missing `./dependency-contract.js`; reported in #workers. Do not modify that scheduler work from this task.
- Adversarial checks: no `JSON.parse` of daemon bytes in stdio server, no SDK/stdio import in shared dispatch conformance, no scheduler source-boundary import, one bootstrap `process.env` read, no Date.now/Math.random, test file 364 lines and production max 272.