# Decision: how a daemon gets durable authority into @moe/runner's Claude launcher

Reusable shape for injecting caller authority into a launcher whose production defaults must
stay unreplaceable. Decided while planning task-c81953d210f14cdeb9f6070a443b6750.

## The shape
`createClaudeLauncher(authority)` returns `(value, options?) => launchClaude(value, {...options,
deps: {...(options?.deps ?? CLAUDE_LAUNCHER_DEFAULTS), consumeGrant, registerLock}})`.
Authority capabilities are bound ONCE at construction with the already-exported `readCapability`;
a malformed authority yields a launcher that always refuses a stable code, never a constructor throw.

## Four rules that generalize

1. **Merge into existing port slots; never add a port key.** A `snapshotPorts`-style validator that
   requires every key in a closed `PORT_KEYS` list turns a new key into a silent refusal for every
   existing caller that hands a full dependency object. Wrap the existing slot instead — zero blast radius.

2. **Compose with the pure authority; do not let the caller replace it.** Pure validation
   (`registerLaunchLock`: claim binding, one-time-credential reuse, prior conflict) runs FIRST and
   its refusal is returned verbatim. Only its success arm is handed to the injected durable port.
   A port that replaces the pure function forces the caller to reimplement authority — the exact
   thing the overlay exists to prevent.

3. **...EXCEPT where the DoD requires the injected layer to be the answering layer.** Grant replay
   must be answered by the durable CAS, so the overlay delegates straight through with no pure
   pre-check. Pre-running the pure function there makes the delegated-code test vacuous — a
   textbook `mem:refusal-test-answered-by-earlier-guard`. Deciding rule: pre-run the pure layer
   when it validates a DIFFERENT property; skip it when it would answer the SAME question.

4. **Discriminate repeated port invocations by a phase argument, not by ordinal or by string
   sniffing at the callee.** The launcher calls registration twice (pending identity pre-open,
   proven identity post-start). Pass an explicit `{phase:"PREFLIGHT"|"STARTED"}`. A per-call
   counter silently mislabels if call order changes; the caller guessing from the identity string
   duplicates a private format. Put the identity builders in the shared contract module so every
   call site and the classifier read one source of truth.

## Containment is inherited — do not re-add it
The wrapped slots already run inside the launcher's `contained()` / lifecycle try-catch. Adding a
try/catch inside the overlay wrapper swallows the throw and mislabels which layer refused. Keep
wrappers synchronous; a Promise returned by an authority port must NOT be awaited — the existing
decoder sees a non-record and fails closed, which is the correct outcome and must be asserted.

## What the daemon must never do
Feed a self-written PREFLIGHT reservation back as `priorRegistration`. `registerLaunchLock`
refuses on ANY non-null prior, and a pending row with the same bootstrap credential digest yields
`LAUNCH_LOCK_CREDENTIAL_REUSED` on restart instead of adoption. Persist only the proven
`windows:<pid>:<creationTime>` identity.

## Proving the factory actually composes shipped defaults
Cannot be proven from an import list. Mutate a real default primitive in ITS OWN file (e.g. the
`EXIT_BEFORE_LAUNCH` literal in `duplicate-delivery.ts`) and require the factory's real-defaults
test to redden on a named value. See `mem:qa-prove-composition-by-mutating-the-real-primitive`.

Related: `mem:decision-durable-claude-dispatch-prerequisite-order`,
`mem:decision-claude-launcher-total-result-containment`.
