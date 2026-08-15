# A containment proof needs its detachment premise asserted separately

"Kill the owner, both processes die" is only evidence of CONTAINMENT if an
ordinary teardown would have MISSED the second one. If the grandchild dies
merely because its parent did, the test passes while measuring ordinary
parent-child cleanup and says nothing about the Job.

Nothing goes red when that premise breaks. The headline test keeps passing.

## The guard (task-e18b1284, broker/tests/containment.rs)

No broker and no Job at all: spawn the provider directly, terminate ONLY the
provider by identity, and require the grandchild to **survive**.

    terminate(&calls, parent);
    assert_eq!(await_death(&calls, parent, BOUND), Liveness::Gone);
    assert_eq!(liveness(&calls, grandchild), Liveness::Running,
        "the grandchild died with its parent, so it was never detached");

Same family as a positive control on an empty grep: it proves the interesting
assertion is not satisfiable by a degenerate setup.

## What "detached" has to mean for the proof to bite

Detached from every mechanism a naive teardown uses, and from exactly one it
cannot be:

    DETACHED_PROCESS          no console -> console control event misses it
    CREATE_NEW_PROCESS_GROUP  own group  -> group signal misses it
    CREATE_NO_WINDOW          no window  -> window message misses it
    Stdio::null() x3          no inherited handle ties it to the parent
    NOT CREATE_BREAKAWAY_FROM_JOB        -> still in the Job. THE EVIDENCE.

Setting breakaway would make it genuinely escape and prove a different, false
property. `REQUIRED_LIMIT_FLAGS` is `0x2000` (KILL_ON_JOB_CLOSE) with no
BREAKAWAY_OK, so the kernel refuses breakaway anyway — but say so, or the intent
is invisible.

`Stdio::null()` is LOAD-BEARING, not tidiness: a grandchild inheriting fd4/fd5
holds their write ends open, the provider drain never sees end of stream, and the
session stalls in a way that reads as a broker defect.

## And the identity discipline that goes with it

Prove death by `(pid, creation_time)`, never PID alone — Windows reuses PIDs, so
a PID-only check can report an unrelated LIVE process as the dead one. Prove the
creation-time half actually discriminates by asking about a live process twice,
once with the value perturbed one bit; if it is ignored, both answer Running.

Apply the same rule to CLEANUP: re-check creation time against the open handle
before terminating, or a recycled PID gets an unrelated process killed on a real
machine.

Related: `mem:qa-positive-control-on-an-empty-grep`,
`mem:guard-premise-detaches-while-green`,
`mem:gotcha-out-of-process-drill-hangs-instead-of-failing`.
