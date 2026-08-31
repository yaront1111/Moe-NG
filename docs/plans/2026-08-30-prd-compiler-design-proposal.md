# PRD Compiler — design proposal (free-agent synthesis, 2026-08-30)

Advisory only. Produced by a free-agent session: 3 independent designs (seam-first / contract-first /
agent-loop), each grounded in code reads at HEAD 9dafdff9, judged by 2 lenses (architecture-and-authority,
delivery-pragmatics). Every file:line below was verified by at least one judge against the repo.
Decision authority stays with the architect/owner.

## The correction that reframes the work

**The Product Contract half already exists at HEAD and is writer-less.** `apps/daemon/src/product-contract/`
(~20 files) plus the core quintet (codec, materiality, lineage, acceptance-binding) ship a versioned,
lineage-tracked, human-bound contract aggregate with the Gate 1 command/bearer/resolver/HTTP read route
wired end to end — and `commitProductContractRevision` (product-contract-revision-store.ts:115) has **zero
production callers**. `assessClarificationMateriality` (product-contract-materiality.ts:96) and
`validateProductAcceptanceBinding` (acceptance-binding.ts:198, byte-equal statement fence) are likewise
consumer-less. The missing product is therefore NOT "a compiler and a contract" — it is:

1. a **writer** for the shipped contract family (the LLM planning agent),
2. a **contract → planning-chain producer** (the only two chain producers at HEAD are hand-written demo
   constants: `orchestrator/demo-seed-payloads.ts`, `apps/control-room/src/live/live-dispatch-payloads.ts`),
3. the **clarification loop** ("never quietly invent a product decision") as refusal codes, not prose.

## Synthesized design (spine of D3, fences of D2, grafts of D1)

**Spine (from the agent-loop design):** generalize the existing agent-wrapper staffing loop to run a
PLANNING agent. The affordance surface offers `product_contract.propose_revision` for every source-bound
goal (and **withholds `plan.propose` until Gate 1** — closing today's race where the wrapper staffs
plan.propose with the hard-coded demo payload hint). The wrapper staffs it with a `claude -p` MCP-only
agent whose mission is: read the bound PRD via a new goal-scoped `documents.source_read` MCP query
(server re-hashes the text against the GoalCreated binding, refuses on mismatch), raise material
clarifications, submit a contract revision. After the human approves at the EXISTING Gate 1, a
deterministic daemon-side pass compiles the approved revision into the planning command chain and
dispatches it — landing directly on the existing ApprovePlan seam. No new Gate UI beyond the contract card.

**Fences (from the contract-first design) — non-negotiable grafts:**
- **Clarification-consumption fence:** open MATERIAL clarifications refuse `submit_draft` (and Gate 1
  offering); every answered clarification's chosen projectionDigest must be realized in the submitted
  revision. This is the owner's "never quietly invent" rule as a refusal code. (D3 left it as prose — its
  biggest hole.)
- **Parity test idiom:** drive the compiler's derived chain through the REAL plan.propose seam in a
  throwaway store (dev-payload-parity style) so statement-equality/codec drift at acceptance-binding.ts:198
  reds in CI, not at a live finalize.
- **Lineage-diff UI:** Gate 1 card renders approved-parent vs pending-child via
  `validateProductContractAmendment`, so re-approval-after-clarification reads as design.
- **Actor discipline:** the compile dispatcher must NOT dispatch under the operator credential (violates
  the actor binding at planning-services.ts:245-247). The daemon is the author of the derived chain; mint
  `planning.ready`/`planning.claim` witness refs **server-side** (fixes the real truth-class violation:
  demo-seed-payloads.ts caller-stamps DAEMON_VERIFIED today).

**Grafts (from the seam-first design):**
- **Content-addressed compiled-plan stash** + inflate-by-ref: plan.propose inflates the chain from the
  daemon's own bytes — kills the model-echoes-base64 forgery channel. Mandatory before any agent drives
  the chain over MCP.
- **Falsifiability floor at compile time:** refuse any node whose capability has no
  `VerificationCatalogReader` argv entry and any criterion without an evidence requirement — moves the
  known "approved plan stalls at produceNodeBrief / NODE_MISSION_TEST_UNAVAILABLE" wedge to compile time
  with a printed repair.
- **policy.install prefill card:** operator assigns a risk tier per compiled fact id, no silent defaults.
  Keep D3's derived-slice output as a diagnostic REPORT feeding this card, **never** as an installable
  payload — otherwise the compiler sets its own approval bar (self-grading by construction).
- **Mission scope rule:** "plan the smallest complete slice, not everything", pinned to
  decompositionBudget 24.
- Budget the repo's mandatory `.js` bridges in every row's file count; additive-sibling-by-rule near the
  parity-pinned `journey-authority-bodies.ts` (its :161 arm hard-fails on anything but exactly one node —
  build a NEW `compiled-authority-bodies.ts` producer, never edit the pinned one).
