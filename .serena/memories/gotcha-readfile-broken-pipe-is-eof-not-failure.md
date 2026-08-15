# On Windows a closed pipe peer is an ERROR, not a zero-byte read

Found 2026-08-10 on task-55e2c4c8 writing the broker's first real `ByteChannel`.

## The trap

POSIX `read()` returns 0 at end of stream. Win32 does not. Once the writer closes its end,
`ReadFile` **FAILS** and `GetLastError()` is `ERROR_BROKEN_PIPE` (109). The write-side twin is
`ERROR_NO_DATA` (232): the reader has gone.

So the obvious implementation —

```rust
if ok == 0 { return Err(unsafe { GetLastError() }); }
Ok(taken as usize)
```

— reports an ordinary parent disconnect as a channel FAILURE, and `Ok(0)` becomes unreachable.

## Why it is worse than an ordinary bug

Every protocol whose "channel ended" branch keys on a zero-length read becomes **unreachable in
production while every test still reaches it**, because a scripted test double returns `Ok(0)`
naturally. The suite proves the branch works; the shipped binary can never enter it. That asymmetry
is invisible to coverage and to code review.

In the broker this would have made "fd0 reached end of stream" — one of five required termination
paths — dead code in the only build that matters.

## Fix

```rust
if ok == 0 {
    let code = unsafe { GetLastError() };
    if code == ERROR_BROKEN_PIPE { return Ok(0); }   // the peer closed: end of stream
    return Err(code);
}
```

## The generalisable rule

When a seam has a distinguished "ended" value, check that the REAL implementation can actually
produce it. A test double producing it proves nothing about the boundary. Ask: what does the OS
literally return here, and which of my branches does that reach?

Same family as `mem:gotcha-file-type-pipe-is-3-not-2` — a Win32 constant/return convention that
looks obviously right and silently disables a whole path.

Related: `mem:gotcha-windows-sys-gates-a-function-on-a-foreign-feature`,
`mem:task-task-55e2c4c836894a788b7a30960e4fdb1f-handoff`.
