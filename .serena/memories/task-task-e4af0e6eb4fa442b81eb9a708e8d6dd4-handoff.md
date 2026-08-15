# task-e4af0e6e handoff — BLOCKED during planning

Task: Bind the orchestrator settings to the typed approval policy.

## Outcome
Reported BLOCKED via Moe; no implementation plan was submitted. The real settings load/use path is absent from `moe-next`, and inventing an exported decoder would violate the required real consumer edge.

## Fresh measurements
- At committed HEAD ddb4753:
  - `git grep -n -I -E 'approvalMode|speedModeDelayMs' HEAD -- apps packages scripts tools` => zero.
  - No production reader of `.moe/project.json` exists in this repo.
- `docs/REPOSITORY_HYGIENE.md:13-16` states the `.moe` producer is the external transitional daemon; line 34 classifies `.moe/project.json` as its durable settings.
- The actual implementation is in sibling repo `/mnt/d/projexts/moes/packages/moe-daemon/src/tools/submitPlan.ts`: reads `approvalMode` and defaults `speedModeDelayMs || 2000` at lines 105 and 436. `state/persistence.ts:87,113` also defaults missing values. That repo is outside epic rail 2 and its package has no `@moe/core` dependency.
- The only moe-next durable settings contract is different and closed: `packages/contracts/src/configuration/project-configuration-parser.ts` has exact `SETTINGS_KEYS` isolation/limits/network/orchestrationSource/policy/schemaVersions/selection and exact policy keys with no delay. Using it requires the explicitly out-of-scope contract change and still does not reach transitional auto-approval.
- `readWrapperKnobs(process.env)` is unrelated, has no approval vocabulary, and does not decide plan approval.
- Authoritative design line 46 says there are no global speed modes.
- `apps/daemon` already has the legal `@moe/core` manifest/lock edge and a bare-specifier compiled probe passed, but there is no settings-load/auto-approval consumer edge to attach to.

## Required prerequisite
Either:
1. migrate the transitional settings loader plus plan auto-approval scheduler into a permitted moe-next workspace package, with explicit `approvalMode` + required delay decoding and a real consumer; or
2. explicitly relocate/authorize the task in the sibling `moes` repo and provide a legal dependency boundary to `@moe/core`.

Then re-plan this task. Do not substitute a standalone exported decoder, mock-backed journey, a wrapper-env mapping, or edits to live `.moe` state.