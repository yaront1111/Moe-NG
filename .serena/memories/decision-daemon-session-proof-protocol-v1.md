# Decision: daemon session proof protocol v1

Human approved in the REPL on 2026-08-09 for task-21713cf152c047c597da9765d8d95510.

- Algorithm: Ed25519.
- Persisted public-key encoding: canonical DER SPKI as lowercase hex.
- Signature encoding: exactly 64 bytes as lowercase hex.
- `clientKeyId`: SHA-256 of the complete canonical SPKI bytes.
- Signed challenge: ASCII domain `moe.session-proof.v1`, followed by fixed-order `u32be byteLength || bytes` frames for principal, project, session, credential ID/generation, client key, transport/scope, request ID/digest, issued-at epoch milliseconds, and a 128-bit nonce.
- Proof freshness: maximum age 60 seconds; maximum future clock skew 30 seconds.
- Session lifetime: initial/renewed TTL 15 minutes, capped at an absolute 8 hours from open.
- Renewal: requires a fresh current-generation proof and changes expiry only; it does not rotate credential or key.
- Rotation: atomically increments credential generation, replaces credential and client key, and revokes the previous generation. Require signatures from both old and new keys over the same rotation challenge.
- Replay identity: durable `(sessionId, generation, clientKeyId, nonce)`. Any reuse is `SESSION_REPLAYED`; retrying the same request with a fresh nonce is allowed.
- Only durable evidence and public material may be stored. Never persist private keys, plaintext credentials, signatures, nonces, or presented proof bytes.

This fills the choices intentionally left open by `mem:decision-identity-authentication-boundary`; it does not change that pure core authentication treats verifier/replay answers as evidence and never as caller authority.