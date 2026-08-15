# QA verdict — task-70b6361d (MCP adapter close releases daemon-side session bindings)

**APPROVED** by qa-f6ca780e at HEAD `181e0e9`. `git status --porcelain -- packages/mcp/` empty,
so the bytes I judged are the committed ones.

## Gate re-run by me (legs separate, foreground)
- `pnpm --filter @moe/mcp typecheck` → TC_EXIT=0
- `pnpm --filter @moe/mcp test` → `Test Files 9 passed (9)` / `Tests 139 passed (139)`, TEST_EXIT=0
- Matches the worker's `task.verification` exactly (baseline 8/136 + 3 new tests).

## DoD mapping
1. `http-server.ts` close() is a one-line delegation to `closeAllDaemonSessions(registry,
   options.sessionPort, registry.entries())`; release routes through the EXISTING
   `closeDaemonSession` (`http-session.ts:217-223`) so shutdown and DELETE cannot drift and
   unroute-then-notify is inherited. `http-server.ts` 312→311; new `http-shutdown.ts` 114 lines.
2/3. Lifecycle tests assert whole ORDERED traces (`[bind:<id>, close:<id>]` with no DELETE; the
   four-event DELETE+shutdown trace) plus per-id count pins — not `toContain`.
4. Sweep test pins the 6-event trace, empty registry, and the code/layer as LITERALS
   (`"HTTP_SHUTDOWN_SESSION_RELEASE_FAILED"`, `"mcpHttpAdapterShutdown"`) + `failedSessionIds`;
   daemon detail kept off the message and on `cause`.
5. `git show --numstat` on `http-server-lifecycle.test.ts` = **84 insertions / 0 deletions** —
   that is the cheap proof the pre-existing DELETE assertion is byte-identical. Use it instead of
   re-reading the old test body.

## My 5 drills (worker ran 6; mine are independent)
D1 strip the daemon release from the sweep → 3 red, incl. `expected [ Array(1) ] to deeply equal
[ …(2) ]` — the original runtime probe reproduced verbatim.
D2 revert close() to the pre-fix loop → the 2 adapter tests red: **the delegation seam itself is
load-bearing**, which is the drill that separates "sweep is correct" from "adapter uses it".
D3 swallow (`length < 0`) → `expected undefined to be an instance of HttpShutdownError`.
D4 replace `attempt()` with bare awaits → `expected [ 'close:session-a' ] to deeply equal [ …(6) ]`.
D5 drop `registry.delete` in `closeDaemonSession` → exactly-once red on the double release.

Restore protocol: sha256 of all three production files to `/tmp/qa-pre.sha` BEFORE the first
drill, reverse-edit via Python (`assert s.count(old)==1`), `sha256sum -c` after every drill.
Never `git checkout` — see `mem:git-checkout-restore-destroys-uncommitted-work`.

## Notes for whoever touches this next
- `task-6f58ca42f8c2497898a9ed2ea02c9632` owns the host-side decision on
  `apps/daemon/src/mcp-http/mcp-http-session-port.ts` `boundSessionIds()`. **Do not add a
  host-side sweep** — after this commit `adapter.close()` already releases, so a second sweep is
  a double release.
- Root exports are additive and nothing does `export * from "@moe/mcp"`, so no consumer can be
  broken by the new `HTTP_SHUTDOWN_*` names.
- Residual, pre-existing: `entries()` is a snapshot, so a DELETE interleaving mid-sweep could
  double-release and an `initialize` landing after the snapshot goes unswept.
