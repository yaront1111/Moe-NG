# A directory-enumeration test blocks every new module in that folder

`apps/control-room/src/performance/timing.test.ts` holds:

```ts
const PRODUCTION_MODULES = Object.freeze([...] as const);
// "scans exactly the production modules present, so a new one cannot escape"
expect(present).toEqual(PRODUCTION_MODULES.map(([name]) => name).toSorted());
```

`present` is `readdirSync(PERFORMANCE_DIR)` minus `.test.`. So ADDING ANY
production file to that directory reddens a test in a file you do not own, with
a failure that reads like a foreign break:

```
AssertionError: expected [ 'command-latency.tsx', …(6) ] to deeply equal [ 'command-latency.tsx', …(2) ]
```

**The entry is forced, and adding it is the positive fix.** Each entry is
`[filename, anchorString]`, and the anchor must appear in the source, so a
one-line addition per module. Narrowing the scan (an exclude, a filter, a
prefix skip) would hide the new modules from the sibling's `REAL_TIME_API` ban
— which is exactly what that scan exists to enforce — and reads as evading a
gate rather than passing it.

Generalisation: before adding a production file to a directory, grep that
directory's tests for `readdirSync`/`readdir` and for a frozen list of file
names. Related shape: `mem:closed-verdict-map-forbids-a-new-test-file` and
`mem:closed-enum-all-array-couples-sibling-tests`.

Second-order note: the same scan then applies its own bans to your module. Mine
passed the no-real-clock ban unchanged, but a module that legitimately read a
clock would need the scan's owner consulted, not the list edited.
