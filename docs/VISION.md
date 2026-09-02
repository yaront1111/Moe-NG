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
4. UX and architecture
5. Implementation plan
6. Parallel development
7. **Contract amendment** when a requirement is measured unbuildable as written — Gate 1½ *(proposed)*
8. Independent verification
9. **Working preview** — Gate 2: approve
10. **Production release** — Gate 3: approve
11. Observe users and iterate

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
Support exceptionally well: new repository creation; authentication and
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

**Stage 2 — PRD → deployed MVP:** repository bootstrapping; infrastructure
generation; preview and production deployment; secrets and environment
management; database migrations; monitoring, backup, and rollback; release
evidence.

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
