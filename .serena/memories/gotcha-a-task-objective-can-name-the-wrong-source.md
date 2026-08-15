# A task objective can name a source that does not contain its subject

task-10cab3e5's objective: implement WDRR "from the corrected DEVELOPMENT_ONLY reference". The
reference (`packages/testkit/src/scheduler-fairness/`) contains **no ring, no deficit, no resource
queue**:

```sh
grep -rnw -E "WDRR|deficit|resourceQueue|ResourceQueue" packages/testkit/src/scheduler-fairness/   # 0
grep -rn  -E "\bRing\b|\bring\b" packages/testkit/src/scheduler-fairness/*.ts                      # 0
```

It implements a priority-ladder / forced-cohort / bypass model instead (`selectNext`,
`forcedCohortOrder`, `boundFor`, `PRIORITY_LADDER`, `BYPASSES_PER_LEVEL`, `DEFAULT_M_D`). Building
rings from it would have been inventing policy and calling it derived.

**Use `-w` or `\bRing\b`.** A case-insensitive bare `ring` matches `string` / `during` / `ordering`
and reports a false hit — the opposite error, concluding the source DOES cover the subject.

## What to do instead of stopping
Absence of the named source is not automatically a blocker. Look for a landed surface that DELEGATES
the work. Here `packages/scheduler/src/fairness/fairness-ring.ts:12-20` says the contract "cannot say
whose turn it is, cannot compute a deficit ... Rotation, deficit accounting and aging belong to the
consumer, task-10cab3e5" — naming the consuming task. Implementing it is completing a stated
delegation, not inventing authority. Record which one you built from.

## When the real source cannot be imported
`@moe/scheduler` declares only @moe/context, @moe/contracts, @moe/core — no devDependencies, no
@moe/testkit — and DoD 3 forbids adding it. So policy constants must be REDECLARED in production.
Duplication is the only legal path, but drift silently changes fairness policy, which task scope
forbids without approval. Cite `file:line` beside each constant AND pin the values in a test at both
the module and the package root.

Stronger than a value pin, when a closed set already exists elsewhere: assert your ordered ladder is
a permutation of the contract's unordered class tuple. `FAIRNESS_PRIORITY_CLASSES`
(`fairness-contract.ts:80-83`) deliberately carries no ordering meaning, so the ladder may add ORDER
and nothing else — a value-only pin stays green if the ladder gains or loses a member.

Generalisation: a task description's claims about what exists on disk are stale by default, in BOTH
directions. See `mem:moe-block-conditions-go-stale-silently`,
`mem:deps-done-is-not-deps-reachable`.
