# Gotcha: core's GENERATION layer is unreachable if you bind the CURRENT key

`packages/core/src/identity/authenticate-session.ts` refuses at BINDING when
`proof.clientKeyId !== session.clientKeyId`, and that check runs *before*
`isCurrentGeneration(session, credential)`.

So a daemon that composes the seam by passing the durable session as-is —
current generation, current clientKeyId — can never produce
`SESSION_REPLAYED / GENERATION`. A request presenting a superseded credential
carries the OLD clientKeyId, mismatches the session's current one, and comes
back as `AUTHENTICATION_FAILED / BINDING` instead. The GENERATION branch is dead
code, and a test asserting only "it refused" stays green while the layer it
claims to cover never runs.

## The composition that works

Keep a durable credential history per session (`credentialId -> {generation,
clientKeyId, publicKeySpkiHex, revoked}`). Resolve the PRESENTED credentialId
against that history, then hand core:

- `session`: the durable session, but with `clientKeyId` set to the *resolved
  credential's own* durable key;
- `credential`: that credential's durable generation and revoked flag.

Binding then passes on authentic durable material, and
`isCurrentGeneration` is what actually decides. This is not a forgery: on the
success path the presented credential IS the current one, so the returned
`facts.clientKeyId` is the live key.

Verify it by mutation: force the core credential to
`{generation: session.generation, revoked: false}` and the GENERATION row must
go red. Applied in `apps/daemon/src/identity/session-authority.ts`
(`mem:task-task-21713cf152c047c597da9765d8d95510-handoff`).
