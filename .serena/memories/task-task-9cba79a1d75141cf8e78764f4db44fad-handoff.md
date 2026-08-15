# Daemon command registry extraction — QA APPROVED (2026-08-14)

Reviewed by qa-50f0d628 at HEAD d7a71cb. Approved.

## What shipped
- `apps/daemon/src/daemon-command-registry.ts` (247 lines) owns the whole
  command table: CAPABILITIES, the four family maps, `agentCapabilitiesFor`,
  20 ordered `PAYLOAD_KEYS`, `OPERATOR_CAPABILITIES`, request injection,
  `entryOf`, `buildCommandRegistry`, and the 422/409/503 + rethrow decision
  port. Public surface: `agentCapabilitiesFor`, `OPERATOR_CAPABILITIES`,
  `createDaemonCommandPorts({clock, projectId, store}) -> frozen {decisions, registry}`.
- `daemon-store-dependencies.ts` is now 187 lines (176 at submission; foreign
  commit 26d85c0 added the genesis-recovery binding on top). It re-exports
  `agentCapabilitiesFor` so `orchestrator/agent-wrapper.ts:6` never moved.
- Bridge bytes are `export * from "./daemon-command-registry.ts";\n` —
  DOUBLE quotes. The DoD asked for single quotes; that literal is void per
  human-approved prop-f0c3baf26d1c441c99f4f53018e53f65. The enforcing sweep in
  `runtime-entrypoint.test.ts` builds the expectation with double quotes, so a
  single-quoted bridge is RED. Do not "fix" it back.
- Consumer that adds `effect.activate` to this seam:
  `task-e33747f982e0452a9f9d784fd1cb914d`. Nothing else registers commands.

## QA gates re-run (not trusted from the note)
daemon typecheck 0; daemon test 68 files / 1230 tests 0; plain-Node
DEFAULT_PROVIDER_OK 0. Repo-wide `pnpm typecheck` is RED on
`packages/runner/src/index-surface.test.ts(532,36) TS2741 'launchSelection'
missing` — foreign uncommitted peer WIP in
`packages/runner/src/providers/claude/claude-launcher-authority.ts`, zero
intersection with the owned paths. Disclosed, not charged to this task.

## Drills that proved the suite bites
1. `WORK_FAMILY["work.claim"]` WORK -> ADMIN: 2 named cases red with exact
   expected/actual capability and agent array.
2. `PAYLOAD_KEYS["work.renew"]` reordered: red on the ordered allow-list case —
   the assertion is order-sensitive, not set-sensitive.
3. Bridge rewritten with single quotes: `runtime-entrypoint.test.ts` names
   `daemon-command-registry.ts` under `wrongContent`. This is the cheap way to
   prove a generic bridge sweep is not vacuous for YOUR new file — the sweep
   reports by name, so it says which module, not just a count.

## For the next reviewer of this area
- The registry test pins its swept case count three ways (`ROWS` length 20,
  `registry.size` 20, sorted key-set equality). Any new kind must update all
  three plus the hand-transcribed row, by design.
- Behaviour preservation was checked by diffing the moved regions against
  `1e8043f:daemon-store-dependencies.ts`. Only semantic delta:
  `projectId: config.projectId` became the destructured `projectId`.
- Commit split: foreign whole-tree `30458af` swept the two production files;
  `6adc800` carries the bridge + both test files. Review by
  `git diff 1e8043f..HEAD -- <five owned paths>`, never by commit membership.
