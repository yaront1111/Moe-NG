# Wiring an unused accessor can be CIRCULAR — that is the signal to delete it

Found on task-6f58ca42 (2026-08-15), `apps/daemon/src/mcp-http/mcp-http-session-port.ts`.

An interface method `boundSessionIds()` had a docstring asserting a consumer:

> "Real production surface: the host closes outstanding sessions on shutdown and cannot do
> that without asking."

Four grep hits total — declaration, implementation, two assertions in its own test. Zero
production callers. The tempting default is WIRE it, because wiring "feels safer" than deleting
and a comment claiming a shutdown guarantee sounds like something you should honour.

**The test that decides it:** ask whether the claimed consumer relationship EXISTS. Here the
host held no reference to the port at all — the port was constructed INLINE inside the argument
list of `createHttpMcpAdapter(...)` and never stored. So wiring the accessor would have required
first hoisting the port into a host-level variable, i.e. **creating the very coupling the
docstring asserts already exists, in order to justify the accessor that asserts it.** Circular.

When wiring is circular, the surface is not "unimplemented", it is **obsolete**, and removal is
the honest outcome. An unused method deleted is honest; an unused method kept with a false
guarantee is worse than a plain unused export, because a reader trusts the comment and nothing
enforces it.

**Two corollaries worth carrying:**

1. Delete the COMMENT with the method. Leaving the prose behind recreates the exact defect —
   a claim nothing enforces.
2. Look one level down. The accessor was the only READER of a private `Map`; removing it left
   the map write-only, which is the same defect shape one layer deeper. "The only reader is
   gone" is a *static* proof of unreachability, not a coverage claim — grep for the identifier
   and confirm you see construction + writes and no reads.
3. Check the TEST TITLES the removal orphans. `it("binds and closes transport sessions
   idempotently ...")` no longer asserted idempotency once the observing assertions went; a
   title promising a property no assertion enforces is the same defect restated in the test file.

Related: `mem:closed-verdict-map-forbids-a-new-test-file`,
`mem:qa-positive-control-on-an-empty-grep` (an empty removal grep needs a control run),
`mem:daemon-focused-vitest-finds-zero-tests`.
