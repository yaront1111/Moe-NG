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
HEAD sha of the bound checkout, and the provider row carries the version the
daemon read by running `<agent command> --version` on this host, shown on the
provider row as `claude --version` beside `2.1.263` -- and a receipt it cannot measure is
rendered `UNKNOWN` with its code and layer rather than filled in, so the cards
still block with their exact missing-authority reasons when a prerequisite
genuinely fails. Note the consequence: a host with no agent CLI on `PATH` now
refuses activation with `ACTIVATION_PROVIDER_UNMEASURED` instead of activating
against a provider nobody could reach. A CLI that runs but answers something the
daemon cannot parse as a version is recorded `UNKNOWN`, which is a reading taken,
not a gap.
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

## New product from PRD

In a paired project's Control Room, open **New product from a PRD**. Choose a
new or empty directory, enter the product name, and attach the PRD. **Create
product** writes the controlled TypeScript web/API/PostgreSQL scaffold at that
directory, makes the first scaffold commit, binds the repository to the project,
registers it in the manager catalog, and continues through activation to PRD goal
creation. Read the reported outcome: repository creation can succeed while a
later activation or goal step refuses, with its code and layer shown separately.

Leave the GitHub owner blank for a local-only repository. This browser-only path
was live-proven on 2026-09-06; live GitHub creation is deferred until the owner
supplies an account and visibility. No remote is requested by the local-only
path. If the optional GitHub step does not complete, keep the committed local
repository: a remote repository may already exist under the supplied account
even when the push failed. Check that account before retrying the GitHub step.

Do not repeat bootstrap over the populated directory: it refuses
`BOOTSTRAP_DIR_NOT_EMPTY`. Preserve the existing repository and read its receipt
before deciding how to continue; a missing receipt is not proof nothing was
created. Bootstrap creates the scaffold but does not start PostgreSQL or deploy
the product; use the generated README for its development commands.

## Releasing: the `gh` prerequisite and what its absence looks like

Gate 3 asks you whether the evidence is strong enough to expose the work to
users, and approving it opens a pull request. **The daemon opens that pull
request by spawning the GitHub CLI, so `gh` must be installed and authenticated
on the machine running the daemon** — not on the machine running the browser.
Check before you need it:

```
gh --version
gh auth status
```

`gh auth status` must show an active account for the host holding the remote,
and the token needs the `repo` scope.

**What you see when it is missing.** The release refuses
`RELEASE_PR_FAILED @ RUNNER_WORKSPACE`, and the Release card prints that code
verbatim beside the refusing layer. The daemon carries the CLI's own last stderr
line as the refusal detail, so the card tells you which of these happened rather
than making you guess: `gh` not installed at all (the spawn never starts), `gh`
installed but not logged in, or GitHub itself declining — for example
`head branch "main" is the same as base branch "main", cannot create a pull
request`. **A refused release is recorded, not lost:** the daemon writes a
REFUSED release receipt before it refuses, so the attempt and its code survive a
restart, and the goal stays in Needs you until a release actually succeeds.

Two things people mistake for a broken `gh`, both from earlier in the chain:

- `RELEASE_HEAD_CHANGED` — not a refusal code of its own; it arrives as the
  DETAIL of `RELEASE_PR_FAILED`. The branch the release would open a PR from is
  not on the remote at the approved sha. The daemon proves this with
  `git ls-remote --exit-code -- <remote> refs/heads/<branch>` before it spawns
  anything, so this refusal means the push has not happened or the branch moved.
  Publish the goal again, then release.
- `RELEASE_EVIDENCE_INCOMPLETE @ DAEMON_PREREQUISITE` — nothing to do with
  GitHub. Some acceptance criteria have no verified evidence; the detail names
  the criterion ids, and the card shows them under the UNKNOWN count. Fix the
  evidence, do not retry the release.

`RELEASE_REMOTE_MISSING @ PROJECT_REDUCER` is the third and last code: no remote
is bound to the project at all. Bind one, publish, then release.

## Deploying: binding a target and what each refusal means

A deploy takes a landed, published sha, builds an image from it, starts a
candidate container and probes it. It records exactly ONE receipt per decision —
`DEPLOYED` with the image digest and the url, or `REFUSED` with the tool's own
last stderr line — so an attempt survives a restart either way.

**Bind a target first.** `deployment.set_target` binds one target per
(project, environment): a network, an optional ssh target, and the url the
environment answers on. Until a target is bound the daemon offers no deploy at
all, and the Deployments card renders `DEPLOY_TARGET_MISSING` in words with a
control to set one — an absent card, not a dead button.

**Then deploy from the goal.** The Deployments card lists every environment with
its target, the last deploy's sha, time, url and status. The Deploy button ARMS
first and only the second click on the SAME row dispatches, so arming preview can
never fire production; the confirm names the environment it is about to deploy
to. A PRODUCTION deploy additionally states its release standing — it cites the
release decision id when the goal has a `RELEASED` receipt for that commit, and
says so plainly when it has none. That citation is real: the command handler
binds `releaseDecision` to the admitted goal and requested sha and reads the
release receipt (`deploy-command.ts`), so the line is produced by the product
rather than by a test double.

