# A digest field can be unkillable end to end because a guard upstream forces its value

QA rejected task-47eecd22 for a drill-dead guard: setting `projectId: ""` inside
`durableInventoryScopeDigest` (apps/daemon/src/recovery/durable-recovery-inventory-contract.ts)
left the whole 25-test suite green, so "the window is addressed by project" was unasserted.

The trap is the obvious fix. QA's suggested end-to-end test — seal under one identity, read under
another, expect `RECORD_NOT_FOUND` — works for `projectTag`, a free caller input, and **cannot ever
work for `projectId`**:

- `resolveScope` refuses unless `store.getHealth().projectId === projectId`, so the value fed to the
  digest is always the store's own;
- one store is one file, so a second project is a second database with its own aggregates.

There is no reachable pair of reads that differ only in that field. Every end-to-end drill of it is
an equivalent mutant, and writing one anyway produces a test that passes for the wrong reason.

**What actually kills it:** assert injectivity against the exported pure digest function. Perturb
each field of the digest body one at a time, keep the field NAME with the value
(`expect(\`${field}:${perturbed}\`).not.toBe(\`${field}:${base}\`)`) so a survivor names itself, and
pin both the perturbation count and the distinct-digest count so a sweep that generated nothing
cannot pass. That drills every field, including the ones no caller can vary.

**Generalise:** before believing a field is untested, ask whether any caller could have made it
differ. If an upstream guard pins it, the coverage belongs at the pure function, not at the port.
The reverse error is worse: a hand-written end-to-end "proof" for a value that was never variable is
a transcript, see `mem:pattern-a-pinned-value-is-only-a-decision-if-another-was-representable`.

Related: `mem:gotcha-equivalent-mutant-in-a-two-clause-guard`,
`mem:gotcha-redundant-operand-mutants-survive-inside-one-guard`.
