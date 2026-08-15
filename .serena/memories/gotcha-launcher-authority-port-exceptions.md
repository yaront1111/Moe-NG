# Launcher authority ports must fail closed across thrown exceptions

Typed synchronous authority ports can still throw at runtime. A top-level async launcher will otherwise convert that throw into a rejected Promise, escaping its typed failure vocabulary and allowing callers to miss the refusing authority.

At the launcher trust boundary, wrap each authority invocation separately and resolve a frozen UNKNOWN refusal. Use one stable transport code plus the authority's exact layer (for example `LAUNCH_LOCK`, `ACTIVATION`, or `GRANT`) so tests prove which layer failed. The test must use `Promise.allSettled` or `.resolves`, assert a positive generated-case count, and assert zero downstream registration, physical lock, boundary open, and spawn effects.