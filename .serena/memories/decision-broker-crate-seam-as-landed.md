# moe-windows-job-broker: the seam 3a actually landed

Measured 2026-08-10 at HEAD, after task-05bf0e0f (3a) reached REVIEW 9/9.
PROVISIONAL until 3a is DONE — QA may still reject.

## Shape

The broker is a **lib + bin**, not just a bin. `broker/src/lib.rs` (51 lines)
declares the modules and re-exports; `main.rs` (85) is a thin entry point.
Siblings 3b/3c add modules hanging off lib.rs with `pub use` re-exports,
following the core's one-public-path convention.

```
broker/src/lib.rs            51   mod + pub use
broker/src/main.rs           85   thin entry
broker/src/boundary.rs       94   #[cfg(windows)] real impl: SystemHandles
broker/src/bin/handle_probe.rs 127 cooperating child for the absence proof
broker/src/verify.rs        157   HandleCalls trait + OwnedDescriptor/Descriptors
broker/src/descriptors.rs   222   pure block parsing  <-- only 28 lines headroom
broker/tests/descriptor_block.rs 401, handle_inheritance.rs 446,
broker/tests/node_loadability.rs 132   (tests exempt from the per-file cap)
```

Workspace wiring landed as planned: `[workspace] members = ["broker"]` added to
the EXISTING native/Cargo.toml above `[package]`. **No core file moved.**
Broker gate green: 8 + 1 + 1 = 10 tests, 0 failed.

## THE THING SIBLINGS MUST NOT GET WRONG

**A call-table seam already exists.** `pub trait HandleCalls` (verify.rs) with
RAII `OwnedDescriptor` / `Descriptors` generic over it, and real impl
`SystemHandles` (boundary.rs). It mirrors the core's `Win32Calls`/`SystemWin32`.
3b/3c must inject through THAT seam. A second call table in the same crate is
duplicated authority and reads as a rail violation.

**A closed refusal vocabulary already exists**: `DescriptorReason`. 3b's DoD
also demands closed control/status/refusal vocabularies. Decide deliberately
whether protocol reasons extend it or sit beside it composed into one error
type — if two enums can both mean "refused", a test asserting a reason code
stops pinning WHICH layer refused, which is the vacuous-assertion defect the
global rail names.

## Exported surface (do not restate)

`parse_descriptor_block`, `DescriptorError`, `DescriptorReason`,
`INVALID_HANDLE`, `REQUIRED_DESCRIPTOR_COUNT`, `acquire_from_block`,
`Descriptors`, `HandleCalls`, `OwnedDescriptor`, `PIPE_FILE_TYPE`, and
windows-only `acquire`, `startup_block`, `SystemHandles`.

## The trap is closed in code

```rust
pub const PIPE_FILE_TYPE: u32 = 3;              // verify.rs
const _: () = assert!(PIPE_FILE_TYPE == FILE_TYPE_PIPE);  // boundary.rs
```

A wrong value now fails the build rather than refusing every descriptor at
runtime. Reuse the constant; never write the literal. Background:
`mem:gotcha-win32-crt-lpreserved2-fd-passing-and-file-type-pipe`.

Recorded to 3b as `comment-f916fecb`; applies equally to 3c (task-55e2c4c8) and
3d (task-e18b1284).
