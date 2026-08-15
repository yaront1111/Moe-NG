# Decision: the daemon HTTP Authenticator and the core session seam are separate. Do not merge.

Settled 2026-08-09 while planning `task-b4f12e63baca4ecc9f2c159ed3c3ad78`, answering the governor's
explicit coordination question against `task-8470a86013c94f08be640b568c2671da`.

## The question
Both are called "authentication". `apps/daemon/src/http/http-contract.ts:110` declares an
`Authenticator` port that `task-8470a860` consumes but is forbidden to implement. Is the core
session seam where that policy belongs?

## Answer: no — the separation is structural, not stylistic
- `Authenticator.authenticate(credential: string | null)` is called at `http-adapter.ts:154`.
- `decodeRuntimeCommandEnvelopeBytes` is called at `http-adapter.ts:163`.
- The documented pipeline at `http-adapter.ts:33` is
  `authenticate -> compatibility -> bounded decode -> registry -> authorize`, and the contract
  comment states the ordering exists so attacker bytes are never decoded for an unauthenticated
  caller.

A **pre-decode** gate cannot supply `commandId`, `requestDigest`, or a proof-of-possession — those
only exist after decoding. `authenticateSession` requires all three. Collapsing the two would force
decoding untrusted bytes before authentication, i.e. the exact inversion the daemon boundary exists
to prevent.

## Consequence
They compose in sequence; they are not the same decision. `task-8470a860` is deliberately NOT named
as a consumer of the core seam. If a future task proposes unifying them on the grounds that "both
are authentication", that is the argument to reject — check the call ordering in `http-adapter.ts`
first.

## Reusable shape
Two seams that share a word are only the same seam if they can see the same facts. Check what has
been decoded/derived at each call site before merging them.

See `mem:task-task-b4f12e63baca4ecc9f2c159ed3c3ad78-handoff`.
