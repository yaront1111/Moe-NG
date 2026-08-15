# Agent stack runbook

How to run moe-next's full agent loop — daemon, per-agent MCP servers, and the
wrapper that staffs the board with real `claude` agents. Everything here was
live-proven on 2026-08-09/10: real agents completed the entire J1 bootstrap
chain and delivered a real code node (implement → test → review → acceptance)
autonomously. All entry points run with plain `node` (Node 24 strip-types)
from `apps/daemon`.

## Environment (shared by every entry)

| Variable | Meaning |
| --- | --- |
| `MOE_STORE_PATH` | SQLite store file (created on first open) |
| `MOE_PROJECT_ID` | Project scope for every durable decision |
| `MOE_DAEMON_CREDENTIAL` | Operator secret (all capabilities) |
| `MOE_NODE_SPECS_DIR` | Optional: dir of code-node specs (see below) |

## Daemon (HTTP: /command, /events/read, /affordances/read)

```
node src/daemon-main.ts --dependencies=src/daemon-store-dependencies.ts \
  --port=39123 --csrf-token=<dev-token>
```

Loopback-only by design. The control room dev server proxies to it:
`apps/control-room && pnpm dev`, then `http://localhost:5173/?live=1` with
`VITE_MOE_LIVE_CSRF` / `VITE_MOE_LIVE_CREDENTIAL` set — live board with
dispatch and drag.

Reading the ledger by hand (what the live board does):

```
curl -X POST http://127.0.0.1:39123/events/read \
  -H "content-type: application/json" \
  -H "origin: http://127.0.0.1:39123" \
  -H "x-moe-csrf: <dev-token>" \
  -H "x-moe-session-credential: $MOE_DAEMON_CREDENTIAL" \
  -H "x-moe-protocol-version: moe-runtime-command/1+moe-runtime-query/1+moe-runtime-error-registry/1" \
  -d '{"limit":50,"projection":"moe.board","subscriberId":"control-room-1"}'
```

`subscriberId` must name a durable subscription; the store provider registers
`control-room-1` on `moe.board` at startup, any other id is refused with
`SUBSCRIPTION_NOT_REGISTERED`. The protocol-version value is
`WIRE_PROTOCOL_VERSION` from `apps/daemon/src/http/http-contract.ts`; a
missing or stale value is refused before authentication. `/affordances/read`
takes `{"correlationId":"…","payload":{}}` and answers the same SURFACE the
MCP `work_get_context` tool returns.

## Per-agent MCP server (what an agent session sees)

```
MOE_SESSION_CREDENTIAL=<agent secret> node src/mcp-main.ts
```

One tool per runtime kind (108) plus queries: `work_get_context` returns the
affordance surface — chain standing, daemon-minted offers, work-claim overlay,
code-node steps — and `events_read` serves ledger pages. An agent session is
minted with `session.open` (capabilities scoped per kind family; the working
principal is the session id, never the opener).

## Wrapper (staffs the board)

```
node src/orchestrator/agent-wrapper-main.ts
```

Each pass: for every READY, unclaimed step (code nodes first, `goal.close`
last, session plumbing skipped, capped by `MOE_WRAPPER_MAX_AGENTS`, default 2)
it opens a scoped session, claims the item under the AGENT'S credential (the
claim's expiry is also the reap horizon), and spawns
`claude -p --mcp-config <per-agent> --allowedTools ...` with the mission over
stdin. Chain agents get MCP tools only; code-node agents also get
Edit/Write/Read/Glob/Grep/Bash and run in their workspace. Knobs:
`MOE_WRAPPER_ONCE=1`, `MOE_WRAPPER_INTERVAL_MS` (15000), `MOE_AGENT_COMMAND`
(default `claude`). A pass that staffs nothing says so
(`[wrapper] nothing to staff (surface SURFACE, active N)`). The per-agent MCP
config file lives in a wrapper-owned temp directory, is removed when that
agent exits, and the directory goes when the wrapper process does.

## Code-node specs

A node spec is one JSON file in `MOE_NODE_SPECS_DIR`:

```json
{
  "nodeRef": "node-code-1",
  "title": "Implement the math module",
  "instructions": "Create math.mjs exporting add and multiply so test.mjs passes.",
  "test": "node test.mjs",
  "workspace": "D:/path/to/workspace"
}
```

Nodes appear on the surface only after the plan's `approval.decide` is durably
committed. Delivery is ledger truth: the agent runs the spec's test to exit 0,
then `review.submit` (round = expectedVersion + 1) and
`integration.accept_output` against the node's subjectRef; the step turns
COMMITTED when the review ledger says so, never when the agent does.

## Dev payloads

Canonical development payloads for every wired kind live in
`apps/control-room/src/live/live-dispatch.ts` (`payloadFor`), mirroring
`bootstrap-test-fixtures.ts`. The wrapper embeds them in missions as hints;
the daemon's decoder remains the only payload authority.
