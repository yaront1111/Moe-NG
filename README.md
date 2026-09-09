# Moe Next

Moe is a trustworthy autonomous software company: give it a PRD, and it
designs, builds, verifies, deploys, and improves the product — from PRD to
production, with a trace that survives an adversary. The local-first
orchestration control plane, the authority system, and the evidence model in
this repository are the engine that makes that promise provable; they are not
the promise. The vision, the human gates, and the staged roadmap live in
[docs/VISION.md](./docs/VISION.md).

This repository is independent from legacy Moe. Legacy implementation code is not copied or imported.

Implementation modules stay deliberately focused; see [CONTRIBUTING.md](./CONTRIBUTING.md) for the split-review guardrail. Durable project policy lives in [AGENTS.md](./AGENTS.md).

## What runs today

The loop the vision describes runs, on a real project, with real agents: a PRD
dropped in the browser becomes a Product Contract a planning agent proposes and a
human approves (Gate 1), a decomposition the daemon compiles and a human approves
- or sends back with a reason, which re-plans it into a successor run the gate
then follows - at the plan gate, code a coding agent writes in the project's
repository, a
verification the daemon runs itself, and a local git commit of exactly the
files that delivery changed. This was live-proven on 2026-09-02/03 on a real
TypeScript project with real `claude -p` seats (the first proof of the
bootstrap chain alone dates from 2026-08-09/10). That is operational evidence,
not a release or security-boundary claim; see
[docs/agent-stack-runbook.md](./docs/agent-stack-runbook.md) for the exact
entry points, environment, and knobs.

- **Fresh start, from the browser alone**: the Activate project card reads the
  daemon's measured activation receipts and drives `project.register`,
  `project.bind_repository`, `provider.probe` and `project.activate` from one
  button, after which New goal is enabled. No seed script and no wrapper pass are
  needed to take an empty store to a created goal. Every receipt is minted by the
  daemon from a fact it measured itself -- the repository's real HEAD sha, the
  store's own driver, the backup's sha256, and the agent CLI's version read by
  running `<agent command> --version` on the host. Unmeasurable receipts stay
  `UNKNOWN` with their code and layer, an agent CLI that is not installed refuses
  activation outright, and the card never fabricates one.
  The New product from a PRD form also creates a new local repository, makes
  exactly one scaffold commit, binds and catalogs it, then creates the PRD-bound
  goal. This unseeded browser path was measured on 2026-09-06. GitHub is optional;
  remote creation was not live-proven because no owner or visibility was supplied.
  The chain drives SIX commands, not five: `policy.validate` was added on
  2026-09-09 because without it a browser-bootstrapped product could activate,
  compile a plan and then never approve it — `approval.decide_intent`, the only
  approval wire a paired durable human may ride, derives its policy ref from the
  newest replay-verified `PolicyEvaluated`, and nothing else writes that row. The
  refusal was `APPROVAL_INTENT_POLICY_REF_UNAVAILABLE @ DAEMON_APPROVAL_INTENT`.
  The added slice grants nothing: no rules, no auto-approval opt-ins.

- **A fresh product, end to end, as of 2026-09-09**: one drive takes a recorded
  PRD from that same form to a real pull request —
  <https://github.com/yaront1111/moe-live-proof-161b7e9d/pull/5> at sha
  `d30f9094a931d4789bcbf50996748b1c3e4c741e`, whose body is the dossier with a
  row for every one of the PRD's eight acceptance criteria. In between: Gate 1
  with a material clarification answered by click, a design revision, a compiled
  three-node plan, the plan gate taken by click, three nodes written by REAL
  provider seats and landed by the real wrapper and lander at three distinct
  shas, and 8/8 criteria VERIFIED by the contained criterion evidence service —
  counted against the approved contract's own roster and against
  `/documents/coverage/read`, so a dossier that dropped a criterion could not
  report itself complete. The drive is
  `tests/e2e/control-room/live-proof-prd.spec.ts`; the pull-request leg is opt-in
  on `MOE_LIVE_RELEASE_PR=1` and records its own absence when unset.

