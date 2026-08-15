# An unreachable fail-closed arm cannot be pinned through the seam

Symptom: you add a defensive third branch — "identity matches neither declared
format -> refuse with a stable code" — and then discover no input reaching the
public entry point can produce it, because every caller of the internal
function builds its argument from the same shared constructor you are
validating.

Concrete case (moe-next, `claude-launcher-authority.ts`): the registration
phase classifier refuses an identity that is neither `pending:<wrapper>` nor
`windows:<pid>:<time>`. But `launchClaude` builds BOTH strings with
`pendingProcessIdentity` / `startedProcessIdentity`, so `registerLaunchLock`
can only ever hand back one of the two. The guard is correct and worth keeping
— a third registration phase added later must refuse rather than be filed under
STARTED and persisted as process authority — but it is dead today.

## Why "leave it untested" is the wrong call

Epic rail 6 in this repo: a property must be asserted against the production
surface, and a guard nothing asserts is exactly the assertion-detached-from-its
-subject failure mode. Deleting the guard is also wrong: it is the fail-closed
default that stops a future silent mislabel.

## The move

Factor the arm into its own exported production function and pin it DIRECTLY —
module-level export, deliberately NOT added to the published surface, with a
negative control in the barrel test asserting it stays off the root.

    export function classifyRegistrationPhase(r): Phase | null
    export function durableRegistrationPort(commit): (r, claim, prior) => unknown

Then assert the OUTCOME on the production function (exact code, exact layer,
and that the downstream port was never called), not merely that it returned
null. A mutation drill widening the classifier must redden both.

This is a real production surface, not a test helper reimplementing one, so it
satisfies the rail. The negative control keeps the seam from silently widening
just because testability needed an export.

Related: `mem:gotcha-closed-enum-makes-a-refusal-code-unreachable`.
