# Agent stack runbook

How to run moe-next's development agent loop — daemon, scoped MCP sessions, and the
wrapper that staffs the board with real `claude` agents. Everything here was
live-proven on 2026-08-09/10: real agents completed the entire J1 bootstrap
chain and delivered a real code node (implement → test → review → acceptance)
autonomously. That is operational evidence, not a release or security-boundary
claim. All entry points run with plain `node` (Node 24 strip-types) from
`apps/daemon`.

## Environment (shared by every entry)

| Variable | Meaning |
| --- | --- |
| `MOE_STORE_PATH` | SQLite store file (created on first open) |
| `MOE_PROJECT_ID` | Project scope for every durable decision |
| `MOE_DAEMON_CREDENTIAL` | Operator secret (all capabilities) |
| `MOE_NODE_SPECS_DIR` | Optional: dir of code-node specs (see below) |
| `ANTHROPIC_API_KEY` or configured Bedrock/Vertex/Foundry credentials | Required by the wrapper's `claude --bare` child; bare mode does not read OAuth/keychain auth |

On Linux, Claude's subprocess credential scrub also requires `bubblewrap`
(`bwrap`) on `PATH`. Treat either missing agent authentication or missing
subprocess isolation as a startup prerequisite, not as a reason to disable the
scrub guard.

## Daemon (HTTP: /command, /events/read, /events/ack, /affordances/read)

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
`SUBSCRIPTION_NOT_REGISTERED`. A page with `nextCursor` remains the subscriber's
durable pending offer until the client presents that exact cursor to `/events/ack`:

```
curl -X POST http://127.0.0.1:39123/events/ack \
  -H "content-type: application/json" \
  -H "origin: http://127.0.0.1:39123" \
  -H "x-moe-csrf: <dev-token>" \
  -H "x-moe-session-credential: $MOE_DAEMON_CREDENTIAL" \
  -H "x-moe-protocol-version: moe-runtime-command/1+moe-runtime-query/1+moe-runtime-error-registry/1" \
  -d '{"presentedCursor":{"generation":1,"position":"42"},"subscriberId":"control-room-1"}'
```

A lost read response or reopen replays the pending offer; forged, skipped, or
already-consumed cursors refuse with `SUBSCRIPTION_CURSOR_NOT_ISSUED`. The protocol-version value is
`WIRE_PROTOCOL_VERSION` from `apps/daemon/src/http/http-contract.ts`.
Authentication runs before compatibility or body decoding. `/affordances/read`
takes `{}` or `{"projectId":"<the bound project>"}` and answers the same
SURFACE the MCP `work_get_context` tool returns.

## MCP surfaces (what an agent session sees)

```
MOE_SESSION_CREDENTIAL=<agent secret> node src/mcp-main.ts
```

The command above is the standalone stdio entry. The wrapper instead starts one
trusted loopback HTTP MCP host and gives each child a config containing only its
scoped bearer and that loopback origin; it never gives the child the operator
credential or store path.

One tool per runtime kind (108) plus queries: `work_get_context` returns the
affordance surface — chain standing, daemon-minted offers, work-claim overlay,
code-node steps — and `events_read` serves ledger pages. An agent session is
minted with `session.open` (capabilities scoped per kind family; the working
principal is the session id, never the opener).

## Wrapper (staffs the board)

```
node src/orchestrator/agent-wrapper-main.ts
```

