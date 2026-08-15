# A held file handle does NOT make rmSync throw on Windows

## The tell
A test that "simulates Windows EBUSY" by opening a file with `fs.openSync` and then
running `rmSync(dir, {force: true, recursive: true})` is **vacuous**. Probed directly:

```js
const fd = fs.openSync(p.join(dir, 'held.bin'), 'r');
try { fs.rmSync(dir, {force: true, recursive: true}); console.log('NO_THROW'); }
catch (e) { console.log('THREW', e.code); }
// -> NO_THROW
```

libuv opens with `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`, so Node's own
handles never block deletion. The directory disappears with the fd still open, POSIX-style.
Real EBUSY needs a handle from something that did NOT ask for share-delete (a foreign
process, a loaded DLL, a mapped file, or the process cwd) — see
`mem:vitest-worker-dies-on-held-sqlite-handle`, where SQLite is exactly such a holder.

## Why it matters
The plan for task-5611791337894212a277600a0768f1f9 specified a held-handle simulation for a
cleanup-throws test. Written that way, the test would have gone GREEN against the unfixed
code and "proved" a guard that did not exist.

## What to use instead
Find a removal the production code performs **without** `recursive` and plant a directory
at that path — `rmSync` then raises `ERR_FS_EISDIR` deterministically, on every platform,
from the exact production line. In `scripts/release/supply-chain.mjs` `cleanRoots` does
`rmSync(root, {force,recursive}); rmSync(`${root}.tar`, {force})` — the second call is the
seam, and the injected `archiveSource` port receives `{destination: root}`, so a test can
plant the obstacle at the real path.

Generally: to force a filesystem throw deterministically, prefer a **type/shape** conflict
(EISDIR, ENOTDIR, ENOTEMPTY) over a **lock** (EBUSY/EPERM). Shape is portable and
synchronous; locks depend on share flags you do not control.

## How to apply
- Never accept "held handle" as a throw-forcing mechanism on Windows without probing it.
- Probe the mechanism BEFORE writing the test around it: 6 lines of `node -e` settles it.
- Then confirm the finished test is real with a mutation drill — strip the guard, require red.

Found on task-5611791337894212a277600a0768f1f9 (moe-next, release supply chain), 2026-08-15.