- **A forced crash mid-write, and the recovery a human takes in the browser, as
  of 2026-09-09**: the same drive arms the development-only knob
  `MOE_FAULT_INJECT_LANDING` at `after-completion`, so the process performing the
  landing SIGKILLs itself in the window between the durable landing completion
  and the receipt that records the outcome. After the restart the reservation is
  BLOCKED and the shipped repository-recovery card offers exactly one action —
  `RECONCILE_LANDED`, with `ABORT_UNEXECUTED` refused
  `REPOSITORY_RECOVERY_CONTAINMENT_UNKNOWN` beside it — and a click takes it.
  `repository.recover` requires a durable human with `project.admin` and refuses
  the MCP, wrapper and verifier transports, so no agent seat can take that step.
  The store then shows EXACTLY ONE landing outcome for that node, no doubled row
  anywhere in the landing journal, and both remaining nodes landing after the
  crash instant. The knob is off unless `MOE_DEVELOPMENT_ONLY=1` and a named
  point are BOTH set, and refuses with a stable code otherwise.

- **A preview environment, deployed, with its migration, as of 2026-09-09**: past
  Gate 3 the same drive binds a deploy target, writes two environment variables
  (read back only as sha256 fingerprints — the value never returns), and runs a
  REAL `deployment.deploy`: `git archive <sha>` into `docker build`, a candidate
  container, docker's own health verdict, and the Caddy proxy flipped to it.
  Health is asked three ways, the last being `GET /health` on the receipt's own
  URL from the host, through the proxy, answering `{"product":true,"status":"UP"}`.
  The deploy runs the PRODUCT'S OWN migration, keyed by the deploy decision:
  receipt `APPLIED`, both migration files named, a pre-migration `pg_dump` backup
  referenced by path and sha256, and PostgreSQL itself asked what happened
  (`pg_constraint` and the tool's own `pgmigrations` ledger). Two steps in that
  paragraph are the OPERATOR'S and are not the product's: bringing the
  environment up with `docker compose`, and installing the product's declared
  dependencies.

- **PRD lane**: `goal.create_with_source` binds a PRD to a goal; a planning
  agent reads it (paged) and proposes a versioned Product Contract with
  requirements and falsifiable criteria, asking the human only material
  clarifications; the human approves at Gate 1; a second planning run submits
  the decomposition the daemon compiles into a sealed plan; the human approves
  the plan; the PRD coverage read joins every criterion to the node that
  verified it. Two goals over the same PRD share the approved contract. That
  one plan approval seals the WHOLE dependency graph, not a single node: an
  initial run admits N nodes, independent nodes are staffed in parallel up to
  the configured seat limit, and a node stays BLOCKED — naming each producer as
  `depends:<nodeKey>` — until every HARD dependency it declares has been
  accepted. Growth therefore happens inside one goal; replanning into a
  successor goal remains the path for a review that has exhausted its attempts,
  not the path for adding work.
- **Design step** ([VISION.md](./docs/VISION.md) journey item 4, UX and
  architecture): running as of 2026-09-06. After Gate 1 approves the contract, a
  design revision — screens, data model, API surface, components, non-functional
  decisions — is submitted against it and the operator reads it on the goal, with
  the version named on the plan-approval fold, so approving a plan states which
  design that plan was compiled against. A goal planned without a design says so
  in words rather than showing an empty section. Resubmitting bumps the version
  and the superseded revision stays readable.
- **Daemon** (`apps/daemon`): loopback HTTP ingress serving `/command`, the
  event stream, the affordance surface, and the operator's reads (goals, goal
  source, planning run, product-contract gate, document coverage, runs, policy,
  health, activity, sessions). Boots fail-closed on a fresh SQLite store, mints
  the genesis recovery binding, and refuses unauthenticated, cross-origin,
  stale-protocol, or malformed requests with stable reason codes from the
  runtime error registry.
- **Scoped MCP surface**: the standalone stdio entry is
  `apps/daemon/src/mcp-main.ts`; the wrapper uses one trusted loopback HTTP host
  and per-agent bearer credentials. A seat reads the PRD by page and the
  approved contract by id; the human-only kinds (approvals, clarification
  answers, goal closure, publishing, cutover) are never reachable over MCP.
- **Wrapper** (`apps/daemon/src/orchestrator/agent-wrapper-main.ts`): staffs
  READY, unclaimed non-human steps (planning and coding) with a scoped agent
  session and a real `claude -p` process authenticated with the operator's own
  `claude` sign-in (or an exported API key; a `codex` seat is the same
  contract). A daemon-side verifier reruns the node's test before acceptance;
  the lander then commits exactly the paths the seat changed, on the
  workspace's current branch, and the publisher pushes only when a human
  decides to publish — to the one git remote the project is bound to, named
  once by a human on the first publish and reused, never typed again.
