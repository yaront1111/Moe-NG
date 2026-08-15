# Decision: runtime contract registry shape

Use three focused TypeScript responsibilities rather than one large registry:
1. `runtime-model.ts`: frozen tuple-derived lifecycle/operation vocabulary, nextAllowedCommands, and fresh-vs-historical result types.
2. `error-registry.ts`: exhaustive stable code registry with truth, retryability, recovery category/operations, transport mapping, valid sources, redaction, and UNKNOWN_ERROR fallback.
3. `runtime-envelopes.ts`: byte decoders that compose the existing bounded JSON decoder and enforce exact schema keys/versions.

Each module gets the repository-standard one-line `.js` bridge because root exports and inter-module NodeNext imports use `.js` specifiers under raw Node strip-types.

The design leaves query fields and literals open. Selected command fields are schemaVersion, commandKind, commandId, correlationId, requestDigest, sessionCredential, targetAggregateId, expectedVersion, optional all-or-none leaseAuthority, optional graph/policy revision hashes, and payload. Selected query fields are schemaVersion, queryKind, correlationId, sessionCredential, optional targetAggregateId/cursor, and payload; mutation-only fields are rejected.

Do not invent a smaller identifier limit: the pinned global JSON string/body/depth bounds are the wire bounds. Validate digest/hash fields as lowercase 64-hex and numeric versions/epochs as safe nonnegative integers.
