# task-a24cb925 handoff — Win32 Job primitive (first Rust in the monorepo)

Commit `ffa39d6`, 9 files, `packages/runner/src/platform/windows/native/`.
Gate: `cargo test --locked ... && cargo build --locked --release ...` exit 0,
7 sweep tests green.

## Public surface child 2 composes

`Win32Calls` (6 arms), `SystemWin32`, `NativeOp` (+ `NativeOp::ALL`),
`NativeError`, `RawHandle`, `OwnedHandle`, `Job`, `REQUIRED_LIMIT_FLAGS`.
Modules are PRIVATE with re-exports, so each item has exactly one public path.

## Two windows-sys 0.61.2 feature gates that will bite again

1. `CreateJobObjectW` is `#[cfg(feature = "Win32_Security")]` — its first
   parameter is `*const SECURITY_ATTRIBUTES`. `Win32_System_JobObjects` does
   NOT pull it in. Without the feature the function simply does not exist.
2. `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` is
   `#[cfg(feature = "Win32_System_Threading")]` because it embeds
   `Threading::IO_COUNTERS`. Task rail 5 forbade adding Threading (child 2
   owns it), so this crate configures the Job through the UNGATED
   `JOBOBJECT_BASIC_LIMIT_INFORMATION` / `JobObjectBasicLimitInformation` (=2).
   KILL_ON_JOB_CLOSE is a documented BASIC LimitFlag — only JOB_MEMORY and
   PROCESS_MEMORY are extended-only. Do not "fix" this back to EXTENDED unless
   you actually need IO counters; it is recorded in a Cargo.toml comment.

Verified constants: KILL_ON_JOB_CLOSE 8192 (0x2000), BREAKAWAY_OK 2048
(0x0800), SILENT_BREAKAWAY_OK 4096 (0x1000).

## Design points that are load-bearing, not stylistic

- Query-back uses EXACT EQUALITY (`observed != REQUIRED`). A bitwise-contains
  accepts a Job that also carries a breakaway bit — mutation drill (a) proves
  exactly one test catches this.
- Flag mismatch refuses with `op = QueryInformation, code = 0`. Code 0 means
  the refusal is OURS, not the OS's; there is no GetLastError to report and
  inventing one would be fabricated evidence.
- `OwnedHandle::close_once` sets `closed = true` BEFORE calling close. A failed
  close leaves an UNKNOWN outcome; retrying could close a handle Windows has
  already reused. `new()` and `raw()` are `pub(crate)` so an outside consumer
  cannot build a second owner over the same raw value.
- `RawHandle` deliberately has NO `Debug` impl, so a future `#[derive(Debug)]`
  on a struct holding one is a compile error rather than a handle leak.
- `NativeOp` is closed (no catch-all, not `#[non_exhaustive]`): child 2 adding
  a variant is a compile error at every match site, by design.
- A `Job` cannot exist unverified — `create` is the only constructor and
  returns `Err` unless the query-back matched.

## Known gap child 2 MUST close

The sweep injects a scripted call table, so **nothing executes `SystemWin32`**.
The NULL-name argument, JOBOBJECTINFOCLASS choices, struct sizes and
GetLastError mapping have ZERO behavioural coverage — mutation drill (c)
(non-NULL name) SURVIVED, 7/7 still green. Real-Windows tests were explicitly
out of scope here. Child 2's acceptance must drive
create -> configure -> query-back -> terminate -> close through `SystemWin32`,
not only process membership, or those decisions ship permanently unverified.

Compile-time `const _: () = assert!(REQUIRED_LIMIT_FLAGS == ...)` does cover
the flag constant; it cannot cover a wrong name, class or size.

`win32.rs` is at 246/250 lines. Child 2's new arms need a split by
responsibility, and that split will invalidate the "unsafe is confined to this
file" claim in its module doc — restate it crate-wide if you split.

See `mem:gotcha-untracked-crate-defeats-git-diff-drill-restore` for why the
drill restores were checksum-verified rather than `git diff`-verified.
