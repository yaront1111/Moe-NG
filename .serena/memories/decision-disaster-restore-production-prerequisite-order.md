# Disaster-restore prerequisite slicing decision

For production-backed disaster restore proof, split capability in this dependency order:
1. exact complete backup generation;
2. fresh non-restored recovery identity (nonce + signing-key epoch);
3. crash-safe two-slot installer;
4. recovery-bound authentication/grant fencing;
5. complete real external inventory adapters;
6. inventory/quarantine coordinator plus authority embargo;
7. exact human R3 completion digest and durable call site;
8. isolated fault lane;
9. final CORE-S14 proof.

Why: witness/reducer vocabulary is not a controller. A canary/fault proof cannot own the installer, inventory authority, or digest gate inside fixtures. Pure/adapter slices must record a real later consumer task ID; exports are not composition. Keep independent first slices PLANNING and dependent slices BACKLOG so shared-tree workers do not race guessed contracts. A shared root test lane is one cross-epic task and must serialize package.json ownership instead of being duplicated per platform/security/restore epic.
