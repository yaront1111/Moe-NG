# A set-level validator silently steals every per-layer refusal behind it

Measured 2026-08-10 building `packages/scheduler/src/supersession/` (task-069853689ed64398).

## The trap
You build a producer set: an orchestrator parses a list of caller facts, then hands each entry to N
family producers, each of which refuses with its OWN layer so a test can pin WHICH layer refused.
The natural instinct is to validate the whole fact record up front — "fail fast, one place".

Do that and every per-layer refusal test becomes a lie. The set-level parser answers first, so:

    expect(refusal(build(nodesWithUnknownAttemptFact)))
      .toEqual({ code: "PLANNING_DISPOSITION_UNKNOWN", layer: "...ATTEMPT", ok: false })

either fails outright, or — worse — you "fix" it by loosening the expected layer to the SET layer and
the attempt producer's refusal branch is now **never reached by any test**. Suite green, guard dead.
Same family as `mem:refusal-test-answered-by-earlier-guard`, but caused by your own design rather
than by a pre-existing guard.

## The rule
Split validation by OWNERSHIP, not by convenience:
- The set-level parser checks only what the SET cannot be assembled without — exact key set, the
  discriminant is in the declared vocabulary, identity non-empty, no duplicate identity.
- Everything a family (or a landed primitive) owns stays `unknown` at the set level and is typed
  `unknown` in the facts interface, with a comment saying why.

In this module `SupersessionNodeFacts` declares `attemptLifecycle`, `effectsTerminal`,
`resource.*` and `budget.*` as `unknown` precisely so the set-level `exactRecord` cannot be tempted
to type-check them. Each family then refuses from its own layer, and the tests pin `{code, layer}`.

## How to prove you got it right
Mutate the family's refusal branch away and confirm the test reddens **on the code**, not merely on
"it refused". When I removed the `lifecycle === "UNKNOWN"` guard the case fell through to the
CONSEQUENCE_CHANGED branch and the test went red on the wrong code — which is exactly the signal that
the assertion is pinned to the subject and not to a generic upstream refusal.

Corollary: a per-family layer constant (`..._ATTEMPT`, `..._EFFECT`, `..._RESOURCE`, `..._BUDGET`)
costs four strings and is what makes "which layer refused" assertable at all. A single module-wide
layer makes the whole distinction untestable.