**Both deploy commands are the operator's, not an agent's and not the
browser's.** `deployment.set_target` and `deployment.deploy` require the
CONFIGURED operator principal. A paired browser session is a durable HUMAN
principal and is still refused `OPERATOR_PRINCIPAL_REQUIRED` at layer
`DAEMON_AUTHORIZATION`, and that refusal writes no receipt — nothing is
half-committed. Both kinds are also excluded from the MCP roster, so an agent
holding the operator bootstrap credential cannot reach them.

**The four refusal codes, and what to do about each.** All four are recorded on
a REFUSED receipt at layer `DAEMON_DEPLOY_ENGINE` and render verbatim on the
card:

- `DEPLOY_TARGET_MISSING` — no target is bound for that environment. Bind one;
  nothing was attempted.
- `DEPLOY_DOCKER_UNAVAILABLE` — the daemon could not talk to docker at all. The
  detail carries docker's own last stderr line. **Check with `docker version`,
  never `docker --version`**: the second only proves the CLI is installed, and
  an installed CLI with a stopped engine is the common case. Nothing was built
  and no container was started — the probe runs before anything else.
- `DEPLOY_BUILD_FAILED` — `docker build` refused, and the detail is docker's own
  last stderr line so the failure is diagnosable from the browser without
  shelling into the host.
- `DEPLOY_HEALTH_TIMEOUT` — the candidate started but never reported healthy
  inside the budget. The environment was left as it was; this is a candidate
  that failed its probe, not a half-replaced environment.

**Where the surfaces disagree, as of 2026-09-07.** The offer surface advertises
`deployment.deploy` as soon as a goal has a publish REQUEST, while
`/deployments/read` reports a deployable sha only once that publish has PUSHED.
On a project whose remote is unreachable you will therefore see the goal listed
in Needs you as ready to deploy while the card's buttons are disabled under
"Nothing is landed to deploy yet." That is not a broken card: publish the goal
to a reachable remote and the buttons enable.

**What has been driven, measured 2026-09-07.** Everything above, including the
container runtime. Two drives, and they prove different halves:

- **Over the command edge, with a FAKED container runtime**: a real daemon
  composed the deploy port, admitted the command, enforced the operator fence,
  wrote a durable `DEPLOYED` receipt, carried its verdict through
  `/activity/read`, and the browser rendered the receipt's url.
- **Against a REAL docker engine (2026-09-07, engine 29.6.2 linux/amd64)**: an
  image was built from the generated Dockerfile, a candidate container ran, and
  it answered `GET /health` with `200 {"status":"ok"}`. The proxy flipped to the
  candidate and the incumbent was stopped only afterwards. So **a container has
  now been started by this path** and the url served bytes.

**What is still NOT proven, stated rather than implied.** The live drive was
driven through the deploy service directly. The OPERATOR path — the same deploy
dispatched as a command from the goal — is refused on this host with
`BOOTSTRAP_PREREQUISITE_MISSING @ DAEMON_PREREQUISITE`, because
`deployment.deploy` requires a `repository.publish` whose effects are committed
and no goal here is publication-integrated yet. The engine is proven; the
goal-lineage gate in front of it is not. That drive also composed no `migrate`
port, so no migration ran, and the candidate started with **no environment
variables at all**: `docker run` is invoked with no `-e` and no `--env-file`, so
a product that needs a `DATABASE_URL` would fail its health probe and the
operator would read `DEPLOY_HEALTH_TIMEOUT` — a refusal naming HEALTH when the
real cause is CONFIGURATION. Supplying them is a separate row, now filed as
`task-0ca117e389df43ee9b458255f0752842` and re-measured on 2026-09-08 against a
candidate the deploy service itself started.

**What has been driven, measured 2026-09-08 (engine 29.6.2).** The whole chain,
end to end, on ONE product, with no double anywhere in it — scaffold, real
`docker compose` topology, real archive build from a real commit, variables
through the encrypted store, the real migration, deploy, and rollback. This
supersedes two claims in the 2026-09-07 paragraph above: **a `migrate` port WAS
composed and a real migration DID run** against the disposable PostgreSQL, and
the rollback is no longer unexercised. Both directions are proven by an HTTP
RESPONSE from the running environment rather than by a receipt: the deployed
build answers with its own marker, and after the rollback the PREVIOUS build's
marker answers. The rollback was dispatched through the control an operator
actually has — the `deployment.rollback` offer from `/affordances/read` and the
receipt the shared `resolveRollbackTarget` names — not from a test's own
variables. Reproduce with
`MOE_PLATFORM_PIPELINE=1 pnpm exec vitest run tests/e2e/foundation/platform-pipeline.e2e.test.ts --no-file-parallelism`.

**A ROLLBACK DOES NOT REVERT YOUR SCHEMA, and this is the sentence to read
twice.** The deploy engine runs its migration step on the rollback leg too, with
the previous sha, so the forward migration is re-attempted, finds nothing to
apply, and the schema is left exactly where the forward deploy put it. Measured
by querying `pg_tables` immediately before and after the rollback: the migrated
table is present both times. `migrate_down` is a separate operator action and
nothing on the rollback path invokes it. An operator who reads "rolled back" and
infers their schema moved with it will be wrong.

**A migration needs the product's workspace INSTALLED.** The migration tool is a
dependency of the generated product, so a freshly scaffolded or freshly cloned
tree cannot migrate until its workspace is installed. Today that failure arrives
as `DEPLOY_BUILD_FAILED` with a redacted detail, and underneath it
`MIGRATION_FAILED / MIGRATION_FILE_UNKNOWN` — a code naming a FILE when the real
cause is a missing TOOL. Filed as `task-61f826e50332498eaaaf44f2043845fc`.

