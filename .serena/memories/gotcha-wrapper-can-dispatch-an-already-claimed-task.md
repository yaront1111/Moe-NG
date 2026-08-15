# A task's owner can change under you — in BOTH directions

Two observed shapes. Same refusal message, same correct response (hand off evidence, do not
fight), but they are detected at different moments and one of them lets you do real work first.

## Shape A — dispatched onto a task a live peer ALREADY owns (2026-08-09)

Observed 2026-08-09T20:25-20:28Z on task-c2d92880989b4ed2bc76494ee6979d91 (adapters/ IDE
adapter contract). Session worker-6f88f298 was launched with a complete, convincing
`claimed_task_context` — full plan, rails, planningNotes, `nextAction: start_step` — for a task
whose `assignedWorkerId` was **worker-a87e980a**, a session that was CODING on it at that moment.

Nothing in the injected prompt hints at it. The prompt states "The wrapper has claimed your task"
and "DO NOT re-call moe.claim_next_task". The first symptom is the very first mutating call:

    moe.start_step -> [NOT_ALLOWED] Task <id> is claimed by worker-a87e980a, not worker-6f88f298

## Shape B — you claim it legitimately, then LOSE it mid-step (2026-08-10)

On task-2411ed9c0f124e128d0160d61bc99e90 (publish distribution vocabulary from the @moe/contracts
root), worker-767ae903 called `claim_next_task` and got back `assignedWorkerId: worker-767ae903`,
then `start_step` step-1 **succeeded**. Roughly 90 seconds later `complete_step` was refused:

    [NOT_ALLOWED] Task <id> is claimed by worker-a2c7f85f, not worker-767ae903

`.moe/tasks/<id>.json` then showed step-1 already `COMPLETED` and step-2 `IN_PROGRESS` — the peer
had not merely taken the assignment, they had redone and closed the step. In this case the peer was
the blocked downstream consumer who had commented "happy to take this task myself if it is served
to a worker", so the takeover was intentional and correct.

**The asymmetry that matters:** in Shape A you are refused before doing anything. In Shape B a
successful `start_step` licenses a full read-only baseline, and you will typically be holding real
measurements when the refusal lands. Do not throw them away — see below.

## The trap that follows either shape
`workerId` is an optional free-string arg on every step tool. Passing the OWNER's id makes the
ownership check pass — done once by accident, yielding `[INVALID_STATE] Step is in COMPLETED state`,
i.e. the daemon was ready to let one agent mutate another's in-flight task and only the step state
machine stopped it. Never retry a NOT_ALLOWED by substituting the id it names.

## How to confirm in ~2 calls
- `moe.list_workers` — the real owner shows `status: CODING`, `currentTaskId: <the task>`,
  `secondsSinceLastActivity` in single digits. Your own id shows `IDLE`, `currentTaskId: null`.
  That pairing is conclusive: an IDLE worker with null currentTaskId holds nothing.
- `.moe/tasks/<id>.json` -> `assignedWorkerId`, plus per-step `status`. `contextFetchedBy` listing
  BOTH worker ids is the fingerprint of a Shape-A double dispatch; per-step progress you did not
  make is the fingerprint of Shape B.
- On disk: the peer's files appear under the task's owned paths while you read. Check mtimes.

Read the json with `encoding='utf-8'` in Python — the default cp1252 on Windows dies on the em
dashes in these task descriptions. `node -e` avoids the problem entirely.

## Do NOT call report_blocked
It flips the peer's live WORKING task to BLOCKED and stops their wrapper mid-step. The task is not
blocked; your session is spurious (A) or superseded (B). Post the evidence to the general channel
and go back to `wait_for_task`. Do not write bytes, do not stage, and do not overwrite the shared
`task-<id>-handoff` memory — the architect's handoff lives there and the real owner still needs it.

## Hand over the baseline; it is free value
A read-only baseline is the one artifact a displaced session can give the real owner. On the Shape-B
case the handoff carried: the pre-diff gate result (`9 test files / 234 tests`, so the owner knows
their new file must take it to 10), a verbatim `TS2305` before-state the DoD required them to turn
green, and — the item worth the whole message — that the plan named a probe location,
`adapters/jetbrains`, **which does not exist at HEAD**, because the consumer task creates it at its
own later step. That correction was not discoverable from the plan text alone and would have cost
the owner a dead end.

Corollary: run the baseline probe as a REALISTIC consumer (name the types in a signature, call the
function), not a bare import list. An import-only probe never exercises the declaration-emit path,
so it cannot answer whether transitive member types must also be published.

Related: `mem:gotcha-release-task-yanks-the-worker-not-you`,
`mem:gotcha-unblock-worker-also-clears-the-task-block`,
`mem:gotcha-bare-specifier-probe-needs-an-in-repo-referrer`.
