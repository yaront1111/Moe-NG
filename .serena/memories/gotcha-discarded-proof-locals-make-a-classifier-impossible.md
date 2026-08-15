# A mint that discards its proof locals makes any downstream classifier impossible

Found planning `task-69fdb23140ab472ebd34c3e4478c3ef2` against
`apps/daemon/src/identity/genesis-recovery-binding.ts`.

`mintGenesis` does everything right cryptographically — fresh entropy, real
Ed25519 keypair, domain-separated `digestOf` framing, a genuine sign/verify
self-proof round trip — and then returns:

```ts
return Object.freeze({ genesisDigest, incarnationRef, keyEpochRef });
```

`spki`, `fingerprint`, `bindingDigest` and `signature` are **locals**. They are
computed, used once to prove freshness in-process, and dropped. The durable
payload is `encoder.encode(minted.genesisDigest)` — 64 hex ASCII chars.

## Why this reads as done but is not

The code *looks* like a complete self-proving identity, and its comments say so.
Every ingredient of a verifiable proof appears in the function body, so a grep
for `spki`/`fingerprint`/`sign`/`verify` **hits**, and a reviewer concludes the
proof exists. It does not: the proof was ephemeral. Nothing outside that call
stack can re-verify anything, because verifying a signature requires the public
key and the public key was never persisted.

## The generalisable trap

When checking whether a proof/binding/attestation is available to a *later*
reader, grep the **return type and the persisted bytes**, never the function
body. A symbol computed inside a mint is evidence about that call, not evidence
on disk. Ask: what exactly lands in the durable row?

Corollary that blocked a whole task: a downstream classifier asked to accept
"a payload whose full public proof and binding digest agree" is unimplementable
here — not hard, *impossible* — and the only rail-compliant moves are to fix the
producer or report blocked. Do not narrow the consumer's DoD to whatever the
producer happens to persist today; that silently retires the requirement.

Related: `mem:task-task-69fdb23140ab472ebd34c3e4478c3ef2-handoff`,
`mem:deps-done-is-not-deps-reachable` (same family: a present symbol is not a
usable symbol).
