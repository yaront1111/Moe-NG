# Changing a `*_TRANSITIONS` table in packages/core reddens an unowned testkit manifest

Measured 2026-08-09 on `task-1df0622e87cf42beae2cd82280e9ff99`, which admitted `graph.supersede`
from `ACTIVE` in `GRAPH_REVISION_TRANSITIONS`.

## The coupling
`tests/property/schedule/schedule-coverage.test.ts` compares the LANDED reducer tables
(`GOAL_TRANSITIONS`, `GRAPH_REVISION_TRANSITIONS`, `PLANNING_RUN_TRANSITIONS`,
`PROJECT_TRANSITIONS`, imported from `packages/core/src/index.js`) against a HAND-AUTHORED manifest
in `packages/testkit/src/schedule/schedule-universe-tables.ts`. Two assertions fail the moment they
diverge:
- "keeps the authored tables in lockstep with every landed reducer" — the authored `EDGE` map lacks
  the new `<STATE>|<command>` pair.
- "classifies every empty landed table row as genesis or never-legal" — the command is still listed
  in `NEVER_LEGAL_COMMANDS`, but its landed row is no longer empty.

## Why it ambushes you
It lives in `tests/property/`, NOT in the package you are working in. `pnpm --filter @moe/core test`
is GREEN while repo-wide `pnpm test` is RED. If your task's verification command is package-scoped
(most are), you will only see it if you run the repo-wide leg — and the path-attribution rail
forbids excusing it as foreign, because the delta is yours.

## The sync
Three data edits, no logic:
1. add `<prefix>Verb: edge(AGGREGATE, "FROM", "command.kind", "TO")` to the `EDGE` object
   (`ALL_LANDED_EDGES` is just `Object.values(EDGE)`, and `CORE_TRANSITION_TABLES` derives from it);
2. remove the command from `NEVER_LEGAL_COMMANDS[aggregate]` if it was listed there;
3. delete any now-false comment (mine said "A revision reaches SUPERSEDED through authority loss,
   never through this table").
Verify with `pnpm exec vitest run --root . tests/property/schedule/`.

## Planning consequence
An architect sizing a task that touches a transition table should count this file. It pushed my task
from 10 owned paths to 11. It is genuinely mandatory rather than scope growth — see
`mem:moe-scope-clauses-do-not-self-expire` for why disclosing beats silently widening.
