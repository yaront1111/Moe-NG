# Store input validation-order compatibility

The store normalization boundary has observable fail precedence and copy semantics; preserve these across refactors.

- Commit order: plain input -> events property/container/cap/nonempty -> commandBytes -> each event.
- Event order: record -> eventId/duplicate -> outbox container/cap; each message record -> messageId/duplicate -> headers -> payload -> topic; only then eventType -> metadata -> event payload.
- Top-level aggregateId, commandId, committedAt, expectedVersion validate only after every event.
- Byte budget order: commandBytes, each message headers/payload, each event metadata/payload.
- Reserved scan: aggregateId -> commandId (unless exact allowed internal receipt ID) -> each eventId -> reserved audit type -> its message IDs.
- Decision request: commandKind -> expectedVersion -> key(commandId,principalId,projectId) -> copied requestBytes -> targetAggregateId.
- Metadata hashes correlationId before decidedAt.
- Committed proposal charges/copies committedResultBytes first, then commit request/effects under the same MAX_COMMIT_BYTES budget, then reserved identifiers.
- Snapshots are new mutable objects/arrays and copied Uint8Arrays; do not add freezing except the existing shallow-frozen CommandDecisionKey. inputRecord deliberately aliases the plain input only for later synchronous descriptor reads and is not persisted.
- Check proxies before Array.isArray because revoked proxies otherwise throw outside the stable error contract.