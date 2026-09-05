# Agent stack runbook

How to run moe-next's development agent loop — daemon, scoped MCP sessions, and the
wrapper that staffs the board with real `claude` agents. Everything here was
live-proven on 2026-08-09/10: real agents completed the entire J1 bootstrap
chain and delivered a real code node (implement → test → review → acceptance)
autonomously. That is operational evidence, not a release or security-boundary
claim. Source entry points run with Node 24 from `apps/daemon`; the Windows
artifact wraps the same CLI with `moe.cmd` and `moe.ps1`.

## Windows artifact: first project

The supervised-MVP artifact is manager-first. In the extracted directory, export
one agent credential from the roster below and run:

```powershell
.\moe.cmd projects
```

The command remains in the foreground and prints:

```text
moe projects: project manager ready
moe projects: http://127.0.0.2:39122/?projects=1#manager=<one-use-ticket>
moe projects: Ctrl-C stops the manager and every project runtime
```

Open the exact printed URL manually within 60 seconds. The manager ticket is a
one-use bearer. Successful pairing removes its fragment and leaves a narrow
manager cookie on `127.0.0.2`. That browser session receives no project operator
or runtime-session credential, and the manager catalog persists neither. If the
ticket expires before pairing, Ctrl-C and restart `moe projects` to mint a new
manager session.

Use **Create** for a new Windows directory or **Register** for an initialized
directory that already contains `moe.config.json`. Each catalog row shows its
title, root, project id, and exact lifecycle. Select **Start**, then **Open**.
Open asks that project's daemon for a fresh
`http://127.0.0.1:<port>/#pair=<one-use-ticket>` and opens it in a separate tab.
That ticket is also one-use and expires after 60 seconds; return to the still-open
manager tab and select Open again if it expires. Use the manager tab to move
between projects. Goals, tasks, and boards stay bound to the daemon, SQLite store,
and browser session for the selected project; the UI does not aggregate them.

For a newly created directory, this makes the project list, daemon controls,
switching, and isolated setup board usable immediately. It does **not** fabricate
activation. **New Goal** remains disabled until the project ledger contains
legitimate durable repository, provider, distribution, backup, credential, and
store receipts. What has changed is who writes them: the **Activate project** card
on the Goals screen reads `POST /activation/read` and drives `project.register`,
`project.bind_repository`, `provider.probe` and `project.activate` from a single
button, so the browser alone takes an empty store to a created goal. The daemon
mints each receipt from a MEASURED fact -- the repository row carries the real
HEAD sha of the bound checkout -- and a receipt it cannot measure is rendered
`UNKNOWN` with its code and layer rather than filled in, so the cards still block
with their exact missing-authority reasons when a prerequisite genuinely fails.
Development fixtures cannot clear those gates in a production build.

The manager stores non-secret catalog metadata in
`%LOCALAPPDATA%\Moe\projects.json` and supervises one contained runtime per
running row. Keep its console open. Ctrl-C drains the manager and every project
runtime it owns.

For one project without the central UI, the compatibility path is:

```powershell
.\moe.cmd init demo
.\moe.cmd start demo
```

`moe start` uses the same native per-store boundary, remains in the foreground,
prints `moe start: project runtime ready` plus one `#pair=` URL, and stops that
runtime on Ctrl-C. Its printed ticket has the same 60-second window; restart the
command if it expires. Use `moe projects` when you need a durable list and switching.

Moe never launches either bearer-bearing URL itself because another Windows
process running as the same user can read process command lines. Keep console
scrollback private and open printed URLs immediately.

## Source development launcher

From a clean checkout, with one agent credential exported and nothing else
(`claude setup-token` then `CLAUDE_CODE_OAUTH_TOKEN` is the individual-user
default; see Agent credentials below):

```powershell
pnpm --filter @moe/control-room build
pnpm start
```

The first command builds the control room that a clean source checkout does not
carry. The second runs `apps/daemon/src/orchestrator/moe-up-main.ts`, which starts the daemon
and the wrapper as child processes and prints the daemon's bound origin plus the
control-room `#pair=` URL. Open that printed URL manually within 60 seconds. The launcher never
passes the bearer-bearing URL to a browser process because on Windows another
process running as the same user can read process command lines. It is a one-use
bearer and expires after 60 seconds, so keep the console/scrollback private and
open it immediately; this manual console handoff is a known supervised-MVP
residual. It is a DEVELOPMENT launcher: it defaults
`MOE_STORE_PATH` to `<repo>/.moe-dev/store.sqlite`, defaults `MOE_PROJECT_ID` to
`moe-next-dev`, and mints a random `MOE_DAEMON_CREDENTIAL` for the run (never
printed). Any of the three you export yourself is used as-is. Do not use these
dev defaults for anything you care about keeping.

