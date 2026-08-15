# Daemon command registry seam (apps/daemon)

`apps/daemon/src/daemon-command-registry.ts` (landed 2026-08-14, task-9cba79a1)
owns the whole command table: `CAPABILITIES`, the four family maps, the 20
ordered `PAYLOAD_KEYS` allow-lists, `agentCapabilitiesFor`,
`OPERATOR_CAPABILITIES`, `DomainRefusal`/`decisionOf`/`refusal`, and
`createDaemonCommandPorts({clock, projectId, store}) -> frozen {decisions, registry}`.
`daemon-store-dependencies.ts` (176 lines) only composes: store lifecycle,
authenticator, subscriptions, affordances, dossiers, restore, default provider.
It re-exports `agentCapabilitiesFor` because `orchestrator/agent-wrapper.ts`
imports it from `./daemon-store-dependencies.js`.

## Non-obvious facts measured on the live surface

- Registry order comes from `Object.keys(PAYLOAD_KEYS)`; registry size is 20.
- `checkPayload` in `http/http-adapter.ts` rejects only UNLISTED keys. A payload
  of `{}` passes PAYLOAD_SHAPE and reaches DISPATCH for every kind, which is
  what makes an empty-payload sweep a usable characterization of the family
  handlers (all 20 refuse 422: bootstrap kinds split between
  `BOOTSTRAP_PREREQUISITE_MISSING`/`DAEMON_PREREQUISITE` and
  `BOOTSTRAP_PAYLOAD_INVALID`/`DAEMON_INGRESS`; review/session/work families
  answer `<FAMILY>_PAYLOAD_INVALID`/`DAEMON_INGRESS`).
- Idempotency is keyed on the command id, NOT on the request bytes: the store
  gets `requestBytes = {kind, payload}` and a bootstrap replay short-circuits in
  the ledger, so re-sending the same commandId with a DIFFERENT payload returns
  `REPLAYED` with the original effectId - it does not raise
  `IdempotencyConflictError`. The 409/DURABLE_STORE translation is reachable
  only by driving `decisions.decide` directly with a throwing commit thunk.
- `decidedAt` (the injected clock) surfaces as `StreamEvent.committedAt`
  (`decision-ledger-canonical.ts` sets `committedAt: decidedAt`), and for
  `project.register` the injected `projectId` IS the aggregateId. That pair is
  the cheapest production-surface proof that the request is server-assembled.
- PRE-EXISTING, preserved verbatim by the extraction: `agentCapabilitiesFor`
  tests membership with `kind in FAMILY_MAP`, so prototype keys hit the
  prototype chain - `agentCapabilitiesFor("toString")` returns
  `[Function, "work.write"]` instead of null. Same for `constructor`,
  `__proto__`, `hasOwnProperty`. Registry construction is unaffected (it maps
  over `Object.keys(PAYLOAD_KEYS)`). Fixing it is a behaviour change and needs
  its own task.
