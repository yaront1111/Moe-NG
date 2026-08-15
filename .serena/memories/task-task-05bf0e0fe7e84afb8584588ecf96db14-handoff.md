# Broker package, CRT descriptor acquisition, non-inheritance proof — worker handoff

Landed by worker-01abf979, 2026-08-10. Commit 30f5509 (final refinements only — see
"foreign commits" below). Verification: `cargo test --locked ... -p moe-windows-job-broker`
+ matching locked release build, both exit 0; 10 tests, 0 ignored.

## Shape
`packages/runner/src/platform/windows/native/Cargo.toml` is now BOTH a package and a
workspace root (`[workspace] members = ["broker"]`). Zero core files moved. The broker is
at `native/broker/`:
- `src/descriptors.rs` (222) — closed refusal vocabulary + `parse_descriptor_block`. PURE:
  no windows-sys, no syscall, **no `unsafe`**, no panicking path.
- `src/verify.rs` (157) — `HandleCalls` seam, `OwnedDescriptor`, `Descriptors`,
  `acquire_from_block`.
- `src/boundary.rs` (94) — `SystemHandles`, `startup_block`, `acquire`. ALL `unsafe` lives
  here and nowhere else, mirroring the core's win32.rs.
- `src/lib.rs` (51), `src/main.rs` (76), `src/bin/handle_probe.rs` (127).

`src/lib.rs` was NOT in the plan. It is forced: integration tests under `tests/` cannot link
a binary-only crate. main.rs consumes the lib, so it is a real internal consumer edge.

`Cargo.lock` is an owned path, forced: adding a workspace member adds a `[[package]]` entry
and `--locked` fails until it is there. Refreshed with one `cargo metadata`, no version churn.

## The three facts that decide this crate
1. **FILE_TYPE_PIPE == 3, FILE_TYPE_CHAR == 2.** `PIPE_FILE_TYPE = 3` is declared in
   verify.rs and boundary.rs carries `const _: () = assert!(PIPE_FILE_TYPE == FILE_TYPE_PIPE)`
   so a disagreement fails the BUILD. Stronger than an import: it also catches reaching for
   `FILE_TYPE_CHAR` by name. A runtime test pins both plus `INVALID_HANDLE == -1`.
2. **Block layout, measured against real Node v24.16.0 with six pipes:** `u32` count, then
   `count` flag bytes, then `count` POINTER-sized handles = `4 + count * (1 + size_of::<usize>())`
   = 58 for count 6 on x64. All six answered `GetFileType == 3`.
3. **The core does NOT populate `lpReserved2`.** `system_process.rs:201-210` sets
   `STARTF_USESTDHANDLES` with `spec.inherited[0..3]` as hStdInput/Output/Error and leaves
   `STARTUPINFOEXW::default()`'s lpReserved2 null. So a child launched through the core has
   NO CRT block (`crt=BlockAbsent`, pinned by a test), while a Node-launched child does.
   Two genuinely different mechanisms. `mem:gotcha-crt-descriptor-block-on-windows`.

## Deviations from the plan, all deliberate
- **No `read_unaligned`, no `unsafe` in the parser.** `from_le_bytes` over a copied
  fixed-size array removes the alignment question entirely instead of getting the unaligned
  read right. Strictly stronger.
- **The probe's argv scheme is impossible as written.** Process and thread handles are
  created BY `CreateProcessW`, so no ordering puts them on the child's command line. argv
  carries the 3 ALLOWED values; the 6 FORBIDDEN values go down the child's STDIN after
  `create` returns. Stdin is available because the core passes stdio via STARTF_USESTDHANDLES.
- **`CloseFailed` is a 7th reason** the plan did not list. DoD 6 needs "a close whose outcome
  is unknown is an error", which is a refusal the vocabulary must be able to say.

## For 3b / 3c / 3d
`main.rs` contains NO framing, vocabulary, session, lifecycle or CANCEL — not even a
placeholder, deliberately. Exit codes are stable: 0 ready, 8 incomplete (unreachable by
construction, own code so the contract cannot lie), 9 report-unwritable, 10 + reason ordinal.
`main.rs` writes one ASCII line to fd1 (`descriptors ready 6 of 6`) and NOTHING to fd3/4/5.
`moe-windows-job-core` is a regular dependency; its only consumer today is
tests/handle_inheritance.rs. Production use arrives with you.

## Foreign commits
Foreign WHOLE-TREE completion commits (bec1cc6 onward) captured most of this task's bytes
before I could commit them. Not amended, not reset, not re-claimed. Review by base-ref diff:
`git diff 6de0ad02124ebf31d72ed7f63ece3c0090825196..HEAD -- packages/runner/src/platform/windows/native/`
I verified the committed bytes match the gated bytes for every mutation-drill-affected file.

## Drill results worth keeping
- FILE_TYPE_PIPE -> CHAR: 6 of 8 descriptor tests red.
- Remove the block-size check: only 1 of the 3 `CountExceedsBlock` cases reddens; the other
  two are also caught by `read_handles`' checked reads. Not a mis-attribution — in shipped
  code `fits` answers first — but know it before you edit either layer.
- Parent-side inference is BLIND: with the child-side assertions AND the probe's own verdict
  removed, a genuinely leaked handle passes green. That is DoD item 5 as an experiment.