An agent credential is the one thing the launcher refuses rather than invents.
The refusal lands before either child is spawned, and it names both the
variables it accepts and the sign-in file it looked for:

```
MOE_UP_ENV_MISSING: CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY (set one, or sign in once: run `claude` and `/login`; `claude setup-token` also works); no sign-in at C:\Users\you\.claude\.credentials.json
```

Any ONE of those three variables satisfies it, and so does the sign-in file
alone. Setting `MOE_AGENT_COMMAND` to `codex` gates on the Codex roster instead
(see below); any other command waives the check entirely.

## Agent credentials

For an individual user on a Claude subscription, the default path is the
sign-in you already have: run `claude` once, `/login`, done. The seats are
spawned WITHOUT `--bare` (bare mode authenticates from the environment only and
never reads a sign-in), so a child with no `ANTHROPIC_*` variable answers from
`~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR/.credentials.json`). The
launcher discloses which one it found:

```
  CLAUDE_CONFIG_DIR=C:\Users\you\.claude (defaulted)
```

The isolation `--bare` used to give is restated flag by flag on the seat:
`--setting-sources ""` (no user/project/local settings, so none of YOUR hooks
or plugins run inside a seat), `--disable-slash-commands`,
`--no-session-persistence`, `--strict-mcp-config` with the per-agent MCP config.
Measured 2026-09-03 on claude 2.1.x: a user-settings hook that a default
`claude -p` injects is absent under `--setting-sources ""`. Two things bare mode
skipped are NOT restated: a seat working in a project directory reads that
project's `CLAUDE.md`, and it may write auto-memory under your profile.

An environment credential still wins over the sign-in, matching the CLI's own
precedence: a headless host exports `ANTHROPIC_API_KEY` (or configured
Bedrock/Vertex/Foundry credentials), or a subscription token from
`claude setup-token` as `CLAUDE_CODE_OAUTH_TOKEN`.

One measured caveat, true of Claude Code **2.1.235** and re-checkable with one
command: `claude -p` does NOT read `CLAUDE_CODE_OAUTH_TOKEN` — supplying
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

This `pnpm start` path is the single development-store launcher, not the project
manager. For multiple durable project directories use the artifact's `moe projects`
flow above, or invoke the source CLI's `projects` command while developing it.

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
| `CLAUDE_CONFIG_DIR` | Where the claude sign-in lives (`.credentials.json`); defaults to `~/.claude`. A present sign-in satisfies the gate with no variable set, and the launcher delivers this name so the seats agree |
| `CLAUDE_CODE_OAUTH_TOKEN` | Subscription token from `claude setup-token`; accepted, and delivered to children as `ANTHROPIC_AUTH_TOKEN` (2.1.235 does not read it under that name) |
| `ANTHROPIC_AUTH_TOKEN` | The environment name the claude CLI authenticates with; export it directly to skip the mapping |
| `ANTHROPIC_API_KEY` or configured Bedrock/Vertex/Foundry credentials | The API-key alternative. Any environment credential takes precedence over the sign-in file |
| `CODEX_HOME` | Codex state directory holding `auth.json`; carries a ChatGPT SUBSCRIPTION seat after one interactive `codex login`. First of the four the Codex gate looks for; defaults to `~/.codex` when `auth.json` is there |
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

## Control room serving

The packaged manager and per-project daemons serve the built bundle from their
own loopback origins. The browser pairs on that same origin, receives a scoped
runtime session, and scrubs the ticket fragment. No credential is compiled into
the packaged bundle, and no Vite server is involved.

### Development Vite proxy

The development board's DEFAULT view is the live daemon. There is no flag to
turn live on.

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
| `/` | both `VITE_MOE_LIVE_*` values | the live board — the operating surface: every READY step with a dev payload dispatches from its card |
| `/?fixtures=1` | nothing | frozen fixtures under a persistent `DEVELOPMENT_ONLY/NOT_CONFIRMATORY` banner |
| `/` with either value unset | — | a notice naming both variables; **never** fixtures standing in for live data |

`/?live=1` still resolves to the live board, so older links keep working. An
explicit `?fixtures=1` wins if both appear in the same URL.

