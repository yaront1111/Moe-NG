# windows-sys gates a function on the feature of its PARAMETER's module

Found 2026-08-10 on task-55e2c4c8 adding the broker's first `ReadFile`/`WriteFile` call.

## The symptom

The manifest already had `Win32_Storage_FileSystem`, which is where `ReadFile` and `WriteFile`
live. The import still failed:

```
error[E0432]: unresolved imports `windows_sys::Win32::Storage::FileSystem::ReadFile`,
                                 `windows_sys::Win32::Storage::FileSystem::WriteFile`
   |     GetFileType, ReadFile, WriteFile, FILE_TYPE_PIPE, FILE_TYPE_UNKNOWN,
   |                  ^^^^^^^^  ^^^^^^^^^ no `WriteFile` in `Win32::Storage::FileSystem`
```

This reads exactly like a wrong import path, and the natural next move — hunting for the "real"
module — finds nothing, because the path is correct.

## The cause

The declaration is feature-gated on a DIFFERENT module's feature, because its signature NAMES a
type from there. Verified in the vendored source,
`windows-sys-0.61.2/src/Windows/Win32/Storage/FileSystem/mod.rs:331`:

```rust
#[cfg(feature = "Win32_System_IO")]
windows_link::link!("kernel32.dll" "system" fn ReadFile(.., lpoverlapped : *mut super::super::System::IO:: OVERLAPPED) -> BOOL);
```

`*mut OVERLAPPED` lives in `Win32/System/IO`, so `Win32_System_IO` is required — even when you pass
a null overlapped pointer and never name the type yourself.

## How to diagnose in one step

Read the declaration in the vendored crate rather than guessing:

```sh
WS=$(find ~/.cargo/registry/src -maxdepth 2 -type d -name "windows-sys-0.61.2" | head -1)
grep -rn -B 2 "fn ReadFile" "$WS/src"
```

The `#[cfg(feature = ...)]` line directly above the `link!` is the answer. The compiler error names
the module that HAS the function, never the feature that is missing.

## Note on `--locked`

Adding a feature to an already-pinned dependency adds no package, so `Cargo.lock` is unchanged and
`--locked` still holds. Confirm with `git status --porcelain -- Cargo.lock` rather than assuming.

Related: `mem:gotcha-readfile-broken-pipe-is-eof-not-failure`,
`mem:decision-broker-crate-seam-as-landed`.