- **Provider-profile-bound spawn:** pin the planning agent's model to the durably probed provider profile;
  coded staffing refusal when no probe exists.

## Row ladder (merged, build order; each ≤10 files incl. .js bridges)

1. Wire roster fail-closed: `product_contract.propose_revision` (+ optional compile kinds) in
   runtime-vocabulary + daemon-command-vocabulary/registry/dispatch, registered-but-refusing
   (cutover.activate idiom). Lands green with everything else unbuilt.
2. `documents.source_read` MCP served query: goal binding → source aggregate text, server re-hash,
   two-directional allowlist parity tests.
3. Provenance join: contract revision ↔ GoalCreated binding fence (digest mismatch refused, upstream
   codes forwarded unstamped).
4. `propose_revision` service: codec → core admission → materiality → provenance join →
   `commitProductContractRevision` (the writer-less store gets its writer). **Blocks on the capability
   fence ruling (decision 1).**
5. Clarification lifecycle: ask (materiality verdict verbatim, IMMATERIAL refused) / answer
   (operator-principal-bound, re-answer refused) + the consumption fence.
6. Affordance offer ladder: source-bound goal → offer propose_revision, withhold plan.propose until Gate 1.
7. Planning mission text + wrapper kind-branch (retire the dev payloadFor hint for this kind).
8. Multi-node authority producer `compiled-authority-bodies.ts` (NEW producer; dependsOn → edges via the
   predicate registry; falsifiability floor).
9. Compile dispatcher (post-Gate-1, idempotent via derived commandIds, daemon-authored witnesses,
   content-addressed stash + inflate-by-ref propose arm). **Blocks on trigger-placement ruling (decision 3).**
10. Gate 1 card in control room (revision + lineage diff + clarifications + approve dispatch).
    **Coordinate with in-flight T1-d rows before claiming control-room live files.**
11. policy.install prefill card (operator-assigned tiers per compiled fact id).
12. Provider-profile-bound spawn hardening.
13. One integration lane: seeded PRD → scripted compiler double over the real wire → ask/answer/submit →
    Gate 1 → compile → propose+finalize (fence red drill) → Approve Plan → ACTIVE graph.

## Decisions needed before rows 4/8/9 (owner ○ / architect ●)

1. ● Capability fence: reuse `planning.write` or mint `contract.write` so a proposal author can never
   touch plan.propose runs. (Gates row 4.)
2. ○ Clarification semantics: does Gate 1 refuse while material questions are open, or
   approve-with-answers; is an answer a new revision via lineage (vision says yes)?
3. ● Compile trigger placement: wrapper compileOnce pass (mirrors verifier) vs daemon-internal reaction
   to the Gate 1 event vs offered surface step. Determines restart/idempotency story.
4. ○● TypeScript-web-app profile: closed capability roster, per-capability verification argv, scope
   grammar, decompositionBudget defaults, who installs the standing policy slice.
5. ● Snapshot-freeze: does Gate 1 approval freeze the proposal it rode in with?
6. ○ Contract schema: keep `/1` (typed requirement statements) or mint `/2` with structured sections
   (personas/journeys/non-functional) before any producer lands.
7. ○ Multiple competing proposals per goal: first-admitted-wins vs operator chooses at Gate 1.
8. ○ Planning-agent access in v1: MCP-only (PRD text sole input) vs read-only repo tools for brownfield.
9. ● Legacy `DocumentWorkProposal` provisional path: retire or keep beside the contract lane.

## Shared risks (true under every design)

- **Multi-node graph admission has ZERO production exercise at HEAD** — every shipped path seals a
  single-node zero-edge graph. The first real compiled plan is the first production test of
  edge/dependency-contract admission. Deserves its own early drill row.
- Approved plans stall at execution unless a TypeScript-web capability → verification-catalog roster
  exists (`produceNodeBrief` refuses NODE_MISSION_TEST_UNAVAILABLE). Not a week-1 row in any design; must
  be one.
- The byte-equal statement fence (acceptance-binding.ts:198) is both the fidelity guarantee and a
  fleet-wide tripwire — any prettifying red-flags every finalize; the row-13 parity lane is the early
  warning.
- Control-room live modules are actively edited by the T1-d approval chain; claim files with coordination.

## Judge scores (2 judges × 3 designs, /40)

| Design | architecture judge | delivery judge |
|---|---|---|
| seam-first | 28.5 | 26 |
| contract-first | **31.5** (winner) | 30 |
| agent-loop | 30.5 | **32** (winner) |

Split verdict; both judges' grafts converge on the synthesis above. Full designs + critiques:
free-agent session 1aef928f workflow `wf_401a1841-afa` journal.