**Nothing leaks when a deploy, a migration or a verifier fails.** Proven on the
failure paths specifically, with live resources enumerated by `docker ps`,
`docker network ls` and an OS port probe before and after each arm, because a
cleanup function that returned is not evidence:
`tests/e2e/foundation/platform-teardown-failure-paths.e2e.test.ts`.

**No variable value surfaces anywhere along the pipeline.** A canary planted
through the encrypted store is proven to have reached the deployed database
process — postgres authenticates a connection with it — and is then absent from
all 45 swept artifacts: both deploy receipts, both report details, the ledger,
the migration receipt, the probe response, the candidate's `docker inspect` and
logs, the proxy's Caddyfile after the flip, every generated infrastructure file
and every committed fixture. `.env` holds it and is not committed.
`tests/e2e/foundation/platform-secret-canary.e2e.test.ts`.

**These three live files publish the product's real ports (3000 and 5432), so
run them one at a time** — `--no-file-parallelism` — and only with
`MOE_PLATFORM_PIPELINE=1`. Without the flag they neither bind nor build, which
is why the shared root gate is unaffected by them.

**An environment can never be retired.** There is no destroy or teardown command
at any layer, and the health sweep takes its roster from the append-only deploy
ledger, so an environment whose containers you removed by hand is probed forever
and keeps recording DOWN. Filed as `task-de80c663569a4ab2b30a9db6ac526e4b`.

**The three days this cost, so nobody repeats it.** `DEPLOY_DOCKER_UNAVAILABLE`
collapses two different states: docker *not installed* (needs a host change) and
docker *installed with the engine stopped* (needs the application started, and
any seat can do it). Three seats over three days read the second as the first
and left the clause unmet. A refusal that names a transport — `npipe:…`, a
socket path — is evidence the CLI exists and could not reach a server, which is
much closer to "stopped" than to "absent". **Try starting Docker Desktop before
concluding the host lacks docker.**

## Migrations: the backup comes first, and what each refusal means

**A `pg_dump` runs BEFORE any migration, and a failed dump means NOTHING was
applied.** That ordering is the whole point of the feature: it is the only thing
standing between a bad migration and production data nobody can get back. If the
dump cannot be taken the run is refused with `MIGRATION_BACKUP_FAILED` and the
schema is left exactly as it was -- not "mostly applied", not "applied and then
rolled back". A migration that ran after a failed backup is the precise scenario
the receipt exists to make impossible.

**Where the backup lives.**
`<project>/.moe-next/backups/pre-migration/<environment>/<17-digit-timestamp>.sql`
-- the same `.moe-next/backups` root the activation receipts already use, not a
second location to search during an incident. The receipt carries the file's
**sha256**; it does NOT carry the path, and the path deliberately never leaves
the daemon module. The control room shows `Backup verified` plus the digest and
offers no link, no href and no download: a database dump is a reference you
quote to this runbook, never something a browser hands out.

**The receipt.** Every run records exactly one `moe-migration-receipt/1`:
`{version, projectId, requestId, receiptId, environment, sha, decidedAt,
applied[], backupRef, outcome, refusal}` with `outcome` one of `APPLIED`,
`REFUSED` or `REVERTED`. Read it back with `readMigrationReceipt(store,
projectId, requestId)`; its verdict is served verbatim through
`/activity/read`, so a refused migration reads differently from an applied one
in the decision feed.

**`backupRef` is NULLABLE, and a null backup is not a successful one.** A
`MIGRATION_BACKUP_FAILED` receipt carries `backupRef: null` and `applied: []`.
When `backupRef` IS present it is `<path>@sha256:<digest>`.

**`REFUSED` alone does not tell you the schema's physical state -- read the
code.** `MIGRATION_BACKUP_FAILED` means nothing ran. `MIGRATION_FAILED` means a
migration file threw, and its `detail` NAMES THE FAILING FILE. All nine codes
answer at layer `DAEMON_INGRESS`:

- `MIGRATION_BACKUP_FAILED` -- the dump could not be taken (or its directory is
  missing, is a symlink, or already holds that timestamp). Nothing was applied.
- `MIGRATION_FAILED` -- a migration threw; `detail` is the file. Whatever ran
  before it may have committed, which is why the backup is taken first.
- `MIGRATION_IN_PROGRESS` -- another run holds `.migration.lock`. Wait; do not
  delete the lock to force a second concurrent migration.
- `MIGRATION_RECEIPT_INVALID` / `MIGRATION_RECEIPT_CONFLICT` /
  `MIGRATION_RECEIPT_WRITE_FAILED` -- the record could not be decoded, collided
  with a different record under the same id, or could not be persisted.
- `MIGRATION_DOWN_BATCH_UNKNOWN` -- no such applied batch. **Nothing ran.**
- `MIGRATION_DOWN_NOT_LAST_BATCH` -- the named batch is not the tail. **Nothing
  ran**, checked before reverting rather than discovered half way.
- `MIGRATION_DOWN_FAILED` -- a `down()` actually failed part way. This is the
  one where the schema may now be in neither state, and it is the case the
  restore paragraph below exists for.

