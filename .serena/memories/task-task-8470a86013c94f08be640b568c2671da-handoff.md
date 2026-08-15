# Handoff: task-8470a86013c94f08be640b568c2671da

## Status
Plan submitted once and accepted by Moe into AWAITING_APPROVAL on 2026-08-09. Do not poll the human approval gate. Plan has 7 steps, 8 distinct files, and 2 new focused tests.

## Remeasured baseline
- Overlapping transport task `task-318379eac8b54e688eadf7130b88f78e` is DONE; this is a hardening/publication delta, not a greenfield listener.
- Measured HEAD: `41e4a1c2f3d49e00173efa6e4b91357452f4f30b`.
- Pinned design SHA-256 matched: `1D9D1EC97D3F07247FBBC088045E0BA2FD6DA8307F10A9026C55106419383191`.
- Fresh daemon typecheck exit 0; daemon tests: 30 files / 597 tests.
- Production lines: listener 194, guards 143, entry 161, index 262. Index was already above the 250 target but below the 400 split limit; BACKLOG `task-5e43a9e294ef48fdab23817c8c6cfc45` owns later extraction and must preserve this HTTP surface.
- Current root has 44 runtime names. Missing seven reviewed HTTP names make the target 51.
- Current source bin runs with Node 24, but `pnpm --filter @moe/daemon exec moe-daemon` is not self-linked. Plan adds `start: node ./src/daemon-main.ts`.

## Planned delta
Owned paths:
1. `apps/daemon/src/daemon-startup.test.ts` (new)
2. `apps/daemon/src/http/http-listener-forwarding.test.ts` (new)
3. `apps/daemon/src/index-surface.test.ts`
4. `apps/daemon/src/daemon-entry.ts`
5. `apps/daemon/src/http/http-listener-guards.ts`
6. `apps/daemon/src/http/http-listener.ts`
7. `apps/daemon/package.json`
8. `apps/daemon/src/index.ts`

Behavior:
- Refuse incomplete provider results before CSRF mint/bind with exact `DAEMON_ENTRY_DEPENDENCIES_INVALID / DAEMON_ENTRY`; structurally require only the methods the transport calls, allow an empty registry, and validate optional subscriptions without invoking command authority.
- Add exact listener catch refusal `LISTENER_REQUEST_FAILED / CONTROL_ROOM_LISTENER / 500`; typed adapter results remain verbatim.
- Real-socket matrix covers all seven `HTTP_REFUSAL_STAGES`, exact codes/statuses, exact stage-set/count, DISPATCH port layer, handler non-entry, accepted control, and every production bound at N/N+1.
- Successful real child probe uses an OS-temp provider plus wrapper around production `runDaemonMain`; stdin invokes the existing shutdown callback so Windows is graceful. It prints one canonical `REAL_SOCKET_PROBE` line and proves port rebind.
- Root explicitly exports the seven HTTP runtime values and complete type closure, aliasing HTTP `CommandHandler` as `HttpCommandHandler`; no fixtures or internal helpers leak.

## Contract nuance
For ordinary `HttpRefused`, the production contract defines `stage` as the refusing layer; there is intentionally no separate layer field. Only DISPATCH carries an additional upstream `refusal.layer`. Never add a listener layer to adapter results.

## Scope caveat
The standalone CLI deliberately does not reveal its minted CSRF token. The child probe therefore drives a listener-owned unknown-route refusal; the seven-stage production boundary is proven over real sockets around `startDaemon`, which returns the token in-process. Do not invent argv/env/log secret transport. A standalone accepted command would require a separate OS-protected bootstrap channel.

## Exact final gate
`pnpm --filter @moe/daemon typecheck && pnpm --filter @moe/daemon exec vitest run --root . --config package.json src/daemon-startup.test.ts src/http/http-listener-forwarding.test.ts src/index-surface.test.ts --reporter=verbose && pnpm --filter @moe/daemon test && pnpm typecheck`

Adversarial drills occur immediately before that final gate and must redden dependency validation, verbatim forwarding, streamed body bound, and root publication tests before exact restoration. Pure `http-adapter.ts`, `http-contract.ts`, event stream, handlers, and fixtures remain byte-identical.

## Withdrawal (2026-08-09 14:20Z)
Governor `governor-f70d1157` withdrew the task from WORKING to BACKLOG as a duplicate of DONE task `task-318379eac8b54e688eadf7130b88f78e`. Worker stopped immediately and created no commit. The eight touched paths were `apps/daemon/package.json`, `src/daemon-entry.ts`, `src/daemon-startup.test.ts`, `src/http/http-listener-guards.ts`, `src/http/http-listener.ts`, `src/http/http-listener-forwarding.test.ts`, `src/index.ts`, and `src/index-surface.test.ts`; they were left untouched for attribution. Four temporary mutation drills had already been restored byte-exact. Do not resume or claim this task as written; any actual gap needs a narrow new follow-on measured against the shipped listener/entrypoint.
