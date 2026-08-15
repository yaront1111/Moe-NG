# Node's extra stdio pipes DO reach a non-libuv Rust child — and FILE_TYPE_PIPE is 3, not 2

Measured empirically 2026-08-10 while planning the Windows Job broker
(task-05bf0e0f). A release Rust binary built on windows-sys `=0.61.2`, spawned
from real Node **v24.16.0** with `shell:false` and `stdio:['pipe' x6]`, calling
`GetStartupInfoW`:

```
cbReserved2=58   count=6   declared 4 + 6*(1+8) = 58   consistent=true
fd0 flags=0x09 handle=0x2c8 filetype=3
fd1 flags=0x09 handle=0x2d0 filetype=3
...
fd5 flags=0x09 handle=0x2f0 filetype=3
```

## What it establishes

1. **The CRT `lpReserved2` block is populated for a NON-libuv child.** Rust does
   not link libuv and does not use the msvcrt fd table, yet the block is present
   and parseable. So a Rust helper CAN receive Node's fd3/4/5 — the mechanism a
   six-pipe broker design depends on is real.
2. **Layout, confirmed on x64**: `u32 count`, then `count` bytes of per-fd
   flags, then `count` POINTER-SIZED handles. Total
   `4 + count * (1 + size_of::<usize>())` matched `cbReserved2` exactly.
   Use `size_of::<usize>()`; hardcoding 8 is wrong on 32-bit.
3. `flags=0x09` = `FOPEN(0x01) | FPIPE(0x08)` — corroborates pipe-ness from the
   CRT's own view, independent of `GetFileType`.
4. Handles are not sequential by contract — do not infer fd*n* from fd0.

## THE TRAP

**`FILE_TYPE_PIPE == 3`. `FILE_TYPE_CHAR == 2`.** From windows-sys source:

```rust
pub const FILE_TYPE_UNKNOWN: FILE_TYPE = 0u32;
pub const FILE_TYPE_DISK:    FILE_TYPE = 1u32;
pub const FILE_TYPE_CHAR:    FILE_TYPE = 2u32;
pub const FILE_TYPE_PIPE:    FILE_TYPE = 3u32;
```

My own probe printed a label saying `(2=PIPE)` and it was **wrong**. Anyone who
writes the literal `2` refuses every valid pipe and will chase it as a Node or
libuv bug. **Import the constant; never write the number.**

## Parsing it safely

`lpReserved2` is hostile input from the child's perspective:

- Bounds-check before every read: `cbReserved2 >= 4` before reading the count,
  then the full computed size before touching either array.
- Use **checked** arithmetic — a `count` of `u32::MAX` must refuse, not
  multiply-overflow into a small size.
- Use `read_unaligned` throughout. The handle array is not guaranteed aligned
  for `usize` when `count` is odd; a plain read is UB and can fault.
- `0` and `INVALID_HANDLE_VALUE` appear in real blocks for unused slots —
  classify as absent rather than calling `GetFileType` on them.

## Related

`GetFileType` lives in `Win32_Storage_FileSystem`, **not** `Win32_System_Threading`
— the feature list must include it.

See `mem:task-task-05bf0e0fe7e84afb8584588ecf96db14-handoff`.
