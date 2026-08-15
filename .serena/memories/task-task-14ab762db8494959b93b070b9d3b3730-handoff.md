# Broker wire protocol as landed (SPIDR 3b) — for 3c and 3d

Commit f362fe5 + foreign-swept bytes. Gate: broker 48 tests (8+38+1+1), core 37.
Review by base-ref diff `git diff 0b1d7a7..HEAD -- .../native/broker/` (9 files,
+2258/-12) — four of my production files live inside foreign whole-tree commits
7879698 and d531406.

## The seam 3c should inject through

```rust
pub trait ByteChannel {                       // frames.rs — NEW, not HandleCalls
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize, u32>;
    fn write(&mut self, bytes: &[u8]) -> Result<usize, u32>;
}
read_frame(&mut C, ChannelKind) -> Result<RawFrame, ProtocolError>
write_frame(&mut C, ChannelKind, opcode: u8, payload: &[u8]) -> Result<(), _>
AcceptState::accept(&RawFrame)  -> Result<Accepted, ProtocolError>   // authority gate
Status::emit(&mut C)            -> Result<(), ProtocolError>          // fd1
Diagnostic::emit(&mut C)        -> Result<(), ProtocolError>          // fd2
```

`HandleCalls` has only `file_type`/`close_handle` — it CANNOT carry framing.
`ByteChannel` is a second, narrow seam and that was the architect's explicit
correction to `mem:decision-broker-crate-seam-as-landed`.

## Wire layout, frozen

`[version u8][opcode u8][declared len u32 LE][payload N]`, header 6 bytes.
Caps per channel, deliberately unequal: fd0 65536, fd1 4096, fd2 512.
Opcodes: Launch 1, Cancel 2 (fd0); Started 1, Completed 2, Refused 3 (fd1).
RefusalLayer wire: Descriptor 1, Protocol 2, Native 3 (1-based on purpose).

Payloads: Started `[pid u32][creation_time u64]`; Completed `[kind u8][value u32]`
(kind 1 = exited, value = exit code; kind 2 = unknown, value = UnknownExit wire
1..4); Refused `[layer u8][reason u16][code u32]`; Diagnostic `[note u8][detail u32]`.

## Module map and line counts

protocol 205, frames 223, payload 100, control 204, status 182, refusal 146,
diagnostics 95, lib 104. `payload` is crate-internal (no public surface).
main.rs and descriptors.rs UNTOUCHED — `git diff --stat` over every pre-existing
file in the crate and the core prints nothing.

## Decisions 3c inherits and must not undo

**UnknownOpcode is a CONTROL-stage reason, not framing.** The framing layer never
interprets the opcode byte at all. That is what lets one codec serve all three
channels, and it makes version-before-opcode structural (different modules)
rather than a statement ordering someone can reshuffle.

**STARTED drops the core `Identity.image`.** It is a full executable path and adds
nothing to identity; pid+creation_time is the PID-reuse-safe pair. Dropping it
also keeps `Started` Copy and size-assertable.

**COMPLETED can say "not knowable".** `Completed { Exited(u32), Unknown(UnknownExit) }`
imports the core's enum. A bare u32 would force 3c to INVENT an exit code for an
unknowable exit — a designed-in epic rail 4 violation. `unknown_wire` is an
exhaustive match with no `_`, so a new core variant fails to compile here.

**AcceptState holds nothing.** Copy, one three-valued private enum. It is not a
session. 3c's session composes it; do not grow this one.

**A refusal never advances the phase** — asserted, not commented. Otherwise a peer
re-arms the state machine with the frame that was just rejected.

## DoD 4 was satisfied by unconstructibility, not a call log

Disclosed to QA up front. `Accepted::Launch(LaunchRequest)` is the ONLY value that
can reach a process launch and `AcceptState::accept` is its only constructor, so
"no hostile frame reached authority" is proved by the absence of an `Ok`. An empty
core call log would have been vacuous here — nothing in this task can call the
core. **3c is different**: its session really does hold the calls, so the literal
call-log form is required there and is not vacuous.
