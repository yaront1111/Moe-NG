# Decision: daemon-local durable recovery inventory bridge

When recovery needs semantic classes that are present in the daemon's frozen proof mapping but absent from runner's frozen node-side registration union, do not widen runner merely for composition. Use an explicit daemon-local typed registration fragment beside runner registrations.

For resource/integration post-restore inventory, an existing `SqliteEventStore` can be used without schema changes if and only if:
- the implementation writes to one dedicated typed aggregate rather than inferring completeness from a generic event scan;
- every entry is canonically bound to project, backup cursor/generation, and the store/anchor-selected current recovery refs;
- one terminal seal proves exact configured-class cardinality, ordered entry digests, and a negative proof for empty classes;
- readers verify trace, canonical bytes, sequence, seal position, counts, uniqueness, and current binding before returning COMPLETE;
- partial/missing/unreadable evidence remains UNKNOWN with the originating stable code/layer;
- the bridge returns raw observations/proofs and leaves adoption, quarantine, embargo, and recovery.complete to the consumer.

This seam keeps @moe/store dependency-free, does not duplicate scheduler transition authority, and gives the daemon a durable restart-composable source.