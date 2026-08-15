# Interrupting a crash window without reimplementing the code under test

To prove crash safety you must interrupt the PRODUCTION path — a test-local copy of the
publish sequence proves nothing. Real-filesystem tricks do not work here: you cannot get a
handle into a staging directory that the call itself creates and destroys, and Windows
`chmod` is a no-op.

What works, in `packages/store/src/backup-generation.test.ts`:

```ts
const publishFault = vi.hoisted(() => ({ armed: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: PathLike, to: PathLike): Promise<void> => {
      if (publishFault.armed && String(from).endsWith(".staging")) {
        publishFault.armed = false;
        throw Object.assign(new Error("interrupted publish"), { code: "EPERM" });
      }
      await actual.rename(from, to);
    },
  };
});
```

Four things make it safe and non-vacuous, and all four matter:

1. **Spread `actual` and pass through.** The mock is FILE-scoped and `./index.js` drags in
   the whole package. Verified first that no module in `packages/store/src` uses a DEFAULT
   import of `node:fs/promises` — they are all named, so no `default:` key is needed.
2. **Target by argument, not by call count.** `String(from).endsWith(".staging")` hits
   exactly the staging→final rename. A call-count fault breaks the moment the production
   sequence grows a rename (mine grew to three: aside, publish, restore).
3. **Self-disarm, then assert `armed === false`.** An injection that silently never fired
   leaves every downstream assertion trivially satisfied. This is epic rail 6's
   "a swept case must assert it was actually generated", applied to fault injection.
4. **Assert DISK STATE, not the return value.** A process killed in the window never
   returns at all. Asserting the refusal tuple tests error handling; asserting what
   survives on disk tests crash safety. Do both, in that order of importance.

Simulating the true crash (no `catch`, no `finally`) needs no mock at all: construct the
aftermath directly — `renameSync(dest, dest + ".previous")` plus a stale `.staging` dir —
then call production and let RECOVERY be what you measure.

**To observe a recovery that restores rather than republishes**, follow it with a request
that refuses LATER (delete a declared source object → `OBJECT_MISSING`). Otherwise the
fresh publish overwrites the restored generation and the restore is unobservable.

Related: `mem:mutation-drill-red-on-wrong-assertion`, `mem:qa-refusal-code-absent-from-test-file`.
