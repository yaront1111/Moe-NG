/**
 * @moe/import — deterministic, read-only importer for frozen legacy Moe projects
 * (design §21.2-§21.7).
 *
 * The whole package is a pure function from frozen source bytes to a canonical import:
 * imported ids, ordering, provenance times and canonical payloads derive from source
 * digests and the manifest, never from wall-clock import time. No clock and no random
 * source appears anywhere, because either one makes §21.7's "identical bytes produce
 * identical canonical hashes" unprovable.
 *
 * Out of scope by design: live legacy reads, write-back, dual write, and every cutover
 * step (§21.9-§21.13).
 *
 * The curated surface lands in step 7; this entry point exists so the package resolves
 * and typechecks while the modules beneath it are built.
 */

export {};
