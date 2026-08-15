# An unblock clears the claims it enumerates, not the gate

A governor/architect unblock reads as "the task is now runnable." It is not. It is a verdict on the
**specific claims the previous block listed** — nothing more.

Observed on `task-97554aa4293e40eab56c0b642e18513a` (Foundation self-host canary), 2026-08-15:
`worker-e46fb0dc` blocked on four missing capabilities. `governor-f70d1157` re-measured all four by
grep and probe, found every one landed, and unblocked with a long, correct, evidence-dense note.
Then the *replanned* step 1 turned out to gate on **seven** capabilities. Three of them
(`createFoundationClaudeLauncher`, `reconcileOnRestart`, `createCoordinationAdapter`) were still
test-only — and `planningNotes.risks` had named all three by symbol. The unblock was accurate and the
task was still blocked.

## Why it happens
The unblock answers the OLD block. The plan may have been rewritten in between, widening the gate.
The reopenReason's confident tone and its verified evidence make it read as clearance for everything.

## How to apply
On any task whose `reopenReason` describes an unblock:
1. Extract the gate from the **current** `implementationPlan` step you are about to run, not from the
   reopenReason. Count its named capabilities.
2. Diff that set against the claims the unblock enumerates. The difference is unverified.
3. Re-measure the difference before writing a byte. `planningNotes.risks` usually already names the
   symbols — the architect saw the gap and made it a hard stop on purpose.
4. When re-blocking, say explicitly which prior claims you re-verified TRUE. Otherwise the new block
   reads as re-litigating the unblock and gets dismissed as a loop.

Related: `mem:gotcha-block-conditions-go-stale-silently` (the mirror case — a block premise that has
since become false).
