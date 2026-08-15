# Gotcha: Windows path checks that look strict and are not

Found 2026-08-09 building the Claude runtime closure pin (`task-078af6f1`). Every
one of these was a real hole or a real test defect, not a hypothetical.

## `path.join` NORMALISES, so it cannot build a traversal fixture

```ts
join(installedRoot, "lib", "..", "claude.exe")   // => installedRoot\claude.exe
```
The `..` is gone before your code ever sees it. A test row written this way is not
testing traversal rejection — it silently tests whatever the normalised path hits
(for us `PATH_MISSING`, not `PATH_INVALID`). Build attack paths by string
concatenation:
```ts
`${installedRoot}\\lib\\..\\claude.exe`
```
Same family as `mem:pattern-guard-the-case-list-not-just-the-cases`: the case
existed, the case list was fine, but the case had quietly become a different case.

## `resolve`/prefix checks do not reject UNC or device paths

`\\server\share\x`, `\\?\D:\x`, `\\.\PhysicalDrive0` all survive naive
normalisation and can then pass a `startsWith(root)` containment check. Reject the
SHAPE before any filesystem call. What worked:
```ts
const LOCAL_ABSOLUTE = /^[A-Za-z]:\\(?:[^\\/:*?"<>|]+\\)*[^\\/:*?"<>|]+$/u;
```
plus an explicit `.`/`..` segment scan (the regex happily matches `..`).
This one regex covers UNC, device, forward slashes, trailing separator, empty
segments and reserved characters.

## Checking only the LEAF misses a junction above it

`lstat("<root>\link\runtime.pack")` reports a plain FILE when `link` is a junction.
Walk EVERY segment below the containment root:
```ts
for (const [index, segment] of relative(root, target).split(sep).entries()) { ... }
```
Junctions are creatable without admin (`symlinkSync(target, link, "junction")`), so
this is cheap to fixture. Directory symlinks/junctions are also why a recursive
`readdir` walk cannot loop: a Dirent for a directory symlink answers
`isSymbolicLink()`, not `isDirectory()`.

## `realpath` fold-equality catches what the shape check cannot

Comparing `fold(await realpath(p)) !== fold(p)` rejects, in one line: 8.3 short
names (`PROGRA~1`), trailing dots/spaces (Windows strips them, so `claude.exe.`
opens `claude.exe`), and any surviving reparse traversal. Reserved device names
(`NUL`, `CON`) fall out separately as `lstat` kind OTHER.

## `??` swallows an intentional `null` in a test helper

```ts
reportedVersion: overrides.reportedVersion ?? BASE.reportedVersion  // null => BASE
```
The row meant to test the UNKNOWN-truth quote silently ran the VALID path and
passed against a stub. Use `"key" in overrides` whenever `null` is a case under
test. Bit twice in one file — once for a null version, once for a non-record quote.

## Verifying declared members is not verifying the directory

A published content-addressed root whose every declared member hashes correctly can
still hold an UNDECLARED neighbour — which is exactly how a side-by-side DLL load
gets into a "verified" directory. Sweep for extras:
```ts
const declared = new Set(sources.map((s) => s.relativePath));
const extra = (await fs.listFiles(root)).filter((p) => !declared.has(p));
```
Found by adversarial review, not by any test that existed.
