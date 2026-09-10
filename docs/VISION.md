/com# Vision: from PRD to production, with proof

**Status.** Stated by the human on 2026-08-22. Items marked *proposed* are
governor sharpenings from the same day, each anchored to a measurement on the
moe-next board; they are not ratified until the human strikes or keeps them.
The authoritative engineering design is the read-only document named in
`AGENTS.md` → Pointers; this file says what that engine is *for*.

## Thesis

**Moe is a trustworthy autonomous software company: give it a PRD, and it
designs, builds, verifies, deploys, and improves the product.**

The control plane, the authority system, and the evidence model are the
engine — not the product promise.

## Positioning

| | As stated | Sharpened *(proposed)* |
|---|---|---|
| Customer promise | From PRD to production — with proof. | …with a trace that survives an adversary: every claim re-measured at the shipping SHA, every refusal recorded with its reason. |
| Technical moat | Moe independently governs, verifies, and recovers every agent action used to produce the product. | Provable refusal. Nobody else can show the thing their agent refused to build and prove the refusal was correct. |
| Commercial wedge | Governed migrations and remediation campaigns first — measurable, sellable — funding the PRD-to-product vision. | The board already built this muscle: "grep undercounts the radius, one pass undercounts the causes, one package undercounts the reach" is migration-campaign competency, already paid for. |

## The end-to-end journey

1. PRD
2. Clarify and validate
3. **Product Contract** — Gate 1: approve
4. **UX and architecture** — running since 2026-09-06
5. Implementation plan
6. Parallel development
7. **Contract amendment** when a requirement is measured unbuildable as written — Gate 1½ *(proposed)*
8. Independent verification
9. **Working preview** — Gate 2: approve
10. **Production release** — Gate 3: approve
11. Observe users and iterate

The four operator decisions above — Gate 1, the design step, Gate 2 and Gate 3 —
COMPOSE ON ONE GOAL, measured 2026-09-09 rather than assumed:
`apps/daemon/src/gates-compose-journey.test.ts` drives a single goal through all
four through the real command path against a real store, in both variants (a
design AUTHORED and a design DECLARED SKIPPED), and asserts each out-of-order
attempt refuses with its own code AND the layer that answered.

## What Moe takes and returns

**In:** a PRD; business objectives; target users; brand and design references;
budget and deadline; technical or regulatory constraints; *(proposed)* negative
scope — what will explicitly not be built.

**Out:** a working, polished product; architecture and threat model; production
infrastructure and deployed environments; tests and security evidence;
documentation and onboarding; monitoring and rollback; a trace showing how every
PRD requirement was satisfied — *(proposed)* re-measured at the shipping SHA,
never stored at plan time; *(proposed)* for commercial quality, a falsifiable
prediction plus the instrument that would test it, never a claim.

## The key new component: the PRD Compiler

Moe understands durable work better than it understands products. The compiler
turns prose into an immutable, versioned **Product Contract**: personas and
jobs-to-be-done; user journeys; functional and non-functional requirements; UX
and accessibility standards; security and privacy constraints; acceptance
criteria; analytics and success metrics; deployment requirements; explicit
assumptions and unresolved decisions; requirement dependencies and priorities;
the definition of "product complete".

Rules:

- Ask only questions whose answers materially alter the product. Never quietly
  invent an important product decision. *(proposed, mechanical form)* a
  question is material iff two plausible answers compile to different
  acceptance criteria — generate both, compile both, diff; empty diff, don't
  ask.
- Once approved, implementing agents cannot rewrite the contract to make their
  work appear complete. Changes require an explicit product-contract revision.
  *(proposed)* that revision channel must exist as a first-class tool;
  immutability without an amendment path produces shadow amendments in
  comments, not integrity.
- *(proposed)* A requirement is compiled only when the Requirements verifier
  can mechanically enumerate what would falsify it. Satisfied means
  **reachable**, not representable — a requirement met by code that never
  executes is not met.

## What users see: approve products, not commands

Leases, dispatch commands, aggregates, handoffs, authority witnesses, and
internal refusal codes belong in an advanced forensic view. A normal user sees:

1. **Approve Product Contract** — "Is this what we intend to build?"
2. *(proposed)* **Approve Contract Amendment** — "This requirement cannot be
   built as specified; here is the measurement and the options."
3. **Approve Working Preview** — "Is this product good enough and visually
   correct?"
4. **Approve Release** — "Is the evidence strong enough to expose this to
   users?"

## What "great product" must mean

Passing tests is not enough. Separate quality authorities, and **the agent that
built a feature is never the final authority that grades it.**

