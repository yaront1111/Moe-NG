# A sweep extracted into its own module needs a drill on the CALL SITE, not just the sweep

When a fix moves logic out of a caller into a new module (`http-server.ts` close() →
`http-shutdown.ts` `closeAllDaemonSessions`), drilling only the new module proves the module is
correct and proves NOTHING about whether production still reaches it. Mutating the sweep body and
mutating the delegation are different drills with different failure modes:

- **Sweep-body drill** (strip the daemon release inside `closeAllDaemonSessions`) reddens the
  module's own test AND the adapter tests — looks like full coverage.
- **Call-site drill** (revert `close()` to its pre-fix inline loop, leaving the new module
  untouched and still exported) is the only one that fails if someone later re-inlines the old
  loop, deletes the import, or wires the sweep behind a flag that is off.

On task-70b6361d the call-site drill reddened exactly the 2 adapter-level tests and left the 7
other files green — a clean, targeted signal. If it had stayed green, the sweep would have been
dead code with a passing unit test.

**How to apply:** for any extract-to-new-module fix, run two drills — one inside the extracted
function, one that removes/replaces the call to it. Related:
`mem:qa-drill-the-consumer-to-prove-composition`, `mem:qa-prove-composition-by-mutating-the-real-primitive`.

Corollary from the same task: to prove an "exactly once" assertion is load-bearing you may have
to mutate a SHARED helper rather than the code under test — a session already reaped by DELETE is
not in `entries()`, so the sweep cannot re-release it until `closeDaemonSession` stops deleting
the registry entry. Expect that drill to redden several sibling tests; over-reddening is fine as
long as the targeted assertion is among them.
