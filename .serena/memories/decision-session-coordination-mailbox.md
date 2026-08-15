# Decision: session coordination uses store-backed addressed aggregates

For `packages/coordination`, durable communication is not peer authority or chat.

- Persist canonical envelopes as one event plus outbox draft in a deterministic recipient mailbox aggregate on the existing `SqliteEventStore`.
- Use aggregate sequence as strict mailbox order; represent acknowledgements in a deterministic recipient/consumer aggregate so restart resumes from durable truth.
- Same message id and identical canonical bytes deduplicates through the store receipt; same id with different bytes is a typed idempotency conflict.
- Reads repeat unacknowledged messages (at-least-once). Replay takes an explicit historical cursor and never advances the durable ack. Ahead, missing, or non-contiguous cursors are typed CURSOR_GAP outcomes.
- Expired entries remain visible as typed sequence-bearing EXPIRED records until explicitly acknowledged; never silently filter them.
- Keep endpoint authentication/capability in an injected identity port bound to the exact request digest. Strip credentials/proofs before persistence.
- A terminal/effect address is valid only after current effectId+sessionId resolution. A RESPONSE must resolve a durable REQUEST, reverse its addresses, and preserve correlation.
- Advisory text is always frozen `advisoryOnly: true` data and has no lifecycle, dispatch, command, credential, or authority affordance.
- Do not persist under ignored `.moe/sessions/`, add an alternate SQLite schema, reach through `@moe/store` package internals, or treat outbox at-least-once delivery as exactly once.