- **Review loop**: three unsuccessful review rounds block a node on a human,
  who either allows more attempts or replans the work into a successor goal
  that carries the findings.
- **Goal closure**: a goal is closed by a human, never by an agent, and the
  daemon derives every witness from its own records rather than trusting the
  browser. It offers `goal.close` only once every approved acceptance criterion
  of the goal's Product Contract reads VERIFIED on the coverage read; the
  command then additionally requires, for each approved node, a durable review
  acceptance, the verifier receipt that acceptance names, and the node's
  landing, plus no activation still holding authority. A goal that does not
  qualify is refused at the daemon's own code — the `GOAL_CLOSE_*` family
  (`GOAL_CLOSE_CRITERIA_UNVERIFIED`, `GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED`,
  `GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT`,
  `GOAL_CLOSE_VERIFICATION_RECEIPT_AMBIGUOUS`,
  `GOAL_CLOSE_VERIFICATION_RECEIPT_UNREADABLE`,
  `GOAL_CLOSE_VERIFICATION_NOT_PASSED`, `GOAL_CLOSE_RESULT_DIGEST_MISMATCH`,
  `GOAL_CLOSE_REVIEW_PACKAGE_STALE`, `GOAL_CLOSE_AUTHORITY_REMAINS`), all at
  layer `DAEMON_PREREQUISITE` and all rendered verbatim on the card, so the
  reason is searchable rather than a shrug. `goal.close` also sits behind the
  bootstrap sequence, which requires the project to have committed an
  `approval.decide`; a project approved only through the browser's
  `approval.decide_intent` path is refused the generic
  `BOOTSTRAP_PREREQUISITE_MISSING` before any of the codes above can speak.
- **Control room** (`apps/control-room`): the operating surface. Goals with
  progress from coverage; an opened goal that opens on a board: where it
  stands and what to do next, its nodes in six columns (queued, working, in
  review, rework, done, blocked) with one fact per card, and the decisions
  taken down the right; Needs you (Gate 1, plan approval, exhausted reviews, goals ready
  to close); Runs with per-node review rounds, verifier receipts and landings;
  Policy (the standard verifier slices install from the browser); Health,
  Activity and Seats. Packaged Windows runs serve it from the manager or the
  selected project's own loopback daemon and attach through a one-use pairing
  ticket; the Vite proxy remains a development path. Every offer the daemon
  states dispatches from its card, refusals render verbatim, and cards move
  only when the ledger does. Frozen fixtures are available only from the Vite
  development server behind `?fixtures=1`.

- **Deploying an environment** (VISION Stage 2, the deployment item only): a
  target is bound per (project, environment) with `deployment.set_target`, and
  `deployment.deploy` builds an image from a landed sha, starts a candidate,
  probes it and records ONE receipt -- `DEPLOYED` with the image digest and the
  url, or `REFUSED` with the tool's own last stderr line. The Deployments card
  renders that receipt per environment and arms before it confirms; Needs you
  lists a goal the daemon offers a deploy for and stops listing it once a
  `DEPLOYED` receipt exists; Runs distinguishes a refused deploy from a
  successful one rather than reading both as "deployed". Both deploy commands
  are reserved to the CONFIGURED operator principal: a paired browser is a
  durable human and is still refused `OPERATOR_PRINCIPAL_REQUIRED @
  DAEMON_AUTHORIZATION`, and the refused dispatch writes no receipt.
  **Measured 2026-09-07, and the limits stated rather than implied**: the
  machinery above was driven against a REAL daemon -- composition, admission,
  the operator fence, the durable receipt, `/activity/read` carrying its verdict
  and the browser rendering the url -- with a faked container runtime. **A
  separate drive on the same day used a REAL docker engine (29.6.2
  linux/amd64)**: an image was built from the generated Dockerfile, a candidate
  container ran, `GET /health` answered `200 {"status":"ok"}`, the proxy flipped
  to the candidate and the incumbent was stopped only afterwards. A container
  has been started and the url served bytes. **What that drive does NOT prove**:
  it went through the deploy service directly, so the OPERATOR path -- the same
  deploy dispatched as a command from the goal -- is still unproven. It is
  refused here with `BOOTSTRAP_PREREQUISITE_MISSING @ DAEMON_PREREQUISITE`:
  `deployment.deploy` requires a `repository.publish` whose effects are
  committed, and no goal here is publication-integrated yet. It also composed no
  migration port, and the candidate ran with **no environment variables**, which
  a product needing a database would experience as a health timeout rather than
  as the configuration error it is. The other Stage 2 items (infrastructure
  generation, monitoring, backup and rollback) are NOT claimed here; database
  migrations are claimed only to the extent the next bullet states.

