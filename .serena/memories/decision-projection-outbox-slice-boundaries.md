# Projection/outbox slice boundary decision

Do not implement authoritative projections, inbox receipts, or subscription generations solely as new store subtrees while the exact SQLite schema and event commit transaction remain closed.

Required order:
1. Versioned event/schema and exact migration objects.
2. One transaction integration seam inside the existing event commit path.
3. Pure deterministic upcasters/projection rebuild with scratch generation and verified swap.
4. At-least-once relay plus durable consumer/message/digest inbox receipt.
5. Strict-after cursors bound to projection generation, with typed CURSOR_GAP and verified snapshot digest; final crash/property/rebuild parity.

Never:
- create undeclared SQLite tables behind the exact schema validator,
- update projections after the event COMMIT,
- treat storage envelope record_version as a domain schema version,
- fake durability with an in-memory port,
- claim exactly-once external effects from outbox/inbox,
- silently skip poison or cursor gaps,
- activate a candidate rebuild generation before parity/digest verification.