**`deployment.migrate_down` is HUMAN-ONLY.** It takes `{environment,
toMigrationRequestId}`, dumps the database first (same ordering, same backup
location), reverts the last batch, and records a `REVERTED` receipt -- or one of
the three `MIGRATION_DOWN_*` refusals above. Like the other deployment commands
it requires the CONFIGURED operator principal and is EXCLUDED from the MCP
roster, so no agent session can reach it, for a sharper reason than the deploy
fence: **reverting a production schema destroys the data the forward migration
created, and only a human can weigh that loss.** The database URL comes from a
per-environment host resolver configured on the daemon, never from the request
payload; an unconfigured daemon REFUSES with `MIGRATE_DOWN_UNCONFIGURED` at the
command seam rather than silently skipping the revert.

**When a down-migration cannot revert: restore the recorded backup.** This is
the paragraph you are reading during an incident, so these are the actual
commands. First choose the snapshot by its receipt, not by the newest filename:

- The failed **`deployment.migrate_down` receipt's `backupRef`** names the dump
  taken immediately BEFORE `down()`. Restoring it recovers the **migrated,
  pre-down state**, including the data present when that attempt began.
- The original **forward migration's APPLIED receipt's `backupRef`** names the
  dump taken BEFORE `up()`. Restoring that one returns the **pre-migration
  state**, discarding later changes. That is a different recovery decision,
  requiring explicit human approval of that data loss.

Both dumps live in `.moe-next/backups/pre-migration/<env>/`; the directory name
does not identify the recovery direction. Use the chosen receipt's exact path
and digest. If its `backupRef` is null, STOP: that receipt provides no backup.
Substitute the bracketed snapshot values below from that reference.

Find the digest and confirm the file has not changed since it was written:

```
sha256sum "<project>/.moe-next/backups/pre-migration/<env>/<ts>.sql"
# Windows: certutil -hashfile "<project>\.moe-next\backups\pre-migration\<env>\<ts>.sql" SHA256
```

It must equal the `sha256:` half of the receipt's `backupRef`. If it does not,
STOP -- you are about to restore a file that is not the one the receipt
describes.

**Before the destructive reset:** stop application writers, preserve the failed
database for investigation, and have the operator verify the selected receipt,
snapshot digest, environment, server/container and database together. Confirm
the approved loss of changes since that snapshot. Do not proceed on a mismatch
or an unverified backup. The confirmation below is required for either form.

Against a reachable database (Bash). Configure `<service>` using protected
PostgreSQL service/password files for the verified destination; never put a
connection string or password in shell history or command arguments:

```bash
read -r -p "Type RESTORE <env>/<database> to replace the public schema: " confirm
[ "$confirm" = "RESTORE <env>/<database>" ] || exit 1
psql "service=<service>" -X -q -v ON_ERROR_STOP=1 --single-transaction \
  -c "SET client_min_messages TO warning; DROP SCHEMA public CASCADE; CREATE SCHEMA public;" \
  -f "<project>/.moe-next/backups/pre-migration/<env>/<ts>.sql"
```

Against a database inside a container (Bash; the reset/restore sequence driven
on 2026-09-08). Use its already configured authentication, not a password argument:

```bash
read -r -p "Type RESTORE <env>/<database> to replace the public schema: " confirm
[ "$confirm" = "RESTORE <env>/<database>" ] || exit 1
docker exec -i <container> psql -X -q -U <user> -d <database> \
  -v ON_ERROR_STOP=1 --single-transaction \
  -c "SET client_min_messages TO warning; DROP SCHEMA public CASCADE; CREATE SCHEMA public;" \
  -f - < "<project>/.moe-next/backups/pre-migration/<env>/<ts>.sql"
```

Run ONE attempt and check its exit status; a nonzero exit is a failed restore,
not a reason to retry without these safeguards. The `-c` reset and `-f` dump
apply are in the SAME `--single-transaction`: `ON_ERROR_STOP=1` stops at a
failure and the transaction rolls back BOTH, rather than leaving a half-restored
schema. Resetting first avoids collisions with the still-migrated objects.
Keep `-f -` for the container's stdin dump so psql processes its meta-commands.
These flags and the reset match `apps/daemon/src/backups/backup-ports.ts`'s
`restoreIntoDatabase`; do not split the reset into a separate committed command.
`client_min_messages=warning` suppresses cascading-drop notices; `-X -q` avoids
startup-file effects and quiets routine output, but does not sanitize errors.
Do not paste raw diagnostics or dump contents into chat, logs or receipts.

**What has been driven, measured 2026-09-08.** Against a REAL disposable
PostgreSQL (`postgres:17-alpine`, engine 29.6.2 linux/amd64): a migration
created a table (`\dt` went from 2 relations to 3), the
`moe-migration-receipt/1` was read back from the store byte-equal to what the
call returned, the backup file was present at the path above and its sha256
RECOMPUTED ON DISK equalled the digest in the receipt, `DROP SCHEMA public
CASCADE` followed by restoring that dump returned the pre-migration schema at
column level, and the `MIGRATION_BACKUP_FAILED` path left the SCHEMA -- not just
the return value -- untouched. `MIGRATION_FAILED` named the failing file and
left `pgmigrations` holding only the initial migration. Re-run it yourself with
`MOE_MIGRATION_RESTORE=1` and the daemon package's own vitest config; the opt-in
performs real work and FAILS rather than skipping when docker is unavailable.

