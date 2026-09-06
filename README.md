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

Nothing here is a readiness, GA, or comparative claim. Measured on 2026-09-05,
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
Gate 2 is WIRED BUT NOT YET DRIVEN END TO END - `preview.start` is a published
async command, the daemon serves the preview receipt and its captured
screenshots over authenticated read routes, and the browser renders the running
product with Approve and send-it-back controls - but no preview has been run
against a real landed product, because a landed goal is recorded by
`internal.repository.landing_receipt`, which has no HTTP ingress, so nothing a
browser can do makes one. Gate 3 EXISTS AND IS WIRED, AND IS BLOCKED BEHIND THE
SAME MISSING LANDING (measured 2026-09-07): `release.decide` is a published,
operator-fenced command with a closed three-code refusal vocabulary, the daemon
builds the evidence dossier and serves it over an authenticated read route, the
affordance surface offers the decision once a commit has landed, and the browser
renders the evidence with its covered and UNKNOWN counts kept apart, an
arm-then-confirm approve, and the pull request link a released receipt carries.
No release has been driven against a real landed product for the reason above,
and NO PULL REQUEST HAS BEEN OPENED BY THE PRODUCT: the `gh` path was driven as
far as GitHub itself on 2026-09-07 - the head proof, the production argv and an
authenticated answer from github.com - but the run that would create one needs a
landed goal and an owner-named target repository. A Codex seat is wired but was
last proven only to reach the API; and
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