| Authority | What it proves | Power *(proposed column)* |
|---|---|---|
| Product verifier | The result addresses the users and the business objective | Blocks at Gate 2 |
| Requirements verifier | Every requirement has implementation and evidence | Blocks |
| UX verifier | Journeys, responsiveness, accessibility, states, consistency | Discloses, escalates |
| Architecture verifier | Maintainability, boundaries, migrations, extensibility | Discloses, escalates |
| Security verifier | Authentication, authorization, secrets, dependencies, abuse cases | Blocks |
| QA verifier | Unit, integration, browser, recovery, adversarial testing | Blocks |
| Operations verifier | Deployment, telemetry, backup, rollback, incident handling | Blocks at Gate 3 |
| Human reviewer | Taste, strategy, consequential decisions | Owns every gate |

Moe can produce excellent software, but it cannot prove a product is
commercially great without real users. It must deploy, collect privacy-safe
product signals, compare them with the PRD's success metrics, and propose
iterations. *(proposed)* Budget and deadline need an owning verifier and a
gate-time burn report, or they leave the input list.

## Product-team capabilities

Capability-scoped roles with different authority — not personas chatting with
each other: product manager, researcher, UX designer, architect, frontend and
backend engineers, platform/DevOps engineer, security engineer, QA and
browser-testing engineer, independent reviewer, release manager, product
analyst. The scheduler decides which capabilities each product needs instead of
always spawning a fixed agent team.

## One controlled product profile first

"Any PRD" would fail. Start with **TypeScript web applications: React, Node,
PostgreSQL, GitHub, containerized deployment, browser-based acceptance tests.**
Support exceptionally well: new repository creation (local browser bootstrap
measured 2026-09-06; GitHub creation not live-proven); authentication and
authorization; database schema and migrations; responsive UI; API; testing;
deployment; observability; security; documentation. Build a benchmark of 20–30
representative PRDs. Do not expand to mobile, desktop, embedded, games, or
arbitrary languages until Moe repeatedly produces acceptable products here.

## Roadmap

**Stage 1 — PRD → verified PR (now):** PRD compiler and approved Product
Contract; requirement-to-code traceability; canonical Foundation execution;
Claude and Codex; isolated verifier; working browser preview; proof-carrying
GitHub PR. *(proposed bar)* survives a crash **mid-write**, with recovery
provable from durable records alone, never from agent memory.
*Status, measured 2026-09-09:* THE PREVIEW GATE HAS BEEN DRIVEN against a real
landed product, superseding the older line here that called it undriven. That
line reasoned from a browser: `internal.repository.landing_receipt` has no HTTP
ingress, so no BROWSER path produces the landed goal a preview requires — but the
WRAPPER lands without HTTP, so the lane always could.
`tests/e2e/control-room/preview-approve-live.spec.ts` and
`preview-reject-live.spec.ts` land a preview scaffold through the real wrapper
and the real `node-lander`, start a real `preview.start` that spawns a real dev
server on loopback, and read both verdicts back out of `/activity/read`.
WHAT IS STILL BROKEN IS THE BUTTON, not the gate: the verdicts are committed by
the CONFIGURED OPERATOR rather than by a click, because the shipped browser pairs
into a non-operator credential and is refused `OPERATOR_PRINCIPAL_REQUIRED @
DAEMON_AUTHORIZATION`, and because `preview-port.ts` sends the preview AGGREGATE
id where the decide edge spends a RECEIPT id (`PREVIEW_GOAL_NOT_LANDED @
GOAL_AUTHORITY`). README.md carries both halves with their file and line.
THE RELEASE GATE HAS BEEN DRIVEN. `release.decide` ships with a closed three-code
refusal vocabulary, a daemon-rendered evidence dossier served over an
authenticated read, and a browser card that keeps covered and UNKNOWN counts
apart before asking for the verdict - and on 2026-09-08 that whole chain ran
against github.com with nothing faked. A contract-bound goal, landed by the real
wrapper's lander and published by the real publisher, was approved by the browser
card's two clicks, and the product opened
<https://github.com/yaront1111/Moe-NG/pull/33> at sha
`205d51eb26322056fafcdc60ab98c247d1cd135e`. The proof-carrying PR is no longer
the piece with no run behind it: the pull request BODY IS the stored dossier,
byte for byte, its sha256 equal to the receipt's `dossierSha256`, listing every
acceptance criterion with the verifier command, exit code, receipt sha and
landing sha that carried it. Two limits stand and are not softened here: the
landing still originates outside the browser, and a live `release.decide` outruns
the browser's 15s transport abort, so the operator sees the link on the next look
rather than in the ordering session.
THE WHOLE STAGE 1 LOOP HAS NOW RUN ON A PRODUCT THAT DID NOT EXIST WHEN THE RUN
STARTED (measured 2026-09-09). One drive takes a recorded PRD from the browser's
own New product form to a real pull request: bootstrap receipt BOOTSTRAPPED at a
sha git agrees with, activation, Gate 1 with a MATERIAL clarification answered by
click, a design revision, a compiled three-node plan, the plan gate taken by
click, three nodes landed by the real wrapper and lander at three distinct shas,
all eight of the PRD's acceptance criteria VERIFIED by the contained criterion
service (8/8, cross-checked against the approved contract's own roster and
against `/documents/coverage/read`), a real publish, and Gate 3 taken by the two
clicks of the release card — opening
<https://github.com/yaront1111/moe-live-proof-161b7e9d/pull/2> at sha
`65192c19a8cf5197462647926c130a0c12c2c1ad`, its body the dossier with a row for
every criterion. The drive is `tests/e2e/control-room/live-proof-prd.spec.ts`;
the pull-request leg is opt-in on `MOE_LIVE_RELEASE_PR=1` and records its own
absence otherwise. THE CRASH BAR IS NOW MET INSIDE THAT SAME DRIVE, not only in a
unit lane (re-measured 2026-09-09, superseding the line that pointed only at
`tests/fault/landing-crash`). The development-only knob `MOE_FAULT_INJECT_LANDING`
SIGKILLs the process performing the landing in the window between the durable
completion and the receipt that records it; after the restart a HUMAN takes the
recovery BY CLICK on the shipped repository-recovery card, because
`repository.recover` requires `project.admin` with a durable human principal and
refuses every agent transport. The store then shows exactly ONE landing outcome
for that node, no doubled row anywhere in the landing journal, and both remaining
nodes landing after the crash instant — the goal resumes and runs on to its
criteria, its preview and its release. Recovery is provable from durable records
alone, which is the proposed Stage 1 bar, with one honest limit: only a crash
AFTER the completion is reconcilable; the three earlier points leave the journal
unable to prove what Git did and the checkout stays contained. THREE LIMITS
STAND. Nodes of one goal are
delivered ONE AT A TIME — the delivery coordinator admits a single checkout owner
per repository root and answers `REPOSITORY_EXECUTION_BUSY` to the second, so
"staffed in parallel" means claimed and attempted together, never two commits
being made at once. The browser ships no screen that installs the standing
verifier authority (`moe-verifier-policy/1`, `moe-reviewer-calibration/1`), so
that one step is the operator's. And only a crash after the landing COMPLETION is
recoverable; the three earlier points contain the checkout and offer no button.