The two `VITE_MOE_LIVE_*` values are read at BUILD time, not at page load: change
either and the dev server must be restarted (`pnpm build`, for a preview build).
`VITE_MOE_LIVE_CREDENTIAL` must be a credential the daemon already accepts —
rotate the daemon's and a stale build surfaces the daemon's own auth refusal on
the board rather than an empty one.

**Development topology and its limit.** In this path the browser talks to Vite. Vite
proxies `/command`, `/events/read`, `/events/ack`, `/affordances/read` and
`/documents/dossier/read` to `MOE_DAEMON_ORIGIN` (default `127.0.0.1:39123`) and
REWRITES the `Origin` header to that target — `apps/control-room/vite.config.ts`.
That rewrite is load-bearing: the daemon's listener guards refuse a non-loopback
`Origin` with `LISTENER_ORIGIN_INVALID`, so serving the built bundle from any
origin the daemon does not recognise fails closed rather than degrading. Opening
`dist/index.html` from the filesystem fails the same way.

This proxy is for a trusted source workspace and one operator. It is not the
packaged topology described above and must not stand in for the pairing/session
journey in Windows acceptance evidence.

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
code-node steps — and `events_read` serves ledger pages. With a payload of
`{"workItemId": "<the item you hold>"}` it returns only that step (outcome
`SURFACE_ITEM`, with its claim and `claimAggregateVersion`, and the commands
offered on that aggregate) — under 8 KB, so a harness that truncates large
results still reaches the version; an id that names no step refuses
`WORK_ITEM_UNKNOWN`. An agent session is
minted with `session.open` (capabilities scoped per kind family; the working
principal is the session id, never the opener).

## Wrapper (staffs the board)

```
node src/orchestrator/agent-wrapper-main.ts
```

Each pass: for every READY, unclaimed non-human step (code nodes first;
`approval.decide`, `goal.close`, and session plumbing skipped — these are the
human-only kinds, and `goal.close` in particular is never staffed because
closing a goal is a person's decision; capped by
`MOE_WRAPPER_MAX_AGENTS`, default 2)
it opens a scoped session, claims the item under the AGENT'S credential (the
claim's expiry is also the reap horizon), and spawns
`claude -p --setting-sources "" --disable-slash-commands --no-session-persistence
--strict-mcp-config --mcp-config <per-agent> ...` with the mission over stdin. Chain agents get MCP tools only;
code-node agents also get
Edit/Write/Read/Glob/Grep/Bash and run in their workspace. Knobs:
`MOE_WRAPPER_ONCE=1`, `MOE_WRAPPER_INTERVAL_MS` (15000), `MOE_AGENT_COMMAND`
(default `claude`), `MOE_NODE_LANDING` (git landing below; default on). A pass that staffs nothing says so
(`[wrapper] nothing to staff (surface SURFACE, active N)`). The per-agent MCP
config file lives in a wrapper-owned temp directory, is removed when that
agent exits, and the directory goes when the wrapper process does. The wrapper
also closes the durable scoped session after the child exits; expiry is the
fallback if cleanup cannot reach the daemon.

### Provider limits

A seat that exits NONZERO is classified from its OWN output: the last 40 lines are
scanned newest-first against a frozen roster of provider limit sentences
(`seat-exit-classifier.ts`). A match is read `PROVIDER_LIMIT` - the staffing attempt is
REFUNDED (the provider refused, not the item), the provider is parked until its reset,
and the claim is released and the scoped session closed exactly as for any other exit.
Anything else nonzero is `FAILED`; exit 0 is `COMPLETED` whatever it printed on the way.

| Provider | Sample line | Reset in the line | Captured from |
| --- | --- | --- | --- |
| claude | `You've hit your session limit · resets 12:10am Asia/Jerusalem` | yes: wall clock + zone, resolved to the NEXT such instant | live seat exit 1, 2026-09-03 |
| claude | `You've hit your usage limit · resets 12:10am (Asia/Jerusalem)` | yes: wall clock + zone | claude.exe 2.1.260 composer |
| claude | `You've hit your weekly limit · resets Sep 8, 10:46am (Asia/Jerusalem)` | yes: dated, not rolled forward | claude.exe 2.1.260 composer |
| claude | `Fast limit reached and temporarily disabled · resets in 5m` | NO - it carries a DURATION | claude.exe 2.1.260 `SDo()` |
| codex | `ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 8th, 2026 10:46 AM.` | yes: host-local clock, no zone | live `codex exec`, codex-cli 0.152.0 |

