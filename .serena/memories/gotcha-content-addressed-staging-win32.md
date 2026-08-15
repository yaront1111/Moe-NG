# Gotcha: content-addressed staging on Windows (Node v24, win32)

Empirically verified on this machine while building `packages/runner/src/artifacts`:

1. `renameSync` SILENTLY REPLACES a closed existing destination on win32 (POSIX-like), which would mask
   corruption at a content address, and throws EPERM when a concurrent reader (or an AV scanner) holds the
   destination open. Both failure modes are avoided by the same protocol: check exists FIRST, verify the
   EXISTING object, delete the temp, return the existing ref. Rename only onto a nonexistent address.
2. `writeFileSync` cannot implement durable staging: no file descriptor, so "flush before rename" is
   unimplementable. The filesystem port must be descriptor-oriented (openWrite/write/fsync/close).
3. `fsync(fd)` is NOT the durability point for a rename. The rename is metadata: POSIX needs a parent-directory
   fsync, win32 cannot fsync a directory at all and needs a reopen + flush of the final path. Make this a
   first-class port method (`persistAfterRename`) so it is an injectable fault boundary, and return the ref only
   after it. Measured cost: ~21ms / 20 iterations on tmpdir — no CI concern.
4. A post-rename verification failure MUST unlink or quarantine the address before returning the error.
   Leaving mismatched bytes poisons that address forever: every future staging of the true content dedups onto
   the wrong bytes.
5. Temp and final name must share one directory — a cross-volume Node rename degrades to a non-atomic copy.
   Temp name = `<sha256-prefix>.<injected-counter>.tmp`; no Math.random / Date.now (determinism rail).

Same package, scope area: `process.platform === "win32"` case folding is needed for realpath containment
comparison, but `process.env` must never be read in production sources — `hermeticGitEnvironment(base)` takes
the environment as a parameter instead.