**Stage 2 — PRD → deployed MVP:** repository bootstrapping (the unseeded local
browser path creates one commit, binds and catalogs the repository, and creates
a PRD-bound goal, measured 2026-09-06; owner-directed GitHub creation remains
unproven); infrastructure
generation; preview and production deployment; secrets and environment
management; database migrations; monitoring, backup, and rollback; release
evidence.
*Status, measured 2026-09-09:* FOUR OF THESE RAN ON THE FRESH PRODUCT, in the
same drive that closed Stage 1, past Gate 3 and against real Docker. PREVIEW
DEPLOYMENT: `deployment.deploy` built the released sha with `git archive` into
`docker build`, started a candidate, waited for docker's own health verdict and
flipped a real Caddy proxy to it; the receipt's own URL answers
`{"product":true,"status":"UP"}` from the host. SECRETS AND ENVIRONMENT:
`environment.set_variable` bound two variables that come back only as sha256
fingerprints — the value never returns on any read. DATABASE MIGRATIONS: the
deploy ran the PRODUCT'S OWN migration against a real PostgreSQL 17, keyed by the
deploy decision, with a pre-migration `pg_dump` backup referenced by path and
sha256, and the schema was then read back out of `pg_constraint` and the tool's
own ledger rather than trusted from the DDL. RELEASE EVIDENCE: the dossier is the
pull request's body, 8/8 criteria at the released sha.
THREE THINGS IN THIS STAGE ARE NOT YET THE PRODUCT'S and the drive says so
rather than implying otherwise. INFRASTRUCTURE GENERATION EXISTS BUT IS DARK:
`deployment-infrastructure-templates.ts` emits the Dockerfile, the compose
override, the Caddyfile and the healthcheck, and
`planDeploymentInfrastructure` has ZERO callers — no command kind asks a
repository for its infrastructure. Standing the environment UP is therefore the
operator's `docker compose`, and installing the product's own dependencies is the
operator's too. PRODUCTION deployment, monitoring, backup and rollback are
untouched by this run: only the `preview` environment was deployed.

**Stage 3 — PRD → polished product:** competitive research; multiple UX
concepts before implementation; visual-quality evaluation; accessibility and
performance budgets; product analytics; user-feedback ingestion; automated
iteration proposals.

**Stage 4 — autonomous product organization:** multiple products and
repositories; portfolio budgets and priorities; roadmap management; support and
incident feedback; continuous security and dependency maintenance; controlled
autonomous releases; business-outcome optimization.

## Next major milestone

> Give Moe a small but real PRD. Moe asks the necessary questions, creates the
> architecture and UX, builds the complete application, launches a working
> preview, proves every requirement, survives a forced crash, and prepares a
> production-ready release.

That is the target the entire Moe roadmap is designed around. The dogfood test
is already on the board: Moe cannot currently ship its own pull request —
task-count is not product progress, and a contract trace is what would have
shown the gap.
