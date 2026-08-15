# A drill against an out-of-process harness HANGS rather than failing

A mutation drill has three outcomes, not two. Red proves the guard holds; green
proves it is dead; **hung proves nothing and costs the whole session.**

Observed 2026-08-11 on `task-e18b1284` (broker containment). The drill removed
`child.kill('SIGKILL')` from a Node harness to check the kill proof could redden.
The broker stayed alive, so Node stayed alive awaiting its exit, so the Rust
side's unbounded `Child::wait_with_output()` blocked. The run was killed at 600s
having produced no verdict.

**The trap is that a hang reads as "no failure".** With less patience it would
have been recorded as "the guard holds" — the drill would have certified a test
that was never exercised.

## The rule

Every wait in an out-of-process test needs a BOUND, and exceeding it must PANIC
BY NAME. Not just the assertions — the plumbing:

    fn await_harness(mut harness: Child, bound: Duration) -> Output {
        let deadline = Instant::now() + bound;
        loop {
            match harness.try_wait() {
                Ok(Some(_)) => return harness.wait_with_output().expect("..."),
                Ok(None) => {}
                Err(e) => panic!("the harness could not be waited on: {e}"),
            }
            if Instant::now() >= deadline {
                let _ = harness.kill();
                let _ = harness.wait();
                panic!("the harness never finished within {bound:?}, so X never happened");
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

After the bound, the same drill failed by name in 20.15s.

## Two corollaries

**A bound is also the proof the machinery is real.** The suite finished in ~0.15s
and looked too fast to be doing anything. The drill consuming the FULL 20s bound
is what established that Node, the broker, the provider and the grandchild were
all genuinely running — a timing argument no amount of reading could settle.

**No destructor survives a SIGKILL.** Killing the hung run externally meant the
`Drop` cleanup guard never ran, leaving a stale workspace directory. That is not
a leak defect — it is the one exit path a `Drop` guard structurally cannot cover.
Do not add machinery chasing it; check the directory is under an ignored tree.

Related: `mem:pattern-qa-verify-a-mutation-drill-instead-of-reading-it`,
`mem:gotcha-drill-harness-scores-unread-output-as-survived`,
`mem:mutation-drill-red-on-wrong-assertion`.
