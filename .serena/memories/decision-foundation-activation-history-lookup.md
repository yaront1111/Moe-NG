# Foundation activation history and coordination lookup decision

When adapting the one-event EffectActivationCommitted ledger to durable launch transitions without schema/DDL:

1. Keep the initial event, codec, aggregate derivation, and expected-version-0 commit authoritative and unchanged.
2. Append launch-fence transitions to the same aggregate at subsequent exact versions. Preserve the old strict reader by passing it only the isolated sequence-1 event; a separate history fold validates contiguous ordering and the exact tagged tail.
3. Same-command replay is authoritative only after the stored command-result bytes and the persisted event payload byte-match and decode to the current context. A different command racing the same expected version is a conflict, not a replay/adoption.
4. If a public lookup query contains effectId but not the fields needed to derive the aggregate and schema/index work is forbidden, a restart-safe global event scan is preferable to an in-memory map. Prove pagination completeness and uniqueness; malformed candidates, non-progress/truncation, duplicate matches, or read failure are UNKNOWN, never ABSENT.
5. Coordination time is epoch milliseconds, while scheduler lease deadlines are wall seconds. Use floor(ms/1000), and follow the scheduler's exact overdue rule: currentSeconds > deadline; equality remains live.
6. A stored PREFLIGHT registration is a reservation, never the launcher's priorRegistration. STARTED validates the durable prefix separately while the launcher continues to pass the original prior.
