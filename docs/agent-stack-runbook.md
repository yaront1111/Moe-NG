# Agent stack runbook

How to run moe-next's development agent loop — daemon, scoped MCP sessions, and the
wrapper that staffs the board with real `claude` agents. Everything here was
live-proven on 2026-08-09/10: real agents completed the entire J1 bootstrap
chain and delivered a real code node (implement → test → review → acceptance)
autonomously. That is operational evidence, not a release or security-boundary
claim. All entry points run with plain `node` (Node 24 strip-types) from
`apps/daemon`.

## One command (start here)

From a clean checkout, with one agent credential exported and nothing else
(`claude setup-token` then `CLAUDE_CODE_OAUTH_TOKEN` is the individual-user
default; see Agent credentials below):

```
pnpm start
```

That runs `apps/daemon/src/orchestrator/moe-up-main.ts`, which starts the daemon
and the wrapper as child processes and prints the daemon's bound origin plus the
control-room command to point at it. It is a DEVELOPMENT launcher: it defaults
`MOE_STORE_PATH` to `<repo>/.moe-dev/store.sqlite`, defaults `MOE_PROJECT_ID` to
`moe-next-dev`, and mints a random `MOE_DAEMON_CREDENTIAL` for the run (never
printed). Any of the three you export yourself is used as-is. Do not use these
dev defaults for anything you care about keeping.

An agent credential is the one thing the launcher refuses rather than invents.
The refusal lands before either child is spawned, since `claude --bare` reads
no keychain and has no other way to authenticate:

```
MOE_UP_ENV_MISSING: CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY (set one; run `claude setup-token` for a subscription token)
```

Any ONE of those three satisfies it. Setting `MOE_AGENT_COMMAND` to `codex`
gates on the Codex roster instead (see below); any other command waives the
check entirely.

## Agent credentials

For an individual user on a Claude subscription, this is the default path:

```
claude setup-token
$env:CLAUDE_CODE_OAUTH_TOKEN = "<token printed by setup-token>"
```

An API key (`$env:ANTHROPIC_API_KEY = "<your key>"`) is the alternative, and
configured Bedrock/Vertex/Foundry credentials still work as before.

One measured caveat, true of Claude Code **2.1.235** and re-checkable with one
command: `claude -p --bare` does NOT read `CLAUDE_CODE_OAUTH_TOKEN` — supplying
the token under that name refuses `Not logged in` byte-identically to supplying
no credential at all, while the SAME value under `ANTHROPIC_AUTH_TOKEN` answers
exit 0. So the launcher accepts the subscription variable and DELIVERS it to its
children as `ANTHROPIC_AUTH_TOKEN`. Exporting `ANTHROPIC_AUTH_TOKEN` yourself is
equivalent and skips the mapping entirely. Re-probe after a CLI upgrade; the day
the alias starts working, the mapping becomes a harmless no-op rather than a
requirement.

### Codex seats (`MOE_AGENT_COMMAND=codex`)

For an individual user on an OpenAI/ChatGPT subscription, the seat is minted
INTERACTIVELY once and then carried headlessly by a directory path rather than a
token:

```
codex login                      # or: codex login --device-auth
codex login status               # -> Logged in using ChatGPT
$env:CODEX_HOME = "$env:USERPROFILE\.codex"
```

`codex login` writes `auth.json` under `CODEX_HOME` (default
`%USERPROFILE%\.codex`), and every later run reads it from there with no
interaction. Exporting `CODEX_HOME` explicitly is what makes the seat survive
the hop into a spawned agent process, whose environment is an allowlist rather
than an inheritance.

The refusal names the whole roster, same shape as the Claude one:

```
MOE_UP_ENV_MISSING: CODEX_HOME, CODEX_ACCESS_TOKEN, OPENAI_API_KEY, CODEX_API_KEY (set one; run `codex login` once, then export CODEX_HOME so the seat travels)
```

