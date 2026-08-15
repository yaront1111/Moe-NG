# A pristine-install guard can refuse the LOSER for history the WINNER just wrote

`packages/store/src/recovery-initial-install.ts` `readPristineBlocker` checks, in order:

1. PENDING binding staged?
2. **authoritative history present?**  <- before (3)
3. ACTIVE slot already bound? -> `CURRENT` (the exact valid winner)

`ensureGenesisRecoveryBinding` installs and then **anchors** the incarnation, and that anchor is a
committed `recovery.incarnate` decision + `RecoveryIncarnationAnchored` event — i.e. it IS
authoritative history. So in a real two-handle race the loser's outcome depends on timing:

- loser installs BEFORE the winner anchors -> `CURRENT` (the intended arm)
- loser installs AFTER  the winner anchors -> `REFUSED / RECOVERY_INITIAL_INSTALL_HISTORY_PRESENT`

The second arm made a concurrently-booting second daemon die with
`GENESIS_RECOVERY_BINDING_FAILED`, over a store that was perfectly well fenced.

## The fix, and why it does not weaken the guard

`refuseOrAdopt` in `apps/daemon/src/identity/genesis-recovery-binding.ts`: on ANY install refusal,
re-read the ACTIVE slot.

- slot holds a valid binding -> lost race, settle **PRESENT** on that binding
- slot still unbound -> refuse, carrying the store's own code **verbatim**

Nothing is minted on that path — it reports the fence already on disk, exactly as an entry-time FOUND
slot does. The history guard is intact: a store with real history and no binding still refuses, and a
test asserts nothing was written. PENDING_PRESENT and SCOPE_REQUIRED also still refuse, because their
slot is likewise unbound.

## Generalisation worth remembering

When a guard's precondition can be created by a CONCURRENT PEER doing the very thing the guard
protects, the refusal is not final on its own — re-observe the state the guard was protecting before
turning it into a fatal error. Otherwise the honest outcome is "you lost a race" reported as "your
store is corrupt".

Test both doors deterministically with separate stubbed cases; do NOT assert the loser's *internal*
path in the race test — assert only that its OUTCOME is PRESENT, which holds either way.