**What is NOT proven, stated rather than implied.** No preview environment
exists on this host: there is no environments store, and this project's
`.moe-next/backups` has no `pre-migration` leaf, so **no environment of this
project has ever been migrated**. The machinery above is verified against a
disposable database; applying it to a real preview environment waits on the
environments model and the deploy path, which are sibling work. The deploy drive
in the section above composed no `migrate` port, so **no migration has yet run
as part of a deploy** either.

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

#### Choosing the provider from the browser, and reading it back

`MOE_AGENT_COMMAND` is no longer the only way to pick a provider. The agent
provider is a DURABLE PROJECT SETTING (`project.set_agent_provider`), and a
paired operator sets it from **Health -> Seats**. The setting is
operator-fenced and MCP-excluded: an agent seat cannot change which provider
staffs the fleet, only a human at a paired browser can.

Seats then discloses, so a fleet is readable without reading the launcher's
console:

- **Per seat, what the WRAPPER measured at spawn** -- the provider and the agent
  CLI version, both named `...AtStart` because they are second-hand facts about
  the past, not a live probe. A seat that has never been measured says so in
  words rather than printing a bare `UNKNOWN`.
- **WHERE the credential comes from** -- a signed-in credential file on this
  host, or the NAME of the environment variable that carries it. **Never the
  value.** The screen builds that sentence only from a closed grammar over the
  daemon's credential ref, so a value substituted for the source renders as
  `RESOURCES_CREDENTIAL_SOURCE_UNRECOGNISED` instead of as itself.
- **When the chosen provider has NO credential**, the launcher's own
  `MOE_UP_ENV_MISSING` line above is repeated VERBATIM, naming every accepted
  variable and the sign-in path that was looked for. It is the launcher's single
  roster, carried through `/activation/read`, not a second copy in the browser.
- **`MOE_AGENT_COMMAND` when it is overriding the choice.** The environment wins
  at spawn, so the screen names the variable rather than silently flipping a
  label -- a browser choice that is being ignored is otherwise unreadable.

A seat keeps the provider it started under; the setting applies to the next one,
and Seats says so when a running seat disagrees with it.

**Measured 2026-09-07, and the remaining limit stated rather than implied:** the
toggle, the disclosure and the credential-source fence were driven against a REAL
daemon in the browser lane, and THE WRITE NOW COMPLETES: a paired operator clicks
`codex`, the envelope is built from the daemon's own offer, and the daemon
answers `AGENT_PROVIDER_SET`. The journey
(`tests/e2e/control-room/agent-provider-seats.spec.ts`) asserts that round trip
-- no refusal element, the toggle enabled, the configured provider reading
`codex` -- rather than the refusal code it pinned before task-136cbab2 landed.
THE FENCE IS NARROWED, NOT REMOVED. The kind stays in
`OPERATOR_PRINCIPAL_KINDS`; what was widened is one disjunct inside
`isDurableHumanPrincipal`, for this ONE kind, requiring `ADMIN`.