Measured on **codex-cli 0.147.0** and re-checkable with one command each:
`codex exec --help` states "auth still uses `CODEX_HOME`"; pointing `CODEX_HOME`
at an empty directory turns `codex login status` into `Not logged in` (exit 1)
while the default home answers `Logged in using ChatGPT` (exit 0); and
`CODEX_ACCESS_TOKEN` is read straight from the environment (an invalid value is
rejected as `invalid agent identity JWT format`). `OPENAI_API_KEY` and
`CODEX_API_KEY` are the API-key alternatives — `codex login --with-api-key`
reads the former from stdin. No `CHATGPT_*` variable is honored by this version.
Re-probe after a CLI upgrade; this landscape moves.

The two gates are independent: a `codex` command holding only Claude variables
is refused naming the Codex roster, and vice versa. Neither gate reads the
other's names.

The daemon binds an EPHEMERAL port on purpose, so read the printed origin rather
than assuming `39123`. Ctrl-C in this console stops both children; either child
exiting also tears the other one down. On Windows an external `SIGTERM` does not
reach a Node handler, so Ctrl-C (or killing the launcher's own process tree) is
the teardown path — not `taskkill /PID <launcher>` without `/T`.

The launcher runs both children with `node --experimental-transform-types`, and
that flag is currently load-bearing rather than cosmetic. Measured on Windows at
`b773de7`, the wrapper entry cannot start under plain `node` at all:

```
node apps/daemon/src/orchestrator/agent-wrapper-main.ts
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]:
  TypeScript parameter property is not supported in strip-only mode
  at apps/daemon/src/orchestrator/agent-spawn-contract.ts:53
```

Node 24 strips types but does not transform them, and
`agent-spawn-contract.ts:53` declares `constructor(readonly reason: ...)`. vitest
transpiles that fine, which is why the test suite never saw it. **So the manual
wrapper recipe below is broken as written — add
`--experimental-transform-types` to it, or use `pnpm start`.** The daemon recipe
is unaffected. Removing the parameter property is a separate fix; the launcher
does not repair it, and `moe-up-main.test.ts` carries a negative-control test
that reddens once it is gone, so the flag can be dropped deliberately.

Apart from that, the manual three-terminal recipe is what to reach for when you
need a fixed port, a `--csrf-token`, or one component without the other.

## Environment (shared by every entry)

| Variable | Meaning |
| --- | --- |
| `MOE_STORE_PATH` | SQLite store file (created on first open) |
| `MOE_PROJECT_ID` | Project scope for every durable decision |
| `MOE_DAEMON_CREDENTIAL` | Operator secret (all capabilities) |
| `MOE_NODE_SPECS_DIR` | Optional: dir of code-node specs (see below) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Subscription token from `claude setup-token`; accepted, and delivered to children as `ANTHROPIC_AUTH_TOKEN` (2.1.235 does not read it under `--bare`) |
| `ANTHROPIC_AUTH_TOKEN` | The name `claude --bare` actually authenticates with; export it directly to skip the mapping |
| `ANTHROPIC_API_KEY` or configured Bedrock/Vertex/Foundry credentials | The API-key alternative. ONE of these three variables is required by the wrapper's `claude --bare` child; bare mode does not read OAuth/keychain auth |
| `CODEX_HOME` | Codex state directory holding `auth.json`; carries a ChatGPT SUBSCRIPTION seat after one interactive `codex login`. First of the four the Codex gate looks for |
| `CODEX_ACCESS_TOKEN` | Codex seat token, read straight from the environment and parsed as a JWT |
| `OPENAI_API_KEY` or `CODEX_API_KEY` | The Codex API-key alternatives. ONE of these four is required when `MOE_AGENT_COMMAND` names `codex` |

On Linux, Claude's subprocess credential scrub also requires `bubblewrap`
(`bwrap`) on `PATH`. Treat either missing agent authentication or missing
subprocess isolation as a startup prerequisite, not as a reason to disable the
scrub guard.

## Daemon (HTTP: /command, /events/read, /events/ack, /affordances/read)

```
node src/daemon-main.ts --dependencies=src/daemon-store-dependencies.ts \
  --port=39123 --csrf-token=<dev-token>
```

Loopback-only by design. The control room reaches it through the dev server's
proxy — see "Control room (serving story)" below.

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

## Control room (serving story)

The board's DEFAULT view is the live daemon. There is no flag to turn live on.

```
MOE_DAEMON_ORIGIN=http://127.0.0.1:39123 \
VITE_MOE_LIVE_CSRF=<dev-token> \
VITE_MOE_LIVE_CREDENTIAL=$MOE_DAEMON_CREDENTIAL \
  pnpm --filter @moe/control-room dev
```

Then open `http://localhost:5173/`. Three arms, and which one you get is decided
by `apps/control-room/src/shell-mode.ts`:

| URL | Requires | What renders |
| --- | --- | --- |
| `/` | both `VITE_MOE_LIVE_*` values | the live board, read-only except the approval decision |
| `/?fixtures=1` | nothing | frozen fixtures under a persistent `DEVELOPMENT_ONLY/NOT_CONFIRMATORY` banner |
| `/` with either value unset | — | a notice naming both variables; **never** fixtures standing in for live data |

`/?live=1` still resolves to the live board, so older links keep working. An
explicit `?fixtures=1` wins if both appear in the same URL.

The two `VITE_MOE_LIVE_*` values are read at BUILD time, not at page load: change
either and the dev server must be restarted (`pnpm build`, for a preview build).
`VITE_MOE_LIVE_CREDENTIAL` must be a credential the daemon already accepts —
rotate the daemon's and a stale build surfaces the daemon's own auth refusal on
the board rather than an empty one.

**Topology, and its limit.** The browser never talks to the daemon directly. Vite
proxies `/command`, `/events/read`, `/events/ack`, `/affordances/read` and
`/documents/dossier/read` to `MOE_DAEMON_ORIGIN` (default `127.0.0.1:39123`) and
REWRITES the `Origin` header to that target — `apps/control-room/vite.config.ts`.
That rewrite is load-bearing: the daemon's listener guards refuse a non-loopback
`Origin` with `LISTENER_ORIGIN_INVALID`, so serving the built bundle from any
origin the daemon does not recognise fails closed rather than degrading. Opening
`dist/index.html` from the filesystem fails the same way.

This is the v0.1 topology: a trusted local workspace, one operator, dev server in
front of a loopback daemon. Production-honest serving — a real origin, a real
session handshake, credentials that are not build-time constants — is explicitly
deferred to v0.2 and nothing here should be read as it.

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
`MOE_SPEED_MODE_DELAY_MS=0` for the approval step to proceed without a human.
Both are required together and the decoder fails closed by design
(`approval-policy-settings.ts`), so a daemon started without them answers the
seed's last command `APPROVAL_HUMAN_REVIEW_REQUIRED` / `APPROVAL_POLICY` — which
the seed echoes verbatim. The delay must be exactly `0`: this approval path is
synchronous and holds no timer, so `approvalDelayDisposition` (approval-gate.ts)
calls any positive delay DEFERRED and answers the same refusal. Measured — a
daemon started at `MOE_SPEED_MODE_DELAY_MS=1` commits the first six commands and
refuses `approval.decide`. That is the daemon's policy, not a seed setting: leave
those two unset when you WANT a human to approve on the board.

The DAEMON must ALSO see the same `MOE_NODE_SPECS_DIR`. It loads the node specs
itself (`daemon-store-dependencies.ts`), so a daemon started without it publishes
no `node.deliver` step: every command still commits and the seed then exits
nonzero with `node.deliver@<nodeRef> is absent on /affordances/read`.

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