The separator in the claude samples is U+00B7 MIDDLE DOT, which is what the CLI composes
with - not a hyphen. When a line carries no readable instant, or one already past, the
pause is bounded by `DEFAULT_PROVIDER_PAUSE_MS` = 30 minutes. A second limit exit DURING a
live pause REUSES that pause's reset and never slides it forward, so a busy fleet cannot
park itself indefinitely.

Three lines say it, on the wrapper's own stdout:

```
[wrapper] provider limit: <provider> paused until <resetAt> (<seat's last line>)
[wrapper] provider limit: <provider> paused until <resetAt> (DEFAULT_PROVIDER_PAUSE_MS) (<seat's last line>)
[wrapper] provider paused: <provider> until <resetAt> (active N)
[wrapper] seat exit not recorded: <code>
```

The `(DEFAULT_PROVIDER_PAUSE_MS)` form appears only when the reset was bounded rather than
parsed. `provider paused:` is printed once per DISTINCT idle state, not once per pass.

In the browser the same pause shows in four places: the shell strip (`Agents paused:
<provider> limit, resumes <time>`), Seats (that sentence plus `- last line from the seat:
<line>`, or `(no output)`), Health (the `Agents` fact, `paused: <provider> limit, resumes
<time>`), and an opened goal's next step while it is WORKING (`Waiting for the provider
limit to reset at <time>`). `/health/read` carries it raw at `agents.paused`.

WHICH provider is parked comes from `MOE_AGENT_COMMAND`: `providerFor()` matches the
extension-stripped basename, and a command it does not recognise reads as `claude`.

The pause is a durable record on aggregate `provider-pause:<projectId>:<provider>`. NO
browser control clears it. The supported early clear is `clearProviderPause`
(`apps/daemon/src/orchestrator/provider-pause-ledger.ts`) run against the store: it writes a
pause whose reset is NOW - one event type and one read rule, not a second path - and the
wrapper staffs again on its next pass.

### Reclaim after a restart

A seat claims under its OWN credential and that secret dies with the wrapper's
child, so after a restart nothing -- you included -- could release what its dead
seats held. The 30-minute claim expiry was the only way out.

THE RULE: the daemon admits a `work.release` from a non-claimant only when the
holder has NO live session -- every session naming that principal closed,
expired, or absent. A LIVE holder is never overridden, and an unreadable session
ledger still refuses `WORK_CLAIM_NOT_CLAIMANT`. `work.renew` is unchanged.

THE PASS: the wrapper reclaims ONCE at boot, before its first staffing pass
(`MOE_WRAPPER_ONCE=1` runs it, then that one pass). For a recorded, never-retired
child whose pid is known AND dead it closes the seat's session, releases the
claim, then retires the record -- in that order, because the daemon refuses the
release while the session is open. A live child, an unknown pid or an unreadable
record is left untouched; a recycled pid reads alive and waits out the expiry.

```
[wrapper] reclaimed <item> from <session>
[wrapper] kept <item>: child alive
[wrapper] kept <item>: pid unknown
[wrapper] reclaim pass: <n> reclaimed, <m> kept
```

The summary prints even at zero, so "ran, found nothing" differs from "never
ran". The Seats screen needs no change: a reclaimed seat is a CLOSED session
with an empty `holding` -- already what it renders.

### Git landing (what happens to the files after acceptance)

Once the daemon accepts a node (its verifier receipt consumed by
`integration.accept_output`), the wrapper's LANDER commits what the seat changed
as ONE git commit on the workspace's current branch, authored `Moe <moe@moe.local>`,
and records a `moe-landing-receipt/1` beside the node. Nothing is pushed: the
commit sits in the operator's repository until publishing, which is a separate
human decision. The Runs screen (and the opened goal) shows
`landed as commit <sha> on <branch> · N files, local only`, or
`not landed in git: <code>`.

What the seat changed is measured, not trusted. The moment a `node.deliver` seat
is staffed the lander records a BASELINE of every dirty path in the workspace
with its blob id (`[lander] <node>: BASELINE_RECORDED (N dirty path(s) before
the seat)`); at landing it commits exactly the paths whose content differs from
that baseline, so the operator's own uncommitted work is never swept into a Moe
commit. `.moe-next/` and `.moe/` are never part of a landing. The commit stages
only those paths (`git add` + `git commit --only`), so other staged changes stay
staged; the repository's own hooks run.

One landing per acceptance: `[lander] <node>: COMMITTED (<sha> on <branch>, N
file(s))`, or `REFUSED (<code>: <detail>)` recorded durably and never retried —
`LANDING_BASELINE_MISSING` (the node was delivered without the wrapper staffing
it), `NOTHING_TO_COMMIT`, `NOT_A_REPOSITORY`, `GIT_COMMIT_FAILED` (git's own
words, e.g. a hook). A transient git failure (`GIT_FAILED`, e.g. a lock) is
only reported and retried next pass. `MOE_NODE_LANDING=0` turns landing off.

### Closing a goal (your decision, the daemon's evidence)

Closing is human-only and operator-only, like approval and publishing: the
wrapper skips `goal.close`, and it is never reachable over MCP. Needs you shows
a "Ready to close" card for a goal whose contract is fully verified, and its
Close control asks twice before it sends.

WHAT THE DAEMON REQUIRES. The browser sends only who declared the decision; the
daemon derives every witness from its own durable records. It OFFERS
`goal.close` only when the goal's approved Product Contract has every acceptance
criterion at VERIFIED on the coverage read (a goal with no contract — the seed
and Foundation journeys — is offered as it always was, since this gate has
nothing to say about it). When you spend that offer, the command additionally
requires, for each node the approval's scope names: a durable review acceptance,
the verifier receipt that acceptance names and still matching it, the node's
landing, and no activation still holding authority.

WHEN IT REFUSES, THE CARD SHOWS THE DAEMON'S CODE VERBATIM — search for it here.
All of these refuse at layer `DAEMON_PREREQUISITE`:

| Code | What it means |
| --- | --- |
| `GOAL_CLOSE_CRITERIA_UNVERIFIED` | the approved contract still has a criterion the coverage read does not call VERIFIED (or the coverage read could not be completed) |
| `GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED` | no durable review acceptance names an approved node |
| `GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT` | no verification receipt names the node |
| `GOAL_CLOSE_VERIFICATION_RECEIPT_AMBIGUOUS` | more than one receipt names it, so which one attests is unknown |
| `GOAL_CLOSE_VERIFICATION_RECEIPT_UNREADABLE` | the receipt exists but will not read back |
| `GOAL_CLOSE_VERIFICATION_NOT_PASSED` | the durable verification or landing evidence does not say the work passed |
| `GOAL_CLOSE_RESULT_DIGEST_MISMATCH` | the accepted result's digest does not match what was verified |
| `GOAL_CLOSE_REVIEW_PACKAGE_STALE` | a later review round or a re-plan supersedes the acceptance being relied on |
| `GOAL_CLOSE_AUTHORITY_REMAINS` | an activation still holds authority over a node of this goal |

ONE EARLIER GATE, WITH A GENERIC CODE. `goal.close` is a bootstrap-family
command, and the bootstrap sequence requires the project to have committed an
`approval.decide` before it will run any handler. A project whose goals were
approved only through the browser's `approval.decide_intent` path has no such
decision, so the answer is `BOOTSTRAP_PREREQUISITE_MISSING` @
`DAEMON_PREREQUISITE` — a code that names nothing about goals, because nothing
goal-specific has been consulted yet. If you see it on a goal whose criteria all
read VERIFIED, the goal is not the problem: the project has never committed an
`approval.decide`.

### Publishing (your decision, one remote for the project)

Landed commits stay in the workspace's repository until a human publishes them.

**The remote belongs to the PROJECT, and you name it once.** The first publish
binds it; every publish after that reuses it. There is no per-goal remote and
nothing is remembered in your browser.

A goal carries a PUBLISH card only once at least one of its nodes has LANDED as
a commit — with nothing to push there is no card at all. The card has one
control:

- **No remote bound yet** — it asks for the git remote once (an `https://` or
  ssh URL, no embedded credentials). Confirming binds that URL to the project
  and publishes to it.
