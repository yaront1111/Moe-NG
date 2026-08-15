# `read.bindingDigest` is NOT `binding.bindingDigest`

Two unrelated digests share the field name across the store/daemon boundary.
Asserting they are equal refuses every VALID binding.

**Store side** — `packages/store/src/recovery-install-codec.ts:109`, surfaced as
`read.bindingDigest` from `readRecoveryBinding` and as `encoded.digest` from
`encodeRecoveryBinding`:

```
sha256(frame([slot, incarnationRef, keyEpochRef, installedAt, payload]))
```

It covers the ROW — including `installedAt` and the slot name.

**Daemon side** — `apps/daemon/src/recovery/recovery-incarnation-context.ts:158`,
inside the binding itself:

```
digestOf("binding", SCHEMA_VERSION, ...contextParts, incarnationDigest,
         incarnationRef, keyEpochRef, verificationKeyFingerprint, publicKeySpkiHex)
```

It covers the DERIVATION INPUTS and nothing about the row.

## What to do instead

To check a binding "recomputes from its contents", rebuild the context from the
daemon's asserted identity and re-derive:

```ts
const context = snapshotGenesisContext({ projectId });   // never trust the payload's
const derived = deriveIncarnation({ context, incarnationDigest,
  publicKeySpkiHex, verificationKeyFingerprint });
// require derived.{incarnationRef,keyEpochRef,bindingDigest,challengeDigest} to match
```

Also re-derive `verificationKeyFingerprint` as `digestOf("key", spki)` — it is a
derivation INPUT, so nothing else pins it to the key that actually signs.

You do not need to re-check the row digest at all: the store already refuses the
read with `RECOVERY_BINDING_DIGEST_MISMATCH` before handing the bytes over.

**The trap is that either mistake looks fine in review.** Asserting equality
reads as rigor and fails closed on everything; skipping the recomputation reads
as trust and admits a forged binding. Measure which digest you hold before
writing the comparison.
