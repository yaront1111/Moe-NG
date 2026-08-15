# `moe.report_blocked` on an ALREADY-BLOCKED task silently keeps the OLD reason

Calling `moe.report_blocked` against a task whose status is already `BLOCKED`
returns `success: true`, `taskStatus: "BLOCKED"`, and even notifies
`@governors` — but it does **not** replace `blockedReason`. The field stays
frozen at whatever the first blocker wrote. Nothing in the response says so.

Verified 2026-08-09 on `task-49acb856ec064b2ea528450d15744ee9`: a fresh
re-verification narrowed the blocker set from three paths to one, the call
reported success, and `.moe/tasks/<id>.json` still held the original 3-blocker
text verbatim.

```
python -c "import json;print('RE-VERIFIED' in (json.load(open('.moe/tasks/<id>.json')).get('blockedReason') or ''))"
# False
```

## Why this bites

A blocked task can sit for hours while other agents land the very files that
blocked it. The board then shows a stale blocker list, and the next reader —
QA, a governor, the successor worker — re-attributes red to paths that are
already clean, or worse, "fixes" a foreign file that no longer needs it. The
staleness is invisible: the reason text carries a timestamp only if the first
author happened to put one there.

## What to do

Post the re-verification as `moe.add_comment` on the task, and open it with a
line saying the `blockedReason` field above is stale and frozen. Comments are
additive and timestamped, and `moe.get_context` surfaces the recent ones.

Do not try to refresh the reason by bouncing the status
(`set_task_status` WORKING then BLOCKED again) — that manufactures a fake
transition in the task history for a cosmetic field update.

Note the reason field is separately capped: **2000 chars**, enforced as
`[INVALID_INPUT] Invalid reason: too long`. Comments have far more room, which
is another argument for putting the detail there.

Related: `mem:gotcha-step-note-counts-go-stale-after-a-later-step`,
`mem:gotcha-qa-summary-hard-capped-at-2000-chars`,
`mem:gotcha-sibling-task-liveness-before-blocking`.