- **A remote is bound** — it says `Publish to <remote>`, lists the landed
  commits it will push, and asks for nothing. Confirm and it goes.
- **Changing it** — `Change` on the card reveals the field again; the next
  publish rebinds the project to what you type. `Change` on Health says the same
  thing but does not rebind from there, because the binding is an effect of
  publishing.

Either way the browser spends the daemon's `repository.publish` offer for the
goal — a bootstrap-family, operator-only command never reachable over MCP — and
records the decision on the goal's publish aggregate. Nothing is pushed by the
browser or the daemon. On the wire a typed URL rides as `remoteUrl: <url>` and
means BIND-AND-PUSH; a reused one rides as `remoteUrl: null` and means "the
remote this project is already bound to". Publishing with nothing bound is
refused `PUBLISH_REMOTE_UNBOUND` at `DAEMON_PREREQUISITE`.

**Health shows the binding.** The Repository card on the Health screen states
the bound remote with who bound it and when, read from `POST
/repository/remote/read`, or says no remote is bound yet. Unbound is a state,
not an error.

The wrapper's PUBLISHER performs the push as the effect of that decision on its
next pass: `git push <remote> HEAD:refs/heads/<current branch>` in
`MOE_NODE_WORKSPACE`, then one `moe-publish-receipt/1` per decision —
`[publisher] <goal>: PUSHED (<sha> <branch> -> <remote> (<link>))` or
`REFUSED (GIT_PUSH_FAILED: <git's words>)`. A refused push is never retried
under the same decision; decide again to retry. The card reads the runs read's
`publish` state: waiting for the wrapper, pushed with the branch link (GitHub
remotes get a browse link), or refused with the code.

