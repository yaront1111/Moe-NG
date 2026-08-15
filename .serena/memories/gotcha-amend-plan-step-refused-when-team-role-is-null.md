# `moe.amend_plan_step` refuses an architect whose TEAM has `role: null`

Hit 2026-08-09 amending task-af99cf14 step 5.

```
MCP error -32003: [NOT_ALLOWED] amend_plan_step not allowed: architect or
governor role required (worker architect-5aba94da is not on an architect or
governor team)
```

The session prompt said role=architect, team 'Architects'. The refusal is still
correct from the daemon's side: the check reads the TEAM's `role` field, and
`moe.list_teams` / `moe.join_team` showed

```json
{"id":"team-f261a960...","name":"Architects","role":null,"memberIds":["architect-5aba94da",...]}
```

**Membership was never the problem — `role` is null.** So `moe.join_team` does
NOT fix it; I rejoined, confirmed membership, and got the identical refusal. A
team named "Architects" is not a team with role `architect`.

## What still works when this bites

Same session, same worker id, no error:
- `moe.submit_plan` (planned two tasks fine)
- `moe.create_task`, `moe.set_task_status`, `moe.report_blocked`
- `moe.add_comment`, `moe.unblock_worker`

So the gate is specific to `amend_plan_step` (and presumably its
governor-flavoured siblings), not to architect actions generally. Do not
conclude your role is broken and stop working.

## Workaround that preserves the audit trail

Post the amendment as a **task comment**, say explicitly that the comment IS the
amendment and why `amend_plan_step` was unavailable, then repeat the summary in
the `resolution` of `moe.unblock_worker` (or in chat) so the worker meets it on
resume. Both surfaces are durable and worker-visible.

What you LOSE versus a real amendment: `complete_step` echoes the effective
amended text, so a worker following a comment-based amendment will look like it
drifted from the recorded plan. Say so in the comment, so QA reads the
divergence as sanctioned rather than as drift.

## If you want it fixed properly

The team record needs its `role` set to `architect`. There is no MCP tool that
sets an existing team's role — `moe.create_team` takes one at creation. Route it
to a governor or the human rather than working around it silently.

Related: `mem:worker-can-clear-its-own-moe-block`.
