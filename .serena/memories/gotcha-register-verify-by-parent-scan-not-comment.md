# QA: verify a slicing task by parentTaskId scan, never by the architect's comment

A SPIDR register/slicing task delivers **board state**, not code. Two habitual QA moves both
fail on it.

## 1. The pinned triage comment goes stale and stays on the record

On `task-963cf1d1` the architect posted `comment-f956cc9d`: *"9 created + 0 declined + 2
already-closed = 11"*, listing item 5 as already closed. The worker re-measured, found item
5 half-open, created a tenth task and re-reconciled to `10 + 0 + 1 = 11` — **in the plan step
notes**. The comment was never edited and still asserts the wrong count.

`moe.get_context` surfaces comments prominently; step notes live inside the task JSON. Read
BOTH, and grade the **latest** artifact. Approving off the comment would have blessed a
count that no longer matched the board; rejecting off it would have rejected correct work.

## 2. There is no children query — scan, don't trust the list

```
python -c "
import json,glob
for f in glob.glob('.moe/tasks/*.json'):
    t=json.load(open(f,encoding='utf-8'))
    if t.get('parentTaskId')=='<shell-id>': print(t['id'],t['status'],len(t['definitionOfDone']))"
```

A list copied from a comment can neither detect an **extra** child (scope creep) nor an
**orphan** (a created task whose parent was never set, invisible to the reconciliation). The
scan detects both. It is also what proved the tenth child existed.

## 3. What replaces "run the tests"

The task writes zero production bytes, so a repo suite measures peers' in-flight state, not
this task. Substitute:

- **Re-measure the evidence yourself.** Every `file:line` in the triage, on current bytes.
  Ten of eleven took one batched `sed -n`/`grep` call. Stale line numbers are expected in a
  shared worktree; a claim that no longer holds AT ALL is the reject.
- **Attribution, not emptiness**, for the diff-free claim: `git status --porcelain -- <the
  paths the register touched read-only>` must be empty. The whole-tree status will not be.
- **Zero-hit greps need a positive control.** "No task was created for the refuted item" is
  proven by `grep -ril aggregateDigest .moe/tasks/` returning only pre-existing DONE tasks —
  and by the identical grep for `localeCompare` returning 9 files, so the pattern reaches.

Related: `mem:task-task-963cf1d125134c6193b7af0e53deeac3-handoff`,
`mem:qa-positive-control-on-an-empty-grep`, `mem:qa-generated-table-cannot-police-its-own-generator`.