**Two independent layers refuse it, with DIFFERENT codes, and which one you see
tells you where you stopped.** `SETTINGS_FAMILY` binds the kind's required
capability to `ADMIN`, so `http-command-ingress.ts` answers
`CAPABILITY_DENIED @ AUTHORIZE` FIRST for any caller lacking `ADMIN` -- that
caller never reaches the operator fence, which is exactly why an HTTP-only test
stays green even with the `ADMIN` check deleted, and why the two layers are
pinned by separate arms. A caller that DOES hold `ADMIN` but is not a durably
paired HUMAN -- a non-human principal, say -- gets
`OPERATOR_PRINCIPAL_REQUIRED @ DAEMON_AUTHORIZATION` ("this command requires the
configured operator principal") at the handler seam instead. The gate is pairing
PLUS `ADMIN`, never `ADMIN` alone.
A **real `codex exec` binary HAS now delivered a node** (task-117a3cd9,
codex-cli 0.153.4): three `seat_start` rows reporting provider `codex`, the
`codex exec` argv captured from the OS while the process was alive, and lander
`COMMITTED` at `ca4abc80a37e80aff51f1600d58afffb6e57b818` on a fresh lane
project, with `MOE_AGENT_COMMAND` `<UNSET>` so the DURABLE SETTING chose it. The
quota-free path -- a SCRIPTED codex double over the real MCP wire -- still runs
offline in `pnpm test:e2e`. Not yet driven: a multi-node goal, or UnAI.

**If the toggle is greyed out with "cannot change the provider", read
`/affordances/read`, not the pairing.** The browser can only dispatch a kind the
daemon has OFFERED it: `commandBuilderFor` reads `commandId`, `expectedVersion`
and `targetAggregateId` off the affordance and refuses `INPUT_INVALID` without
one. `project.set_agent_provider` is minted by
`apps/daemon/src/http/affordance-agent-provider-offers.ts`, which withholds the
offer only when the setting's own scope check refuses -- so an absent offer means
`AGENT_PROVIDER_SCOPE_INVALID` or `AGENT_PROVIDER_STORE_UNREADABLE` on the
daemon, never an unpaired browser. Being registered, capability-bound and
MCP-excluded is NOT enough for a browser to reach a command; the offer is. And
the offer is not enough either: an `OPERATOR_PRINCIPAL_KINDS` member also needs
the principal fence widened, which is the second half described above.

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

### A landing that commits nothing, and releasing a checkout it wedged

A node can be accepted and still change no file — the work was already on HEAD,
or a dead earlier seat's files were committed by the attempt before it. The
lander refuses `NOTHING_TO_COMMIT` and records that refusal beside the node.

**What that does to checkout ownership now.** The refusal is decided BEFORE the
lander journals any landing intent, so nothing was written and nothing is owed:
the reservation on that checkout is RELEASED (`LANDED_NOTHING`), and the next
`node.deliver` on the same root claims it normally. You do nothing. A refusal
decided AFTER the intent is journaled — `GIT_COMMIT_FAILED` from a hook, for
instance — is the opposite case: git may already carry part of the landing, so
the reservation is BLOCKED and held on purpose.

**What a BLOCKED reservation means.** The record lives in
`<gitdir>/moe-repository-execution.sqlite` and SURVIVES A DAEMON RESTART —
restarting changes nothing. While it exists the execution port refuses every
effect family on that checkout, not just landing: publishing and criterion
verification are shut out too, and any other node asking for the root is refused
`REPOSITORY_EXECUTION_BUSY`. `BLOCKED` is terminal by design (its transition
list is empty), so nothing moves the reservation out of it — a release is the
only exit, and it is offered on evidence rather than taken by a phase change.

**Releasing a checkout wedged by an older daemon** (before the release above
existed, a `NOTHING_TO_COMMIT` refusal left the reservation BLOCKED forever):

1. Open the control room's **Health** screen and find the **Repository recovery**
   card. Each held reservation shows its node ref, its reservation revision and
   its phase.
2. Read the two actions. `Release unused reservation` (`ABORT_UNEXECUTED`) will
   be refused `REPOSITORY_RECOVERY_CONTAINMENT_UNKNOWN` here — the node did
   execute. The second action is the one that applies.
3. If the second action is refused rather than offered, the code under it says
   why, and `REPOSITORY_RECOVERY_CONTAINMENT_UNKNOWN` there means the daemon
   found a journaled landing intent: git may have run, so STOP. That checkout
   needs the landing reconciled, not released; do not work around it.
4. Type a reason (required, it is recorded with the decision) and press the
   second button. It is labelled `Reconcile completed landing` even when the
   landing committed nothing — the underlying action is `RECONCILE_LANDED`.
5. The daemon re-reads the durable evidence with the reservation still held and
   releases only if it still finds a refusal receipt with no journaled intent;
   the card then answers `Recovery decision recorded`. Refresh it: the
   reservation is gone.
6. Confirm from the repository side that the next node can own the root. The
   card lists no reservation for it, and the next `node.deliver` no longer
   answers `REPOSITORY_EXECUTION_BUSY`.

Recovery is human-only: the decision is taken either by the configured operator
principal itself or by a durably paired human principal, and an agent principal
is refused `REPOSITORY_RECOVERY_HUMAN_REQUIRED`.

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

### Environment variables (what is set, never what it is)

A goal carries an **Environments** section listing the three environments every
project has — `preview`, `production` and `verify`. That roster is closed: the
daemon refuses any other name `ENV_ENVIRONMENT_UNKNOWN` @ `SCOPE`. They exist
from the moment the project does, so you can set `preview` variables before
anything has ever been deployed.

**The required names come from the APPROVED CONTRACT, not from a config file.**
A Gate 1 deployment requirement may name the environment variables it needs
(`environmentVariableNames`); the union of those names, deduped and sorted, is
what the screen calls Required. A variable that is set but the contract does not
name is still listed, marked Extra — you should be able to see what is actually
in the environment. If the contract names nothing, or could not be read, the
unset-count card is ABSENT rather than reading zero.

**`N required variables unset for <environment>`** is the card, one per
environment, linking down to the table. It is what stops a deploy failing for a
reason nobody can see. It names the environment because `preview` and
`production` are different facts and fixing the wrong one is easy.

**A VALUE IS NEVER READABLE BACK. Not by you, not by the screen, not by any
read.** `POST /environments/read` answers four fields per variable — `name`,
`isSet`, `fingerprintSha256`, `updatedAt` — and there is no field a value could
occupy. The store seals each value under a key derived from the daemon's own
credential and drops the plaintext after fingerprinting it. Read this sentence
before you type a secret into a browser: **if you lose the value, it is gone,
and the only thing you can do is set it again.**

**The fingerprint is your only confirmation an update took.** It is the full
sha256 of the stored bytes, and the screen shows the first 12 characters of it
labelled `sha256 fingerprint`. It is NOT a truncated value and no part of your
secret is in it. Set a variable, watch the fingerprint change, and that is the
update landing — there is nothing else to check, which is why it is rendered at
all. A variable that is not set shows `Not set` rather than an empty
fingerprint.

**Typing one.** `Set` (or `Replace` on a variable that is already set) opens one
field, `type="password"` and `autocomplete="off"` so a password manager does not
capture it. The browser spends `environment.set_variable`; `Unset` spends
`environment.unset_variable`. Both are operator-only and never reachable over
MCP. **The screen never echoes the value back — including after a refusal.** A
rejected submit clears the field, so correcting a typo means typing the whole
value again; that is deliberate, because a repopulated field is how a secret
ends up in a screenshot.

The four refusals, each at the layer that answered:

| Code | Layer | What to do |
| --- | --- | --- |
| `ENV_ENVIRONMENT_UNKNOWN` | `SCOPE` | Pick one of `preview`, `production`, `verify`. |
| `ENV_NAME_INVALID` | `NAME` | Names are an uppercase letter, then uppercase letters, digits or underscores. |
| `ENV_VALUE_TOO_LARGE` | `VALUE` | The value must be under 4096 bytes. The daemon never states your value or its size. |
| `ENV_STORE_KEY_UNAVAILABLE` | `KEY` | The daemon could not derive its store key. Check the daemon credential is set, restart it, and try again — nothing was stored. |

None of these messages contains what you submitted. The daemon's refusal details
are fixed prose keyed by code and are asserted to contain no digits at all, so
an interpolated `value X is too large` cannot creep in; the limit above is
stated by the browser from a constant.

**Writing needs the configured operator principal — a paired browser cannot.**
Both kinds sit in `OPERATOR_PRINCIPAL_KINDS`, and unlike `repository.publish`
they are NOT in the widening that lets a paired browser session act. A paired
session holds ADMIN, so it READS the table fine; a `Set` or `Unset` from it is
refused `OPERATOR_PRINCIPAL_REQUIRED` @ `DAEMON_AUTHORIZATION` and the screen
says so in those words. Set variables from the daemon host. The fence is
deliberate — an agent that could write a variable could write one the deploy
then delivers to a production process — and widening it to paired humans is an
authority decision nobody has taken yet.

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

### A fresh product, from the browser, and the three steps that are not

Measured 2026-09-09 by `tests/e2e/control-room/live-proof-prd.spec.ts`, which
drives a product that did not exist when the run started from the New product
form to a real pull request. The browser reaches: `repository.bootstrap`, the
activation chain, Gate 1 (including `product_contract.answer_clarification`),
`design.submit`, `planning.submit_decomposition`, the plan gate
(`approval.decide_intent`) and Gate 3 (`release.decide`, which admits a paired
ADMIN through `releaseByPairedAdmin`). Three steps are NOT the browser's and an
operator has to take them:

| Step | Why | What refuses without it |
| --- | --- | --- |
| Install `moe-verifier-policy/1` and `moe-reviewer-calibration/1` | No screen installs them; see *Verifier authority* above | wrapper prints "standing authority incomplete"; no node is ever accepted |
| Approve each criterion CHECK | Needs a durable HUMAN principal, and no criterion-approval surface ships | `CRITERION_CHECK_HUMAN_REQUIRED @ CRITERION_EVIDENCE` on the operator wire |
| Preview and deploy | Both run the product on the daemon's own host and are operator-only by design | `OPERATOR_PRINCIPAL_REQUIRED @ DAEMON_AUTHORIZATION` |
| Stand the preview environment UP (`docker compose`) | A deploy is an UPDATE: `deploy-service.ts` discovers a container labelled `com.docker.compose.service=proxy` on the target network, reads its Caddyfile and flips the upstream to the candidate. No command kind brings an environment up | `DEPLOY_BUILD_FAILED / DEPLOY_PROXY_MISSING_OR_AMBIGUOUS`, and `DEPLOY_PROXY_INCUMBENT_MISSING` when the config's upstream resolves to no container |
| Install the product's own dependencies | `deployment.deploy` runs the PRODUCT's migration, and `migration-ports.ts` resolves `node-pg-migrate` from the product workspace | the deploy refuses with the migration's own `MIGRATION_TOOL_MISSING` in its detail |

The proxy's Caddyfile must match the generated one byte for byte after the
upstream is normalised, or the deploy refuses `DEPLOY_PROXY_CONFIG_UNSUPPORTED`:
only the generated topology is the engine's to flip. `deployment.deploy` also
requires a COMMITTED `repository.publish` decision, so a deploy can only follow
Gate 3.

`policy.validate` IS now driven by the browser's activation chain (added
2026-09-09). Without it `approval.decide_intent` refuses
`APPROVAL_INTENT_POLICY_REF_UNAVAILABLE @ DAEMON_APPROVAL_INTENT`, because it
derives its policy ref from the newest replay-verified `PolicyEvaluated` and
nothing else writes that row.

