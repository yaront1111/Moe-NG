# Recover a blocked review and restart

Use the repaired Windows artifact while the original single-project runtime is
still running:

```powershell
& '<repaired-artifact>\moe.ps1' recover-review 'D:\path\to\project'
```

The command checks the existing project store, repository reservation, archived
review, and Git state. It then attaches to the original Windows Job, stops that
project runtime, and proves the Job is empty before resuming the same reservation.
It preserves the reservation owner, original baseline, index, and unfinished work.
Recovery does not accept the product or grant another review attempt.

After successful recovery, the same command starts the repaired runtime in the
foreground and prints its new Control Room address. Pair the browser using the
confirmation label in that terminal. Use this artifact's `moe.ps1 start` command
for subsequent starts.

If Windows returns `RUNTIME_REVIEW_DRAIN_ACCESS_DENIED`, run the recovery command
from a PowerShell window with the same privileges as the original runtime, usually
**Run as administrator**. Keep the original runtime alive until recovery attaches;
a dead process ID alone cannot prove that all of its work has stopped.

The command refuses an ambiguous project, a changed review or workspace, unknown
containment, and a runtime launched through the multi-project manager. It has no
force-unlock option. A refusal is printed as a stable reason code and does not
start another runtime. If shutdown succeeded but a later check refused recovery,
the reservation remains protected for investigation.

## What an extra review approval means

`ALLOW_MORE_ATTEMPTS` authorizes one additional submission against the exact
review that the operator approved. Normal budget admission, independent
verification, and acceptance checks still apply. A clean verified submission can
complete; a failed submission consumes that approval and requests a new decision.
Historical approvals lacking the required binding grant no new attempt.
