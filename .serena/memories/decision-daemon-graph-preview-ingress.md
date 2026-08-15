# Daemon graph-preview byte ingress

Stable v1 boundary decision:

- Runtime export: `evaluateGraphPreviewRequestBytes(input)` from package root `@moe/daemon` only.
- Decoded request: exact own-key object `{ schemaVersion: "moe-graph-preview-request/1", snapshot, options? }`; `schemaVersion` and `snapshot` required, `options` optional, no extra keys.
- Trust-boundary taxonomy:
  - `INPUT_REJECTED`: `decodeBoundedJsonBytes` rejected input bytes/UTF-8/JSON/resource bounds; preserve its stable code/message.
  - `REQUEST_INVALID`: decoded value is not the exact top-level request envelope.
  - `REQUEST_EVALUATED`: envelope is valid; carry the unchanged `previewGraphSnapshot` result even when graph/options/policy/frontier are invalid.
- Every outer result is frozen, `advisoryOnly: true`, `authority: "NONE"`; evaluated does not mean graph-valid or command-admitted.
- Decode before all schema inspection; invoke scheduler once only for a valid envelope; never add HTTP, auth, persistence, activation, approval, provider, execution, or next-command affordances here.
