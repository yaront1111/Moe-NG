# Dispatch idempotency must bind the full authoritative request

Hashing only activation bytes is insufficient when a replay also supplies a sealed input manifest, execution graph, launch template, grant binding, or runtime identity. A changed replay can otherwise adopt an old successful record as if identical.

The reservation/request digest must cover every semantically authoritative launch byte in a canonical encoding. A replay that changes any bound field must refuse with the task's exact drift code/layer and write/launch nothing.