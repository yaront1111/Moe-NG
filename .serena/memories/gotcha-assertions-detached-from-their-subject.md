# Gotcha: the one bug class behind every green-but-hollow suite here

Found across four QA reviews in one session (qa-bdf27860 + qa-813cd351, 2026-08-07).
Four different surfaces, same defect: **an assertion that has quietly detached from the
thing it was written to prove, and stays green while proving nothing.** Every instance
was invisible to a passing suite and only surfaced under mutation.

## The four costumes

1. **Generator never reaches the shape** — `packages/core/src/policy/policy-invariants.test.ts`
   asserted "no seed reaches ALLOW with a missing required fact" over 320 seeds, but the
   chain generator never emitted the redeclaration that shrinks a rule's required-fact
   set. The property was true and vacuous. See `mem:gotcha-policy-slice-relaxation`.
2. **Property asserted against the helper, not the entry point** —
   `packages/scheduler/src/admission`: the AGENT_REPORTED-never-admits rule was tested
   against `evaluateNecessityClaim` while `admitGraph`, the only caller anyone uses,
   never routed through it. The helper was correct and unreachable.
3. **Fixture default beats the evidence path** — same task: every happy-path fixture
   omitted `necessityWitness`, and the omission defaulted to the one accepted witness
   kind. Omitting evidence beat supplying it, and no test could see it because every
   test relied on the default.
4. **Refusal test that cannot name the layer** — `packages/mcp/src/http`: disabling the
   adapter's own loopback refusal killed the evil-Origin test but NOT the evil-Host one,
   because the transport pins allowedHosts independently. Defense in depth is good; a
   test that asserts only "refused" cannot tell you which layer refused, so it stays
   green after one of two layers is removed.

5. **Expected value re-derives production's formula** — `apps/control-room/src/scaffold.test.tsx` computed the same live/refresh expression as `fixtures.ts`. Changing production to `const live = true` changed nothing the test could observe because disconnected/historical fixtures also had empty commands. Fix with one fixture per predicate leg where every other predicate permits, plus fixed exhaustive expected values. The exact mutation must make the suite red.

## What to do

- **Assert the reason code, not just the outcome.** `expect(refused).toBe(true)` is one
  layer away from vacuous the moment a second layer exists. Pin the stable code.
- **Test the entry point, not only the helper.** A guarantee that lives in a function no
  caller is structurally forced through is not a guarantee.
- **Never let a fixture default carry a security-relevant field.** Supply it explicitly
  in fixtures so omission is a distinct, testable case.
- **Count shapes, not just outcomes,** in a non-vacuity report. Reaching all four
  outcomes proves nothing about reaching all structural inputs.

## How to find them

Reading does not find these — mutation does. Break the thing on purpose and require the
suite to go red; if it stays green, the assertion is detached. Two results worth
remembering:

- Timing can be the assertion: removing a streaming byte cap killed 3 tests AND took the
  suite 0.4s -> 22s, because the unbounded read actually materialised. The wall clock was
  stronger evidence than any assertion about the bound.
- A green mutation is not always a defect: changing a PRNG shift constant left a property
  suite 7/7 green, which is CORRECT — properties should be stream-independent. Judge the
  mutation against what the assertion claims, not against "did anything go red".

Always revert on a single owned path (`git checkout -- <path>`), confirm
`git status --porcelain` is empty, and re-run the suite green before signing off — this
repo is a shared working tree and a stray mutation is worse than a missed check.

See `mem:pattern-qa-verifying-a-pure-refactor` for the byte-containment technique that
makes refactor review mechanical instead of trust-based.