### Replan (when a review is exhausted)

After three unsuccessful review rounds the review kernel refuses every further
round and the node blocks on a human. Needs you offers the two answers
`escalation.decide` takes (its `decision` field):

- **Allow more attempts** (`ALLOW_MORE_ATTEMPTS`): the node returns to READY and
  agents may submit new rounds.
- **Replan from the findings** (`REPLAN`): the node is RETIRED. It takes no
  further round (`REVIEW_NODE_REPLANNED`), the surface shows it BLOCKED on
  `replan` and offers nothing for it, and the Runs screen says `Replanned`. The
  browser then creates a SUCCESSOR goal over the same PRD (`goal.create_with_source`;
  Gate 1 is keyed by the PRD content sha, so the approved contract carries over)
  whose instructions carry the retired node's findings. The wrapper hands a
  goal's instructions to the compiler mission between `<<<OPERATOR INSTRUCTIONS`
  markers, and the decomposition seat is told to plan a different decomposition
  under new node keys. The predecessor goal reads `Replanned` on its status
  strip; close it when the successor's work is verified.

### Verifier authority (why a delivered node can wait forever)

The wrapper's verifier pass runs `MOE_NODE_TEST_COMMAND` in `MOE_NODE_WORKSPACE`
for every node whose latest review round is clean, then records the receipt
that lets `integration.accept_output` mark it COMMITTED. It refuses
`VERIFICATION_AUTHORITY_UNAVAILABLE` (wrapper stdout only) unless the project's
policy aggregate carries two standing slices: `moe-verifier-policy/1` and
`moe-reviewer-calibration/1`. The demo seed installs both; a project registered
any other way does not have them, and its delivered nodes sit BLOCKED. The board
now names the absent slice on the step (`missing: verifier-policy` /
`verifier-calibration`); install them with two `policy.install` commands on the
project's policy aggregate at its current versions. The seed's builders
(`verifierPolicySlice`, `reviewerCalibrationSlice` in
`src/orchestrator/demo-seed-policy.ts`) are the declared defaults; a real
deployment installs its own slices at the same refs.

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

TWO APPROVAL MODES, both real:

- **Auto**: plain `pnpm seed` completes the whole chain, `approval.decide`
  included. The seed authenticates with `MOE_DAEMON_CREDENTIAL` — the operator's
  own secret — and an OPERATOR-authenticated `approval.decide` carries the
  daemon's server-assembled human-review witness, so the dispatch itself counts
  as the human review (`planning-services.ts`, `operatorReviewAuthority`).
  `MOE_APPROVAL_MODE=SPEED` + `MOE_SPEED_MODE_DELAY_MS=0` also still authorize
  the ungated path by policy, exactly as before; the decoder fails closed on
  anything else (`approval-policy-settings.ts`), and a stated positive delay
  stays DEFERRED — `approvalDelayDisposition` refuses rather than clamps, and no
  witness overrides that bound.
- **Human on the board**: `MOE_SEED_STOP_BEFORE_APPROVAL=1 pnpm seed` ends the
  chain at `plan.propose`, verifies `approval.decide` is READY on
  `/affordances/read`, and prints the handoff
  (`PENDING approval.decide@<runId> — approve it on the live board`). Open the
  live board and click Dispatch on the approval card: the click commits, the
  card moves to COMMITTED, and `node.deliver` appears. The witness travels only
  with the operator credential — a scoped agent session dispatching the same
  bytes still answers `APPROVAL_HUMAN_REVIEW_REQUIRED`, and an explicit
  `humanAuthorityGate` on the run outranks any click
  (`APPROVAL_HUMAN_AUTHORITY_REQUIRED` until its own GO is granted).

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
