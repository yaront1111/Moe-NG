# A drill that makes a guard ALWAYS refuse proves nothing — mutate toward "never refuses"

## The trap
To prove a refusal guard is live, the instinct is "flip the comparison". For
`if (observed === expected) return null; return refuse(...)`, flipping to `!==`
inverts it: the guard now refuses the MATCHING case and passes the drifting one.

That looks like a strong mutation and it does turn the suite red — but for the
wrong reason. Every fixture built from a MATCHED record now fails to construct,
so the test modules throw during evaluation and vitest reports:

    FAIL  <file> [ <file> ]
          Tests  no tests

A collection failure names no assertion. It cannot distinguish "the drift test
caught this" from "the fixture module crashed before any test ran", so it
certifies nothing about the assertions you were trying to validate.

## The correct mutation
Make the guard NEVER refuse, leaving every fixture constructible:

    if (expected === expected) return null;   // self-compare, always true

Now the matched path still builds, the suite still collects, and the reds are
named outcome assertions — `expected 'X' to be 'PROVIDER_CAPABILITY_CHANGED'`,
`expected [ 'runtime', 'validate', 'consume' ] to deeply equal [ 'runtime',
'validate' ]`. That is evidence.

## Rule
For a drill on a REFUSAL guard, mutate in the permissive direction (guard goes
dead), never the restrictive one (guard fires everywhere). Permissive mutation
tests exactly the property you claim: "without this, the bad input gets through".
Restrictive mutation mostly tests that your fixtures are matched — which is a
different drill (the positive control), and one that should be run separately so
its red is attributable.

Corollary for the positive control: revert the MATCHED fixture to the default
builder and require the happy path to redden. Run it as its own drill so you can
tell the two failure modes apart.

Related: `mem:mutation-drill-red-on-wrong-assertion`,
`mem:mutation-drill-green-may-indict-the-mutation`,
`mem:qa-mutation-drill-can-redden-for-wrong-reason`,
`mem:task-task-de496f4785a242569aa4ffc3ef6f1d69-handoff`.
