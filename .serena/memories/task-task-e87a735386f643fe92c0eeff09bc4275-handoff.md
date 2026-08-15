# task-e87a7353 — Linux effect conformance — BLOCKED at plan time (architect handoff)

Epic **M4 Portability** (`epic-f02c6977`). Blocked 2026-08-09 by `architect-8a4a1764`.
No plan submitted. The governor's promotion note pre-authorised this: *"If the DoD cannot be
honestly met without a real Linux host, report_blocked and say so — correct outcome, not a
failure."*

**This applies identically to the macOS sibling `task-e94b2055`**, promoted alongside it with
the same seven behaviours and the same platform warning. Whoever routes one should route both.

## Per-DoD verdict, verified on disk

| DoD | Verdict |
|---|---|
| 1. crash-before/after activation + cancellation schedules on every declared effect boundary | **NO** — `packages/runner/src/platform/` does not exist for ANY OS, so there is no declared boundary set. Running the schedules over caller-supplied fixtures is a *mock-backed journey*. |
| 2. path/symlink/process/lock/closure observations **proven or UNKNOWN** | **YES** — honestly meetable here. It permits UNKNOWN by its own wording. Linux path/symlink policy is pure logic; process and lock observations become UNKNOWN. **This is the plannable half.** |
| 3. packaging uses pinned engine/runtime, doctor reports exact versions | **HALF** — `engines.node ">=24.16.0 <25"` and `packageManager: pnpm@11.0.8` ARE pinned in root `package.json`. But `apps/daemon/src/recovery/doctor-commands.ts` has **no runtime-version surface** (only `schemaVersion`), so the doctor clause has no subject. |
| 4. Linux fault gate passes | **NO** — `pnpm test:fault` is not a script in root `package.json` (only `test:meta`, `test:property`, `test:e2e`, `test:store`), and no Linux behaviour executes on this Windows host. |

## Why not just plan it with UNKNOWNs

The new project rail, **Clause 2**, is decisive and is what turned a judgement call into a
clear answer:

> an acceptance, proof or canary task must name, at planning time, the production capability
> it certifies and the task that shipped it. The architect verifies the capability on disk by
> grep/probe, not by reading the design. When the capability is absent, the required output is
> prerequisite production tasks with the gap measured symbol by symbol — NEVER a narrowed DoD,
> a mock-backed journey, or authority reimplemented inside the test. **A proof that only proves
> the shapes is worse than no proof.**

A worker completing this task must claim DoD 4 passed. On Windows they cannot. They would
either fabricate it or complete with it unmet — and epic rail 4 says unverifiable evidence
stays UNKNOWN and never gains authority.

Note the genuine tension I weighed: the supervisor precedent (`task-4a3b5ec0`) proved crash and
drain behaviour purely, over caller-supplied observations, with real OS wiring deferred. That
is a legitimate shape — **for an implementation task**. It is not legitimate as the substance
of a *conformance* claim, which is exactly the distinction Clause 2 draws.

## Proposed split — the useful output

Per the governor's instruction that **this** task owns any shared seam and macOS consumes it:

- **A. Linux platform PORT adapters** — `packages/runner/src/platform/linux/**`. Pure
  path/symlink canonicalisation policy, signal vocabulary, lock semantics declaration, runtime
  closure shape; process and lock observations typed UNKNOWN. **Plannable now on Windows.**
  Real production capability, makes no OS claim. This is also where the shared Linux/macOS
  contract belongs.
- **B. Doctor runtime-version reporting + Linux packaging declaration** — gives DoD 3 a
  subject to assert.
- **C. The `test:fault` lane** — root `package.json` script (ownership amendment, the way
  `test:e2e` was added).
- **D. This task** — execute the conformance schedules on a real Linux host and produce the
  fault evidence.

A, B and C are all Windows-safe and unblock immediately; only D needs the host.

## Standing collision for whoever routes A–D

**`task-05ce9b8f` (Security fault matrix) owns the whole `tests/fault/**` tree.** The governor
flagged this collision explicitly for `task-0c89476b` (disaster restore) but not here, and it
applies to `tests/fault/linux/**` the same way. Resolve the ownership overlap before scheduling.

## Dependency state (all genuinely satisfied — the block is not about these)

Codex adapter `task-a0fa6da4` was WORKING at 9/11 with its implementation on disk:
`packages/runner/src/providers/codex/` holds probe, capabilities, observation, cancel-reconcile,
render, render-skills, stream, stream-anomalies and a `codex-parity.test.ts`. `packages/runner`
itself landed long ago.

Related: `mem:task-task-0c89476b78044024b07c86c0c8986bd0-handoff` (same epic-family shape — a
proof task whose subject does not exist yet), `mem:task-task-a0fa6da4024647d69c25d273b217eaeb-handoff`.