- **Database migrations** (VISION Stage 2, the migrations item only): a
  `pg_dump` is taken BEFORE any migration runs, and a failed dump refuses the
  whole run with `MIGRATION_BACKUP_FAILED @ DAEMON_INGRESS` leaving the schema
  untouched -- nothing is applied after a backup that did not succeed. The dump
  lands at
  `<project>/.moe-next/backups/pre-migration/<env>/<timestamp>.sql`, reusing the
  existing `.moe-next/backups` root rather than inventing a second location, and
  every run records one `moe-migration-receipt/1` carrying `{environment, sha,
  applied[], backupRef, outcome}` with `outcome` `APPLIED`, `REFUSED(code)` or
  `REVERTED`. `backupRef` is nullable and carries the backup's **sha256, never
  its path** -- the path stays inside the daemon module, and the Deployments
  card renders the digest as a reference with no link and no download.
  `deployment.migrate_down` reverts the last batch, is reserved to the
  CONFIGURED operator principal and is EXCLUDED from the MCP roster, because
  reverting a production schema destroys the data the forward migration created
  and is never an agent's decision. **Measured 2026-09-08 against a real
  disposable PostgreSQL** (`postgres:17-alpine`, engine 29.6.2): a migration
  created a table, the receipt was read back from the store byte-equal to the
  call's return, the backup's sha256 recomputed on disk equalled the digest in
  the receipt, and `DROP SCHEMA public CASCADE` followed by restoring that dump
  returned the pre-migration schema at column level -- the restore path is
  exercised, not assumed. **What that does NOT prove**: no preview environment
  exists on this host (no environments store, and no `pre-migration` leaf under
  this project's `.moe-next/backups`), so **no environment of this project has
  ever been migrated**, and the deploy drive composed no migration port, so no
  migration has yet run as part of a deploy. Both wait on sibling work.

- **Packages**: `contracts` (dependency-free types, limits, codecs), `core`,
  `scheduler` (zero-authority structural preview), `store` (durable event and
  decision storage, subscriptions, snapshots, recovery), `runner`,
  `coordination`, `review`, `context`, `mcp`, `import` (deterministic read-only
  legacy import), `control-room-client` / `control-room-model`, `skills`,
  `benchmark` (DEVELOPMENT_ONLY, parked to v0.2), `testkit` (DEVELOPMENT_ONLY /
  NOT_CONFIRMATORY references). Adapters under `adapters/` (IDE contract,
  JetBrains) are integration boundaries; IDE/portability work is parked to v0.2
  under the 2026-08-18 scope freeze.

Authority, persistence, provider effects, and presentation stay separated;
missing or unverifiable evidence is `UNKNOWN` and gains no authority.

## What this is not

Nothing here is a readiness, GA, or comparative claim. The clauses below were
re-measured on 2026-09-09 and are stated first, because the older text around
them reasons from the state before that run.

A DEPLOY IS AN UPDATE TO A RUNNING ENVIRONMENT, AND NOTHING IN MOE BRINGS ONE UP.
`deployment.deploy` discovers a container labelled
`com.docker.compose.service=proxy` on the target network, reads its Caddyfile and
flips the upstream to the candidate it built and proved healthy; with no such
environment it refuses `DEPLOY_BUILD_FAILED / DEPLOY_PROXY_MISSING_OR_AMBIGUOUS`.
The generated infrastructure (`docker-compose.override.yml`, `docker/Caddyfile`)
exists for exactly this, but `planDeploymentInfrastructure` still has NO caller —
no command kind emits it — so a product's first environment is stood up by an
operator with `docker compose`, and the product's own dependencies are installed
by an operator too, because the deploy runs the PRODUCT's migration and resolves
`node-pg-migrate` from the product's workspace.

A CRASH MID-WRITE IS RECOVERABLE AT ONE POINT AND CONTAINED AT THE OTHER THREE,
by design and not by omission. A landing journals an intent, starts an attempt,
commits to Git, journals the completion and then records the receipt. A crash
after the COMPLETION is reconcilable — the durable evidence proves what Git did,
and `repository.recover` writes the one missing receipt. A crash before the
intent, between intent and commit, or between commit and completion leaves the
journal unable to prove what Git did, so the checkout stays HELD and the shipped
recovery refuses with `REPOSITORY_RECOVERY_EVIDENCE_MISSING` or
`REPOSITORY_RECOVERY_CONTAINMENT_UNKNOWN`. An operator whose daemon dies in those
windows has a wedged reservation and no button. That is fail-closed, and it is
the honest state of the product today.

NODES OF ONE GOAL ARE DELIVERED ONE AT A TIME, and "staffed in parallel" has to
be read narrowly because of it. The repository delivery coordinator admits
exactly one checkout owner per repository root and answers the second node
`REPOSITORY_EXECUTION_BUSY (REPOSITORY_DELIVERY)` for as long as the first holds
the reservation — which is from staffing until the landing commits. So two nodes
are claimed and attempted inside one wrapper pass, and that is what the parallel
claim means; two commits are never being made at once. This is a designed
invariant, not a defect, and the 2026-09-09 drive asserts it by that refusal code
appearing strictly inside the first node's spawn-to-exit window.

THE BROWSER CANNOT INSTALL THE STANDING VERIFIER AUTHORITY. `moe-verifier-policy/1`
and `moe-reviewer-calibration/1` are installed by the demo seed and by no screen
the control room ships; without them the wrapper prints "standing authority
incomplete" and no delivered node is ever accepted. On a browser-bootstrapped
product that step is the operator's, over the command wire. Related and also
open: approving a criterion CHECK refuses the configured-operator wire
`CRITERION_CHECK_HUMAN_REQUIRED @ CRITERION_EVIDENCE` and needs a durable human
principal, and the control room ships no criterion-approval surface.

Measured on 2026-09-05,
these are still missing or manual: a multi-node goal was driven on a live
project on 2026-09-05 — a real `claude` planning seat sealed a five-node DAG,
a human approved it in the browser, the two independent nodes were staffed on
one pass while the rest waited on their dependencies, and two nodes landed as
commits on that one goal — but three of the five landings refused
`NOTHING_TO_COMMIT`, because every node of a goal shares one
`MOE_NODE_WORKSPACE` and a later node's commit sweeps an earlier node's
uncommitted paths, so the code lands and its attribution does not; the sealed
graph, the parallel staffing, the `depends:` gate and the coverage close are
exercised over real daemon, wrapper and agent processes in
`tests/e2e/foundation/multi-node-graph.e2e.test.ts`, and the coverage close and
its negative arm are proven only there, not on the lane; there is
Gate 2 IS NOW DRIVEN END TO END AGAINST A REAL LANDED PRODUCT, WITH ONE PART
STILL BROKEN, AND BOTH HALVES ARE MEASURED (2026-09-07):
`tests/e2e/control-room/preview-approve-live.spec.ts` and
`preview-reject-live.spec.ts` commit a preview scaffold into a lane's own git
workspace, land it through the REAL wrapper and the REAL `node-lander` (nothing
is seeded), start a REAL `preview.start` that spawns a REAL dev server on
loopback, and then commit an APPROVE and a REJECT whose verdicts are read back
out of `/activity/read` - so a decision that never reached the daemon cannot
pass. The old claim that this was unreachable, because a landed goal is recorded
by `internal.repository.landing_receipt` and that kind has no HTTP ingress, was
true of a BROWSER but never of the lane: the wrapper lands without HTTP. WHAT IS
STILL BROKEN IS THE BUTTON. The Gate-2 card renders against a really-running
product, but its Approve control cannot commit, for two independent reasons,
each asserted by code AND layer in those specs: `preview.decide` is operator-only
(`OPERATOR_PRINCIPAL_KINDS`) while the shipped browser pairs into a non-operator
credential, so a paired human is refused `OPERATOR_PRINCIPAL_REQUIRED @
DAEMON_AUTHORIZATION`; and `preview-port.ts` sends the preview AGGREGATE id where
the decide edge spends a RECEIPT id, which refuses `PREVIEW_GOAL_NOT_LANDED @
GOAL_AUTHORITY` even past the first wall. The verdicts above are therefore
committed by the CONFIGURED OPERATOR, not by a click. A REAL PREVIEW HAS BEEN
SERVED AND SCREENSHOTTED, but against the lane's own scaffold app, NOT against
UnAI: `D:/projexts/UnAI/package.json` declares only `test` and `typecheck`, so it
resolves no `preview`, `dev` or `start` script and `resolvePreviewCommand`
refuses it `PREVIEW_COMMAND_MISSING`.
**GATE 3 HAS BEEN DRIVEN, AND THE PRODUCT HAS OPENED A REAL PULL REQUEST**
(measured 2026-09-08, superseding "wired but blocked behind the same missing
landing"): `release.decide` is a published, operator-fenced command with a closed
three-code refusal vocabulary, the daemon builds the evidence dossier and serves
it over an authenticated read route, the affordance surface offers the decision
once a commit has landed, and the browser renders the evidence with its covered
and UNKNOWN counts kept apart, an arm-then-confirm approve, and the pull request
link a released receipt carries. On 2026-09-08 that chain ran end to end against
github.com with nothing faked: a contract-bound goal whose three nodes were
landed by the real wrapper's lander, published to a throwaway branch by the real
publisher, and approved by the two clicks of the browser card - which opened
<https://github.com/yaront1111/Moe-NG/pull/33>, base `main`, head
`205d51eb26322056fafcdc60ab98c247d1cd135e`. It is proof-carrying in fact and not
in name: the PR BODY IS the stored dossier, byte for byte - its sha256 equals the
receipt's `dossierSha256` `fbb2d0ad...5845` - and it renders every criterion with
its verifier command, exit code, receipt sha and landing sha. The drive is kept
as the opt-in `release-approval-live.spec.ts` (`MOE_LIVE_RELEASE_PR=1`), which
spawns the production `gh` rather than the lane's double. TWO LIMITS STAND. The
landing still comes from the wrapper's lander, not from a browser action -
`internal.repository.landing_receipt` has no HTTP ingress - so an operator cannot
originate one from the screen. And a live `release.decide` outruns the browser's
15s command-transport abort, so the ordering session shows a read error and the
link appears only on the next look; the pull request is opened and the receipt
recorded either way. **A REAL `codex exec` SEAT HAS
DELIVERED A NODE** (measured 2026-09-07, superseding "wired but last proven only
to reach the API"): codex-cli 0.153.4, argv read from the OS while the process
was alive, three `seat_start` rows reporting provider `codex`, and the lander
committing `ca4abc80a37e80aff51f1600d58afffb6e57b818` on a fresh lane project --
read back from the durable store after both processes were dead, and re-read
independently at review. It was the DURABLE SETTING, not `MOE_AGENT_COMMAND`,
that chose the provider: the override printed `<UNSET>` at wrapper launch.
**Provider choice from the browser (measured 2026-09-07)**: the agent provider is
a durable project setting the wrapper resolves per spawn; `/affordances/read`
offers `project.set_agent_provider`, the toggle builds a real envelope from that
offer, and A PAIRED BROWSER HUMAN HOLDING `ADMIN` NOW COMPLETES THE WRITE
end to end against a real daemon. The fence that refused it is narrowed, not
removed, and the remaining limit is stated rather than implied -- TWO
INDEPENDENT LAYERS, which refuse with DIFFERENT codes depending on how far the
caller gets. The kind's required capability is `ADMIN`, so over HTTP a caller
without it is refused `CAPABILITY_DENIED @ AUTHORIZE` at ingress and never
reaches the operator fence at all. A caller that DOES hold `ADMIN` but is not a
durably paired HUMAN -- a non-human principal, for instance -- is then refused
`OPERATOR_PRINCIPAL_REQUIRED @ DAEMON_AUTHORIZATION` at the handler seam, because
the kind stays in `OPERATOR_PRINCIPAL_KINDS`. The gate is pairing PLUS `ADMIN`,
never `ADMIN` alone. The Seats screen discloses, per seat,
the provider and agent CLI version the WRAPPER measured at spawn, plus WHERE the
credential comes from -- a sign-in file, or an environment variable NAME, never a
value -- and names `MOE_AGENT_COMMAND` when a launcher override is quietly
ignoring the browser choice; a SCRIPTED codex double also drives the real MCP
wire to verifier `ACCEPTED` and lander `COMMITTED`, offline and quota-free. What
remains unproven for Codex is BREADTH, not capability: one node on one lane
project, never a multi-node goal and never UnAI; and
the verifier is a trusted-workspace shell recipe, not an adversarial boundary. The design's Phase 0
freeze manifest and independent `FREEZE_READY` decision are not recorded; the
`node:sqlite` driver decision in
[docs/plans/2026-08-09-node-sqlite-driver-decision.md](./docs/plans/2026-08-09-node-sqlite-driver-decision.md)
is `PROPOSED — AWAITING HUMAN RATIFICATION`; the pinned benchmark specification
is unresolved (see
[docs/plans/2026-08-09-benchmark-spec-hash-resolution.md](./docs/plans/2026-08-09-benchmark-spec-hash-resolution.md)).
Development fixtures and payload hints are `DEVELOPMENT_ONLY` and confirm
nothing. Phase 0 tooling can capture and check evidence in memory but never
returns an authoritative `decision: GO`, `status: VERIFIED`, or freeze-decision
bytes; a non-caller-mintable trust boundary is still required before any
authoritative decision can exist.

This repository is stamped `0.1.0` under the MIT [LICENSE](./LICENSE), and every
workspace package stays `private: true`. The version marks the scope-frozen v0.1
line (Windows + Claude + linear execution + local single node); it is not a
published release. The repository now carries a Windows supervised-MVP artifact
pipeline (`pnpm pack:windows`) with a built control room and a `moe` CLI for
`projects`, `init`, `start`, help, and version. It refuses dirty shipped paths by
default and is still not a signed, auto-updating, Node-bundled, or npm-published
product. The self-host canary is not green either — its chain is still open. The
current verifier is not an adversarial trust boundary:
it runs a shell recipe from an agent-modifiable workspace under the wrapper's OS
account; for v0.1 it ships as a documented trusted-workspace limitation (human
decision 2026-08-18), and a hermetic verifier is v0.2. The unsigned artifact and
the unproven canary remain release blockers, not operator configuration issues.
The next major milestone is Stage 1 of the vision — a small but real PRD taken
to a proof-carrying, verified pull request (see [docs/VISION.md](./docs/VISION.md)).
The machinery for that last step now exists and is described above; what is
missing is a run, not a design. No pull request has been opened by this product
as of 2026-09-07, and nothing here should be read as saying one has.

## Windows: start your first project

The extracted supervised-MVP artifact is manager-first. Export one supported
agent credential, then keep this command running in its PowerShell window:

```powershell
.\moe.cmd projects
```

Open the printed
`http://127.0.0.2:39122/?projects=1#manager=<one-use-ticket>` URL manually within
60 seconds. Create a new Windows project or register an existing initialized
directory, select Start, then Open. The manager owns one contained daemon and
SQLite store per running project; use its rows to move between project tabs.
Goals, tasks, and boards remain bound to the project daemon/session that opened
the tab. Ctrl-C in the manager console stops the manager and every project
runtime it owns.

A newly created directory is immediately usable for project switching and its
isolated setup board, but it is not silently marked activated. **New Goal** stays
disabled until that project has legitimate durable repository, provider,
distribution, backup, credential, and store receipts. The current fresh-project
browser flow does not mint those authorities; its exact blocked cards are an
honest product limitation, not a credential or UI failure.

For a single project without the manager UI, `moe init <dir>` followed by
`moe start <dir>` remains supported. It runs that project in the foreground and
prints a one-use `#pair=` URL with the same 60-second window. Moe never launches
a bearer-bearing URL for you; see the
[agent stack runbook](./docs/agent-stack-runbook.md) for credentials, switching,
ticket recovery, and the exact containment boundary.

## Commands

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test                       # packages/** and tests/**
pnpm --filter @moe/daemon test  # apps/** is not discovered by the root gate
pnpm verify:foundation
pnpm verify:store
pnpm test:integration           # run from PowerShell (MSYS tar breaks it)
pnpm test:fault
pnpm test:security
pnpm test:property
pnpm test:e2e
pnpm test:e2e:browser
```

Never claim success without a fresh foreground run and its exit status.
