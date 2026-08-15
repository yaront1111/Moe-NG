# Decision — total containment for launcher dependency results

A try/catch around an injected call is insufficient: a fulfilled Proxy/accessor, optimistic discriminator, raw thenable, or malformed nested success can reject later or advance authority. At runner launch boundaries:
1. Treat every injected return as unknown and descriptor-snapshot it before any branch, await, freeze, digest, spread, or nested read.
2. Require an exact native Promise before awaiting; do not assimilate arbitrary thenables.
3. Parse closed variants and copy only validated fields into frozen local records; never echo a raw message.
4. A live boundary is not an exact plain record. Capture cleanup methods first through bounded descriptor lookup that supports production class prototype methods, then validate promises/streams.
5. Once a physical lock is owned, use one bottom finalizer: cancel if required, await one close, settle captures, then release once. Cleanup uncertainty overrides the primary result; release uncertainty overrides cleanup.
6. Do not race an arbitrary pending cleanup with an injectable timeout and then release. Returning no authority while the lock remains held is fail-closed; a guaranteed liveness watchdog is a separate trusted protocol.
7. Pin the production public promise with positive-count hostile-result matrices and byte-restored mutations of both decoder and cleanup edges.