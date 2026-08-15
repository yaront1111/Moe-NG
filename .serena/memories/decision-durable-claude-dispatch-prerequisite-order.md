# Decision: durable Claude dispatch prerequisite order

Current `launchClaude` is a safe physical boundary but not yet a durable daemon composition seam. It validates a committed UNUSED activation grant, then consumes it only in-memory and uses a pure two-phase launch-lock registration; pre-consuming durably causes `GRANT_ALREADY_CONSUMED`, while leaving defaults permits a crash after open with durable grant still UNUSED/no real process registration. Its all-or-nothing dependency override cannot be used by daemon without reimplementing private runtime-pin/Job/lock truth.

Required order:
1. Land shared `EffectActivationCommitted` authority/reader (`task-df29871...`).
2. Add a public `createClaudeLauncher({consumeGrantDurably, commitProcessRegistration})`-style narrow overlay (`task-c81953d2...`) that merges private real defaults. Keep preflight registration pure; persist only the proven started identity. Compare prepared runtime observation digest with the committed `EffectIntent.runtimeObservationDigest` before CAS/open.
3. Add daemon bridge (`task-996e5318...`) using df298 for exact durable grant CAS/registration/replay and derive current effect/session binding only from committed intentId plus active lease ownerSessionRef.
4. Compose dispatch service, then authenticated ingress (`task-a9fd91c3...`) after registry extraction/effect.activate ingress.

Do not pre-consume then call the current launcher, export every private default, persist the pending registration, add SQLite schema, or let caller-selected runtime/effect/session facts authorize anything.