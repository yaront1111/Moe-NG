# Decision: recovery command authentication precedence and candidate grants

For recovery-bound command authentication:

1. Validate and snapshot structural/cross-record shapes first. Missing, malformed, accessor-hostile, conflicting Session/Credential/CapabilityGrant/current-binding data returns `AUTHENTICATION_FAILED` from core `BINDING`.
2. The proof challenge carries both public refs. Production signature verification and replay/generation/session-state checks remain ahead of the current-recovery comparison, so an invalid proof cannot masquerade as a stale restore.
3. Add core layer `RECOVERY_BINDING` between `SESSION_STATE` and `EXPIRY`. A well-formed proof-bound Session/Credential whose refs differ from the freshly read selected-store pair returns `SESSION_REPLAYED`.
4. Capability exact tuple and canonical/conflict identity include both refs. Before expiry, derive only grants otherwise matching the command scope (principal/project/kind/target/transport). If any current candidate exists, prefer its exact match; if candidates exist but all are prior incarnation/key epoch, return `SESSION_REPLAYED/RECOVERY_BINDING`; unrelated stale grants do not poison another command.
5. The daemon reads `RECOVERY_BINDING_SLOTS[0]` fresh from its selected project-scoped store and never accepts a caller-selected ref or caches it. HTTP preserves stale as code `SESSION_REPLAYED`, stage `AUTHENTICATE`, layer `IDENTITY`.
6. Old records without refs remain unreadable/BINDING-refused. Never default them to current, and never serialize a signing handle, recovery nonce, bearer, private key, signature, or proof bytes.

This ordering pins the subject of every refusal test and prevents expiry or capability mismatch from shadowing the recovery fence.
