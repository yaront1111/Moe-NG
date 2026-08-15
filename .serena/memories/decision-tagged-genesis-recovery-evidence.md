# Tagged genesis recovery evidence

For the recovery-incarnation contract, use an exact top-level discriminated union so `origin: "RESTORE"` retains `restoreCommandId` and `backupGenerationDigest` at their current public locations, while `origin: "GENESIS"` carries only daemon-derived `projectId` and `storeContextDigest`. Exact decoders must reject cross-branch extras, accessors, symbols, and non-enumerables via `Reflect.ownKeys` plus own data descriptors.

Hash the literal origin tag first for both branches, then the complete branch context and full canonical Ed25519 SPKI fingerprint. Share derivation, canonical codec, proof verification, and raw-entropy/full-SPKI freshness reservations across RESTORE and GENESIS; context changes must not hide repeated material. RESTORE keeps its existing async `mint(request)` API. The synchronous genesis shell is forced by the currently synchronous `createStoreDependencies` boundary and async-only WebCrypto, but it must return public authority-NONE evidence only and let no private key/PKCS8/handle survive the call.

Do not accept the task's daemon-focused Vitest command literally without `--root . --config package.json`; without those flags it selects the root config and exits `No test files found`.
