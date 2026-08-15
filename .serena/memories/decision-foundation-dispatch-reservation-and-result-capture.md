# Decision: durable dispatch reservation and trusted result capture

For a daemon service that composes an idempotent activation ledger with an idempotent launcher authority, identical command replay is not by itself a single-invocation fence. Both activation and GRANT/PREFLIGHT transition writers may validly answer REPLAYED with the durable bytes, so two concurrent service calls can both reach the launcher unless the service owns a separate dispatch reservation.

Use an expected-version-0 dispatch-reservation event:
- only the caller receiving fresh COMMITTED may invoke the launcher;
- REPLAYED reads/adopts a completed immutable record or returns SUSPECT/in-progress;
- a reservation without a final record after restart is evidence that launch may have begun, never permission to relaunch;
- append the final advisory attempt record at the next exact version and re-read ambiguous/replayed commits before answering.

Workspace result evidence is acquired through a daemon-owned post-launch capture port, not an untrusted command field. The service supplies its already-validated sealed input manifest to bare-root `buildResultManifest` and persists the full validated input/result manifests plus launcher observation/registration/runtime/raw-stream identities. Capture failure or malformed evidence stays UNKNOWN and creates no authoritative result manifest.

PREFLIGHT remains a reservation and is never passed as `priorRegistration`; only PROCESS_OBSERVED may be treated as process authority.