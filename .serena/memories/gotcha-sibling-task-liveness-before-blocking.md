# Gotcha: prove the sibling task is ALIVE before you block on it

When a plan step opens with a DEPENDENCY GATE on another task's file
("gate: `git log --diff-filter=A -- <path>` non-empty OR Task X DONE; absent -> report_blocked"),
a failing gate alone is not the whole story. Blocking parks the task until a human or governor
intervenes, so the block report has to answer "is anyone actually going to satisfy this?".

## The three checks that make a block report defensible

```bash
# 1. the literal gate
git log --oneline --diff-filter=A -- <path>          # empty => not committed
git ls-files <dir>                                    # is the dir even tracked?

# 2. sibling status AND liveness (status alone lies — WORKING survives a dead session)
node -e "const d=require('./.moe/tasks/<taskId>.json');
  console.log(d.status, d.updatedAt, new Date().toISOString(),
    (d.implementationPlan||[]).map(s=>s.stepId+':'+s.status).join(' '))"

# 3. does the sibling really own a path inside YOUR directory?
node -e "const s=JSON.stringify(require('./.moe/tasks/<taskId>.json'));
  console.log([...new Set(s.match(/apps\/[a-z0-9\-\/\.]+/gi)||[])].join('\n'))"
```

`updatedAt` within seconds/minutes of now => the sibling is actively working and the block will
clear on its own. `updatedAt` hours stale with status WORKING => a dead session; say so, because
then the governor's fix is to reap the sibling, not to wait for it.

Note `.moe/tasks/*.json` has **no** `assignedTo`/`claimedBy`/`leaseExpiresAt` populated for a
working task (all `{}` / null) — `updatedAt` is the only liveness signal available.

## Always capture a fresh baseline in the block report

Run the plan's verification command even though you are blocking, and record the exit code +
summary line. The resume session (possibly days later, in a dirtier tree) can then tell its own
breakage apart from pre-existing breakage, and QA can see the blocker created no half-state.
State explicitly that zero files were created or edited.

## Also name the throughput alternative

If the coupling is weaker than the gate implies (e.g. "keep the sibling's slice mounted" +
a shared test suite, but **no import dependency**), say so and offer the amendment. A governor
can then trade the gate for parallelism knowingly. The genuine cost is usually TDD interleaving:
your red tests would fail the sibling's own verification gate while it is mid-flight.
