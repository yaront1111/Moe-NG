# Decision: a new module never re-codes another module's refusal

Recurring shape in @moe/runner: a new module sits between two landed surfaces whose stable reason-code lists (`RUNNER_EVIDENCE_ERROR_CODES`, `SUPERVISOR_ERROR_CODES`) and refusal-layer lists live in files the new task does not own.

**Do not widen a foreign frozen list.** Those lists are closed vocabularies shared with in-flight work; adding a member from a neighbouring task is a silent collision in the shared worktree.

**Instead:** the new module defines its OWN frozen code + layer lists for the facts it actually owns, and returns foreign failures **verbatim** behind a `source` discriminant:

```ts
type Refusal =
  | { source: "PROCESS";    failure: OwnFailure }
  | { source: "SUPERVISOR"; failure: SupervisorFailure }  // keeps its GRANT/ACTIVATION/KERNEL layer
  | { source: "EVIDENCE";   failure: EvidenceFailure }    // keeps its EXECUTION layer
```

Why this matters beyond tidiness: epic rail 6 requires a failure-path test to pin **which layer refused**, not merely that it refused. Re-coding a foreign failure into a local code erases exactly that signal, and a test written against the local code stays green after a gate is deleted because a different layer starts answering first.

## Corollary — a conservative earlier guard is allowed, and must be distinguishable

When the authoritative check lives downstream but running it late would mean paying a real external effect for nothing (spawning a child for an observation that can never discharge anything), duplicating the check as an EARLIER, more conservative guard is correct. It is never a replacement — the authoritative gate still runs after.

Prove they are genuinely two layers: one test pins the early layer/code with an invocation-count of 0, a sibling test drives the same rule past the early guard and pins the downstream layer/code. Mutation-drill by deleting the early guard: the first test must go red while the sibling stays green. If deleting the guard changes nothing, the "two layers" were one.

First applied in `mem:task-task-69f2b6f785ca4ba3a932a8256b0edfb8-handoff` (verifier process wrapper: pre-spawn `truthClass !== "PROVEN"` guard at PROCESS/LAUNCH_GATE vs `observedExecutionRejection`'s EVIDENCE/EXECUTION refusal).
