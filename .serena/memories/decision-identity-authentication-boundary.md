# Identity authentication boundary decision

For the M1 identity core, keep transport crypto and durable replay/idempotency outside the pure authorization decision while never trusting adapter booleans.

- Consume an already-decoded RuntimeCommandEnvelope.
- Inject a cryptographic proof verifier over the opaque credential, client-key binding, commandId, and requestDigest; false/throw/unknown fails closed.
- Inject an authoritative replay guard suitable for later use inside the applying transaction; UNKNOWN never authorizes.
- Session bearer reuse is normal. SESSION_REPLAYED applies to a proven reused proof or known closed/revoked/stale credential generation, not a same-command retry.
- Use exact capability tuple equality (principal, project, command kind, target aggregate, transport; optional step-up requirement), with no wildcards or prefix matching.
- Deterministic precedence: structural/cross-record/PoP failure -> AUTHENTICATION_FAILED; known replay/stale generation -> SESSION_REPLAYED; current credential expiry -> SESSION_EXPIRED; exact scope/step-up failure -> CAPABILITY_DENIED.
- Success returns only deeply frozen identity/scope facts; authentication never upgrades presence, evidence, lease, approval, or TruthClass.
- Signing algorithm, canonical proof byte format, TTL/skew, and renewal policy remain intentionally unchosen because the authoritative design does not pin them.