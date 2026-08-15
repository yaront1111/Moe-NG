# Decision: @moe/runner takes cross-package identities as opaque refs, never imports

`packages/runner/package.json` declares exactly one dependency: `@moe/contracts`. The daemon and the store both depend on the runner, so the runner cannot depend on either without inverting the package graph.

This bites whenever a task description says the runner should "use" something a sibling package landed. Two live examples, both measured 2026-08-09:
- backup **cursor / generation identity** — landed in `@moe/store` (`packages/store/src/backup-generation-contracts.ts`, task-5606947a).
- **recovery incarnation** — landed in `apps/daemon` (`apps/daemon/src/recovery/recovery-incarnation-contract.ts`, task-684e6972).

Both are DONE and unreachable from the runner.

**The pattern:** such an identity enters the runner as a **caller-supplied opaque ref** — validated for shape (bounded normalized text / hex digest), bound into the digest of whatever record it parametrises, and **never interpreted or re-derived**. The daemon, which can see both sides, is what joins the opaque ref back to its authoritative record.

Do NOT: add the dependency, copy the sibling's type, or re-derive its digest inside the runner. The first breaks the graph, the second and third fork a vocabulary that must stay single-sourced.

Related: `mem:decision-cross-module-refusal-passthrough` (the same "compose, never re-code" instinct applied to refusals), `mem:task-task-0325dcf7ee744123b40cf583230c7b6a-handoff` (where this was first forced).
