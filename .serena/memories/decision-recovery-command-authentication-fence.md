# Decision: recovery command authentication uses the selected store stamp

For task-8a01c025 and follow-ons:

- The crash-safe installer already stamps the selected restored database at the fixed `RECOVERY_BINDING_SLOTS[0]` row. A daemon authentication adapter reads that exact row fresh and takes no recovery ref from an HTTP request.
- Keep pre-decode bearer authentication and post-decode proof-of-possession authentication separate; they see different facts. Both compare against the same selected-store public refs.
- Persist `recoveryIncarnationRef` and `keyEpochRef` at credential/grant issuance. Missing/unbound restored records never receive defaults.
- Structural/cross-record spoofing stays `AUTHENTICATION_FAILED`. A well-formed prior public binding is `SESSION_REPLAYED` before expiry or capability matching. HTTP preserves this as stage `AUTHENTICATE`, layer `IDENTITY`.
- Both refs belong in the signed challenge framing and grant canonical/conflict identity.
- Only public digest refs cross the boundary. Never serialize a recovery key handle, private key, proof signature, nonce, raw bearer, or presented proof bytes.
- A stale grant needs an explicit stale classification; merely adding the refs to the exact capability tuple would incorrectly degrade it to `CAPABILITY_DENIED`.
