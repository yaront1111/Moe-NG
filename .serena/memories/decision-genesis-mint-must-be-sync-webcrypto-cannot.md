# The daemon recovery mint has a forced sync/async split

Established planning `task-2846816783104c52bfd4226782b10cc0` at HEAD `d7a71cb`.
This is an architectural constraint, not a preference — re-deriving it costs an
hour of dead-end work.

## The constraint

- `createStoreDependencies` (`apps/daemon/src/daemon-store-dependencies.ts:88`)
  is **synchronous** and calls `ensureGenesisRecoveryBinding` at line 98.
- `ensureGenesisRecoveryBinding`
  (`apps/daemon/src/identity/genesis-recovery-binding.ts`) is therefore
  synchronous too.
- The landed production crypto port `createNodeRecoveryCryptoPort`
  (`apps/daemon/src/recovery/recovery-incarnation.node.ts`) is built on
  `webcrypto.subtle`, which is **async-only**. There is no sync WebCrypto path.

So the genesis fence **cannot** reuse the landed port. It needs a `node:crypto`
sync shell (`generateKeyPairSync` / `sign` / `verify`). Making the port sync is
not an option; making startup async is a daemon-startup change that recovery
tasks scope out.

## Why that isn't a rail violation

The rail says reuse the landed *discipline* rather than write a *second*
implementation. Satisfy it at the **derivation and self-proof layer** — share
`contextParts` / `deriveIncarnation` / binding assembly — and let the two IO
shells differ only in which crypto API they call. One derivation, two shells.

## The trap

`createNodeRecoveryCryptoPort` is deliberately built on non-extractable
`CryptoKey` and its own comments explain that classic `KeyObject` was *rejected*
because it is structured-cloneable with exportable PKCS8. The sync shell is
forced back onto exactly that rejected `KeyObject`. So the sync path must
compensate by construction: return **no key handle at all**, never store the
private key in a map or closure, and let it die with the call. `JSON.stringify`
of a `KeyObject` misleadingly yields `{}` — it LOOKS contained and is not.

Related: `mem:task-task-2846816783104c52bfd4226782b10cc0-handoff`,
`mem:gotcha-discarded-proof-locals-make-a-classifier-impossible`.
