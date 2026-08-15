# A hostile-input test suite can probe only the outer wrapper and never reach the validators

Found by adversarial self-review on `task-45d12ecfa6ae4938b23af28fe7876a44`, after the suite was already green.

The macOS boundary classifier lifts an ENVELOPE (`host / observedAt / truthClass / fact`) through a hardened snapshot helper, then hands the raw `fact` value to one of seven per-boundary payload validators. My hostile-shape tests — symbol-keyed extra, non-enumerable extra, accessor-backed field, throwing-`ownKeys` proxy, throwing-descriptor proxy — ALL wrapped the envelope. Every one of them was answered by the envelope snapshot and returned before a single payload validator ran.

Result: seven readers (a provider-observation snapshot, `parseMirroredLease`, a version probe, a crash-kind read, a path check) had zero hostile coverage, in a file whose whole subject is hostile input. The suite looked thorough.

## The check

For any layered validator, ask which layer ANSWERED each hostile case. If an outer guard refuses first, everything behind it is untested no matter how many hostile fixtures you wrote. Build the outer layers WELL-FORMED and put the hostile value at the depth you mean to test:

```ts
// well-formed envelope, hostile payload — now the per-boundary reader runs
observeMacosPlatform(withMacosFact(boundary, macosEnvelope(hostileProxy)))
```

Sweep it over every boundary and assert the generated count.

## Then drill it, because it may pass on day one

The new test passed immediately, which is the moment to be suspicious rather than satisfied. Deleting the `try/catch` from the local `ownValue`-style descriptor reader turned it RED with `Error: payload descriptor refused` thrown OUT of the seam. That proved two things at once: the test is non-vacuous, and the try/catch is load-bearing.

Note the landed Linux `ownValue` in `packages/runner/src/platform/linux-facts.ts` has NO try/catch, so a proxy trapping `getOwnPropertyDescriptor` supplied as a Linux fact payload will throw out of that seam. Not fixed here — it is outside that task's owned paths — but it is a real fail-open on a fail-closed surface and worth a task.

Related: `mem:refusal-test-answered-by-earlier-guard`, `mem:guard-downstream-of-normalizing-copy-is-unreachable`, `mem:array-isarray-throws-on-revoked-proxy`.
