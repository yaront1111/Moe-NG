# Gotcha: a worker cannot record a plan-reserved file split with amend_plan_step

`moe.amend_plan_step` fails for workers:

```
MCP error -32003: [NOT_ALLOWED] amend_plan_step not allowed: architect or governor role required
(worker worker-XXXX is not on an architect or governor team)
```

Seen 2026-08-07 on task-84e875f9 (anti-blocking admission), whose approved plan explicitly said
"Target <=250, split before 400 (likely split: admission-records.ts **via amendment**)" and whose
commit step said the pathspec covers the named files "plus **amendment-recorded** splits". The plan
author assumed the worker could amend. It cannot.

## What to do instead
1. Do the split anyway when the line rail requires it — a 560-line module violating the epic rail is
   worse than a pathspec that grew.
2. Record it in the `moe.complete_step` `note` for the step that created the files: name every new
   file, its line count, and *why* one file was impossible. `complete_step` notes are the audit
   trail QA reads.
3. Restate the full corrected pathspec in the final `complete_task` summary AND in #general, because
   QA will diff the commit's `git show --stat` against the plan's literal path list and see more
   paths than the plan named.
4. Do not try to keep the plan's file count by cramming — that trades a documented deviation for an
   undocumented rail breach.

## Related trap: shared test fixtures need a non-test module
Importing helper functions from one `*.test.ts` into another re-registers the exporting file's
`describe` blocks inside the importing file, so every shared test runs twice. If two test files need
the same fixtures, add a plain `.ts` fixture module (packages/scheduler/src/test-fixtures.ts is the
landed precedent — DEVELOPMENT_ONLY header, `dev-` prefixed identifiers). That is a legitimate extra
file, not scope creep, and belongs in the same split record.