Each pass: for every READY, unclaimed non-human step (code nodes first;
`approval.decide`, `goal.close`, and session plumbing skipped; capped by
`MOE_WRAPPER_MAX_AGENTS`, default 2)
it opens a scoped session, claims the item under the AGENT'S credential (the
claim's expiry is also the reap horizon), and spawns
`claude -p --bare --strict-mcp-config --no-session-persistence --mcp-config
<per-agent> ...` with the mission over stdin. Chain agents get MCP tools only;
code-node agents also get
Edit/Write/Read/Glob/Grep/Bash and run in their workspace. Knobs:
`MOE_WRAPPER_ONCE=1`, `MOE_WRAPPER_INTERVAL_MS` (15000), `MOE_AGENT_COMMAND`
(default `claude`). A pass that staffs nothing says so
(`[wrapper] nothing to staff (surface SURFACE, active N)`). The per-agent MCP
config file lives in a wrapper-owned temp directory, is removed when that
agent exits, and the directory goes when the wrapper process does. The wrapper
also closes the durable scoped session after the child exits; expiry is the
fallback if cleanup cannot reach the daemon.

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
committed. Driving that chain by hand — the live board, or the `curl`
recipe above — is no longer the only way:

```
pnpm seed
```

`apps/daemon/src/orchestrator/demo-seed-main.ts` dispatches the whole J1 chain
over the daemon's own HTTP surface: `project.register`, `project.bind_repository`,
`provider.probe`, `project.activate`, `goal.create`, `plan.propose`,
`approval.decide` — in that order, because `project.activate` names the probe as
a prerequisite. It CONFIRMS each command's durable commit on `/events/read`
before sending the next, then reads `/affordances/read` and exits 0 only once the
node's `node.deliver` step is READY, printing every dispatched command id. Any
daemon refusal is echoed with the daemon's own code and layer and exits nonzero.

The DAEMON must be started with `MOE_APPROVAL_MODE=SPEED` and
`MOE_SPEED_MODE_DELAY_MS=<ms>` for the approval step to proceed without a human.
Both are required together and the decoder fails closed by design
(`approval-policy-settings.ts`), so a daemon started without them answers the
seed's last command `APPROVAL_HUMAN_REVIEW_REQUIRED` / `APPROVAL_POLICY` — which
the seed echoes verbatim. That is the daemon's policy, not a seed setting: leave
those two unset when you WANT a human to approve on the board.

It reads four variables and refuses each missing one BY NAME, never printing a
value: `MOE_DAEMON_ORIGIN` (a bare origin — the Origin guard compares it
exactly), `MOE_DAEMON_CREDENTIAL` (operator), `MOE_CSRF_TOKEN`, and
`MOE_NODE_SPECS_DIR` (the demo node spec above; the first `.json` by name is
seeded). Optional: `MOE_PROJECT_ID`, `MOE_GOAL_ID`, `MOE_RUN_ID`,
`MOE_PRINCIPAL_ID`, and `MOE_EVENT_SUBSCRIBER` — which defaults to
`control-room-1` because that is the only reader the daemon registers at startup
and no route seats another. The seed changes no daemon contract; it is a client
of `/command`, `/events/read`, `/events/ack` and `/affordances/read`. The manual
recipe above still works and is what to reach for when you want one command at a
time. Delivery is ledger truth: the agent runs the spec's test and records
`review.submit` (round = expectedVersion + 1). It cannot call
`integration.accept_output`; the daemon-side development verifier reruns the
test and records the acceptance path. The step turns COMMITTED only when the
review ledger says so.

The current verifier runs a shell command from an agent-modifiable workspace
under the wrapper's OS account. Environment scrubbing and bounded execution are
defence in depth, not isolation. Do not use this development runner as an
authoritative or adversarial verification boundary; a separate unprivileged,
sealed verifier and daemon-minted receipt are still required.

The live event feed is also not yet a lossless resumable consumer: it does not
durably acknowledge an issued page cursor. Do not rely on it for audit export or
long-running unattended monitoring until pending-page issuance and exact cursor
acknowledgement are durable.

## Dev payloads

Canonical development payloads for wired development kinds live in
`apps/control-room/src/live/live-dispatch.ts` (`payloadFor`), mirroring
`bootstrap-test-fixtures.ts`. The wrapper embeds non-human command hints in
missions; it never embeds an acceptance payload. The daemon's decoder remains
the only payload authority.