`repository.recover` IS A HUMAN'S KIND, NOT AN OPERATOR-ONLY ONE, and the
distinction matters after a crash. It requires `project.admin` AND a durable
HUMAN principal, and it REFUSES the MCP, wrapper and verifier transports
(`repository-recovery-command.ts:20-25`) — so no agent seat can take it and the
paired browser ADMIN can. It releases a wedged repository reservation with a
proof: `ABORT_UNEXECUTED` for a reservation that never executed, or
`RECONCILE_LANDED` for one whose durable evidence proves Git already committed.
Measured 2026-09-09 on a real crashed landing: the Health screen's **Repository
recovery** card offered `RECONCILE_LANDED` and refused `ABORT_UNEXECUTED` with
`REPOSITORY_RECOVERY_CONTAINMENT_UNKNOWN`, one click reconciled the landing, and
the reservation left the view. `qualification.replan` opens a successor run when
a review has exhausted its attempts (see *Replan*). `session.renew` extends a
minted session without re-pairing.

### The landing crash knob (DEVELOPMENT ONLY)

`apps/daemon/src/orchestrator/landing-fault-injection.ts` kills the process
performing a landing write at a NAMED point, which is the only way to reach the
window between the Git effect and the completion that records it. It is off in
every normal run and refuses with a stable code:

