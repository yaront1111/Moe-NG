# Decision: durable non-command session authority persistence

For daemon session proof authority over non-command transports:
- compose the public @moe/core `authenticateSession` surface; do not duplicate its seven-layer precedence or accept caller-injected verifier/replay/session verdicts;
- keep the legacy bearer session command path separate and unchanged;
- store immutable principal creation in a principal aggregate and open/renew/rotate/close in a session aggregate;
- store replay evidence in a deterministic separate aggregate whose identity is SHA-256 of the canonical `(sessionId,generation,clientKeyId,nonce)` tuple, so same nonce deduplicates durably, different nonces do not conflict, and raw nonce/proof/signature never persists;
- use SqliteEventStore command decisions for lifecycle idempotency and return the original persisted result/receipt bytes on replay;
- fold all event pages strictly; any unknown/malformed/gapped event yields UNKNOWN and no partial authority;
- authenticate from committed principal/session/credential/public-key records, with a daemon-owned concrete Ed25519 verifier and replay closure, then return frozen facts bound to session version/authority digest/replay digest;
- downstream mutations must re-check the current session-authority record; an authentication observation is not command/lifecycle authority.

Applied first by `task-21713cf152c047c597da9765d8d95510`; consumers are `task-04e4367443214a588ed6277b92969a33` and `task-4afcb06422ed4adb89430b7ea9758d7f`.