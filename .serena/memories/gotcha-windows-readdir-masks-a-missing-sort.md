# On NTFS, a directory sort is a no-op — so a two-run test cannot prove it exists

Found 2026-08-09 on `task-a4593fb7` (`@moe/import`), by a mutation drill that came back
GREEN when it should not have.

## What happened

`source-manifest.ts` sorts every directory listing with an explicit code-unit comparator,
because `readdir` order varies by filesystem and a determinism guarantee depends on it.
The drill neutered the comparator to always return `0`. The migration-level determinism
test — two full imports over separate trees with files created in OPPOSITE order,
compared for an identical fingerprint — stayed **green**.

**NTFS returns directory entries in case-insensitive alphabetical order.** For an
all-lowercase fixture that is already the sorted order, so the sort changes nothing and
both runs agree whether or not the comparator works. The bug only appears on ext4 or APFS
(inode / hash order) — months later, on someone else's machine, unreproducible on the one
that wrote it.

Adding an explicit *expected order* assertion did **not** fix it. Verified with the mutant
still live rather than assumed — the expected order and the NTFS order are the same list.

## The only fixture that distinguishes them on Windows

Mixed case. NTFS lists case-insensitively (`alpha, Beta, Zulu, mid`); code-unit order puts
uppercase first because `B` is `0x42` and `a` is `0x61`:

```ts
// files created: alpha.json, Beta.json, Zulu.json, mid.json
expect(manifest.entries.map((e) => e.path))
  .toEqual(["Beta.json", "Zulu.json", "alpha.json", "mid.json"]);
```

With this case present, the neutered comparator reddens.

## Generalisation

A two-run comparison proves *agreement*, not *control*. When the property is "we impose
our own order", the fixture must make the imposed order DIFFER from what the environment
would hand back — otherwise the environment is silently supplying the answer and the
guard is untested no matter how green the suite looks.

Same shape applies to: `Object.keys` (V8 already yields insertion order), `Map`
iteration (already insertion order), and any "we sort this" claim tested on a
pre-sorted input.

Verify by mutation, not by reading: this guard read as obviously-tested and was not.
Related: `mem:gotcha-clamped-page-must-not-trust-unclamped-hasmore`,
`mem:pattern-guard-the-case-list-not-just-the-cases`.