| Environment | Effect |
| --- | --- |
| nothing set | `FAULT_INJECTION_DISARMED` |
| `MOE_FAULT_INJECT_LANDING=<point>` without `MOE_DEVELOPMENT_ONLY=1` | `FAULT_INJECTION_NOT_DEVELOPMENT` (the development fence answers FIRST, so an unarmed caller learns nothing about which names exist) |
| both set, unknown point | `FAULT_INJECTION_POINT_UNKNOWN` |
| both set, known point | SIGKILL at that point, after a synchronous note on fd 2 |

The points are `before-intent`, `after-intent`, `after-commit` and
`after-completion`. ONLY `after-completion` HAS A RECOVERY: the other three leave
the journal unable to prove what Git did, so the reservation stays contained —
`before-intent` reads `REPOSITORY_RECOVERY_EVIDENCE_MISSING` and `after-commit`
reads `REPOSITORY_RECOVERY_CONTAINMENT_UNKNOWN`. That is fail-closed by design;
an operator whose daemon died at one of those points has a held checkout and no
button, which is the honest state of the product today. `MOE_DEVELOPMENT_ONLY=1`
must never be set on a daemon that matters.

### Nodes of one goal deliver ONE AT A TIME

The delivery coordinator admits exactly one checkout owner per repository root.
While one node holds the reservation — from staffing until its landing commits —
every other node of that goal is refused
`REPOSITORY_EXECUTION_BUSY (REPOSITORY_DELIVERY)` on each wrapper pass. So
"independent nodes are staffed in parallel" means they are CLAIMED and ATTEMPTED
in the same pass; their commits are serialized. Raising
`MOE_WRAPPER_MAX_AGENTS` does not change this and never will: the fence is the
repository, not the seat count. A driver that waits for every seat to report
before recording any review round therefore DEADLOCKS — the first node holds the
checkout waiting for a round that is waiting for the second node.

### Human-only kinds (the MCP-excluded roster)

`OPERATOR_PRINCIPAL_KINDS` in `apps/daemon/src/daemon-command-vocabulary.ts` is
the single source; `mcp-tool-allowlist.js` DERIVES the MCP exclusion from it, so
a kind added there is removed from the advertised MCP surface by construction.
As of 2026-09-09 it holds 28 kinds:

```
approval.decide                  approval.decide_intent
criterion_check.approve          criterion_check.verify
cutover.activate                 deployment.deploy
deployment.migrate_down          deployment.rollback
deployment.set_target            environment.set_variable
environment.unset_variable       goal.close
graph.approve                    graph.supersede
integration.accept_output        monitoring.retire_environment
monitoring.set_probe_interval    preview.decide
preview.start                    product_contract.answer_clarification
product_contract.sync_env_example project.set_agent_provider
release.decide                   repository.bootstrap
repository.publish               repository.recover
resource.confirm_released        session.open
```

Membership is what removes a kind from MCP. It is NOT always what fences its
dispatch: kinds served from ASYNC entries (`deployment.deploy`, `preview.start`,
`release.decide`) never reach the registry's synchronous operator check, so each
of those handlers fences itself at entry — and `release.decide`'s own fence
deliberately admits a paired ADMIN human, which is why Gate 3 is browser-driven
while preview and deploy are not.

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

SENDING THE PLAN BACK, from the same gate. The plan gate offers two decisions over
the ONE `approval.decide_intent` offer the daemon minted for the run: **Approve
plan**, and **Send the plan back**, which requires a reason and stays disabled
until one is typed (whitespace does not count). Both spend the same grant and
differ only in the payload's `decision` and `decisionReason`; the browser composes
no authority, and a reason travels VERBATIM because the daemon fences it into the
successor's compiler mission (`rejection-instructions.ts`). A reject with no reason
is refused `APPROVAL_REJECT_REASON_REQUIRED` at `APPROVAL_INTENT_REJECTION` and
the code is rendered on the gate unchanged.

After a reject the daemon binds the goal to a SUCCESSOR run and offers
`planning.submit_decomposition` instead of an approval, so the browser stops acting
on the run you sent back: the goal's `planningRunRef` is IMMUTABLE and still names
it, and the gate resolves the current run by inverting the surface's
`planningGoalRefs` (`plan-run-resolution.ts`). While the successor compiles the gate
reads *Plan sent back - waiting for a new plan* and offers no decision, the goal's
status strip reads **Plan sent back** with the next step *Waiting for a new plan*,
and Needs you lists a **PLAN_REJECTED** item that CLEARS on the same frame that
offers the successor for approval. The decision feed shows *rejected the plan* with
a bad tone. Acting on the run you rejected would be refused
`APPROVAL_RUN_NOT_REVIEWABLE` @ `APPROVAL_RUN_BINDING`, which is the fence the gate
exists to keep you away from.

The rejection REASON is not read back into the browser today: `/activity/read`
entries carry a verdict word (`REJECT`) and no reason field, so the surfaces above
name the re-plan without quoting your text. The reason is committed and reaches the
successor's agent; only the read-back is missing.

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
