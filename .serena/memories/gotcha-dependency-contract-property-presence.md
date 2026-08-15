# Gotcha: exact optional contract presence

At hostile-input boundaries, a safely normalized record still must distinguish an omitted optional property from an own data property whose value is `undefined`. Testing `record.contract !== undefined` collapses those states and can let `{ edgeKind: "RELATED", contract: undefined }` masquerade as contract-free advisory input.

Use `Object.hasOwn(normalized, "contract")` after descriptor-safe normalization. In the dependency kernel: omitted hard contract -> `DEPENDENCY_HARD_CONTRACT_REQUIRED`; own undefined hard contract -> `DEPENDENCY_CONTRACT_MALFORMED`; any own contract property on a nonblocking relation -> `DEPENDENCY_ADVISORY_CONTRACT_FORBIDDEN`.