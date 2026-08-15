# Register close-out: an "already-closed" item is where a defect goes to die

`task-963cf1d1` was a SPIDR holding register — eleven audited defects, output is slices,
not code. **QA APPROVED 2026-08-15 at HEAD 192360e. Final: 10 created + 0 declined +
1 already-closed = 11.**

## The load-bearing asymmetry (worker's finding, QA confirmed)

Nine items produced a task each — a visible artifact. Two produced **nothing**. An item
recorded "already closed" leaves no trace, so a misread silently retires a real defect and
the arithmetic still balances. **The no-task column is the only place an item can vanish,
and it is the only column worth re-measuring hard.** The plan made it its own step; that
step caught a miss.

## What was misread (item 5, MCP) — QA re-measured and CONFIRMED the overturn

Finding: *"the HTTP session registry grows unbounded, and close() never releases
daemon-side bindings."* Two halves; the triage checked one and generalised.

- Half one, genuinely closed: `http-session.ts:222-223` `closeDaemonSession` does
  `registry.delete` then `port.closeSession`, wired at `http-server.ts:213` via the SDK's
  `onsessionclosed`.
- Half two, **open**: adapter `close()` at `http-server.ts:303-309` does `registry.delete`
  + `transport.close` + `server.close` and never calls `sessionPort.closeSession`.

Conflation: `registry` is the adapter's **in-process Map**. Deleting from it is not the act
of telling the daemon to drop the session. Two nouns, one word "close".

**Independent QA check that settles it without reading the worker's probe**: grep
`closeSession` across `packages/ apps/` excluding tests. The only reachable release is
`http-session.ts:223` inside `closeDaemonSession` — i.e. the DELETE path. Shutdown has no
edge to it. Worker's own kills: SDK bytes (`@modelcontextprotocol/sdk@1.30.0`
`webStandardStreamableHttp.js` `close()` at :771 never touches `_onsessionclosed`; sole
caller is `handleDeleteRequest` at :714) plus a runtime probe (initialize, then
`adapter.close()` with NO DELETE → only `bind:<id>`, no `close:<id>`).

## Why a green suite never saw it

`http-server-lifecycle.test.ts:35` is the only test recording a `close:` entry and it
DELETEs **before** `adapter.close()`. A dozen other tests end with `await adapter.close()`
as pure teardown, asserting nothing. **A teardown call everyone already writes is the worst
place to add an assertion** — reads as coverage, measures nothing. Hence child
`task-70b6361d` DoD2 requires the new test be proven RED first.

## Probe hygiene in a shared worktree

Append to an already-clean **TRACKED** file; never create an untracked scratch file (a
foreign whole-tree commit can capture it). Restore with `git checkout -- <single path>` and
prove by **sha256 before and after** — `git diff` is blind to untracked paths. QA re-checked
at approval: `22d9cd0a0036c0e3fee2da0baf5c1c19755d115cb603be6df8599153d0e9da6f`, 287 lines.

## Reconciliation mechanics

An item with a closed half and an open half is **one open item, counted once**. Both columns
gives 12 and breaks the reconciliation; closed-only is what lost it.

Verify children by **scanning `parentTaskId` across all task JSONs** — there is no children
query, and a list copied from the architect's comment cannot detect an extra or an orphan.
See `mem:gotcha-register-verify-by-parent-scan-not-comment`.

## Plan text is a snapshot, including your own architect's

- Step 3 pinned `9 + 0 + 2 = 11`; step 2 had already invalidated it.
- Step 4 said the children are BACKLOG needing promotion. At close 8 were PLANNING and
  `task-07a9a00a` was WORKING — the daemon sweep auto-promotes BACKLOG.

## Diff-free ≠ empty `git status`

Three peers mid-flight. The check is **attribution**: `git status --porcelain -- <paths you
touched>` empty, everything else resolved to a named owner. QA re-ran it over
`packages/mcp scripts/release tools/packaging` — empty.

## Open follow-up left on the record

`apps/daemon/src/mcp-http/mcp-http-session-port.ts:62-65` `boundSessionIds()` documents its
own purpose ("the host closes outstanding sessions on shutdown") and has **zero production
callers** — only its declaration, implementation and two direct tests. Recorded in
comment-c9d00058 on `task-70b6361d`, correctly reframed as a **contract** defect, not a
memory leak (the port is built inside `adapterOf()` and garbage after `doStop()`).

Related: `mem:decision-spidr-shell-closure-transit-path`, `mem:gotcha-published-is-not-composed`.
