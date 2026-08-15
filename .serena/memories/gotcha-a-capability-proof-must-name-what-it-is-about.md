# A proof token that names no subject authorises the wrong question

Found by the mandated adversarial pass on task-af99cf14, 2026-08-09 — not by
any test, and the test suite was 36 green at the time.

## The pattern

`GetExitCodeProcess` returns `STILL_ACTIVE` (259) both for a running process
and for one that genuinely exited with 259. The fix is to make an exit code
unreadable without evidence of a prior wait that observed the process
signalled. Modelled in the type system:

```rust
pub struct SignalledProof(());              // private field -> unforgeable
pub enum Waited { Signalled(SignalledProof), TimedOut, Abandoned }
pub enum ExitStatus { Exited(ExitCode), Unknown(UnknownExit) }
```

That is airtight against FABRICATION and wide open to MISATTRIBUTION. The token
means "some process was observed to exit". A caller holding one for process A
can pass it when asking about process B, and the API hands back B's number. The
evidence is genuine; it is about somebody else.

## The fix, and why it needs its own reason code

```rust
pub struct SignalledProof(RawHandle);       // carries its subject
...
Some(Waited::Signalled(p)) if p.0 == contained.process_handle() => { /* query */ }
Some(Waited::Signalled(_)) => Ok(Unknown(UnknownExit::ProofFromAnotherProcess)),
```

A distinct reason, never folded into "not waited". Those are different facts: a
caller who cannot tell "no evidence" from "evidence about someone else" cannot
tell an un-run query from a cross-wired one.

## Generalisation

Whenever authority is carried by a capability token — a proof of wait, of
authentication, of lock acquisition, of validation — ask: **what is this
evidence ABOUT, and can it be presented for a different subject?** Unforgeable
and correctly-attributed are two properties, and the type system gives you the
first for free while saying nothing about the second.

Two review heuristics:
- A zero-sized proof type is a smell. Evidence with no payload has no subject.
- Mutation-drill the binding, not just the existence: delete the `if p.0 == ...`
  guard and confirm a test reddens. On this task that drill produced
  `left: Exited(ExitCode(7)) right: Unknown(ProofFromAnotherProcess)`.

Also from the same pass: a failing `assert_eq!` IS a panic message. Comparing
two executable paths with `assert_eq!` echoes both into the failure output. Use
`assert!` with a message that names neither, exactly as the crate refuses to
give `RawHandle` a `Debug` impl.
