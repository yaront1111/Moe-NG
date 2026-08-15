# Read-only security review: provider-run canonical codec

Reviewed untracked `apps/daemon/src/telemetry/provider-run-codec.test.ts`, the live in-progress `provider-run-codec.ts`, and `activation/activation-ledger-codec.ts`. No files edited.

## Critical findings

1. The test requires a missing required `observedEnd` to encode successfully, and later added an extra own `__proto__` key that must be preserved. That turns the closed, all-required `ProviderRunRecord` interface into an open runtime bag. A version-only object and semantically invalid nested shapes therefore encode/decode as `ProviderRunRecord`. Required absence and extra keys should refuse `PROVIDER_RUN_RECORD_MALFORMED`; null remains valid data.
2. There is no contract-owned runtime key list/validator, while this slice forbids local field re-declaration. Complete runtime narrowing is impossible without either a plan/scope amendment or a contract validator/key export.
3. The two decode guards are independently testable only if digest verification compares the recomputed digest to the tail while canonicality compares re-encoded BODY bytes to received BODY bytes. Comparing the whole sealed envelope makes tail digest verification redundant and its deletion mutant survive.
4. An own `__proto__` copied by assignment into `{}` disappears through the legacy setter. Use exact-key refusal and descriptor-safe/null-prototype projection; do not make the extra field legal just to preserve it.
5. Reject proxies before `Array.isArray`/prototype/descriptor operations; reject nested proxies and non-plain arrays. Snapshot byte input before parsing and bound it before header scan. Prefer `types.isUint8Array` plus `new Uint8Array(input)` over `instanceof`/`Uint8Array.from`, which admit fake/proxy values or attacker iterators.
6. Strict canonical JSON must refuse explicit undefined, sparse holes, non-finite numbers including negative infinity, `-0` (or document its normalization), bigint/symbol/function, accessors, symbol/non-enumerable/expando keys, non-plain objects/arrays, cycles, depth/size excess. Activation codec is unsafe to copy literally: it silently maps several of these to null, reads accessors, accepts class/proxy objects, and can throw on cycles.
7. Snapshot/deep-freeze the canonical record returned from encode so nested caller aliases cannot mutate it away from bytes/digest. A nonempty `Uint8Array` itself cannot be frozen; freeze the wrapper and return fresh bytes.
8. Hostile fixture framing currently hardcodes one body frame via UTF-16 `version.length`, despite claiming not to reimplement framing. Read/assert the authentic u32 and encoded header byte length, and add hostile length-prefix, digest-frame length, trailing-byte, fatal UTF-8, and oversize cases.
9. Tests that omitted one of code/layer/outcome were identified; the worker added the layer assertions. Cycle must be nested under an existing field, because an extra top-level self can be rejected before cycle traversal. Sparse hole and explicit undefined need separate cases.
10. The test grew to ~470 lines and production briefly to 254. Split prefix-owned files (`provider-run-codec.canonical.ts/.js`, `provider-run-codec.validation.ts/.js`, hostile/verification test files) after amending affectedFiles. All remain inside `provider-run-codec.*` and under per-file caps.

## Recommended functions

- canonical helper: `canonicalizeJson`, `canonicalizeArray`, `canonicalizeRecord`, descriptor-safe `readOwnDataProperty`.
- validator: `snapshotProviderRunRecord`, `readExactRecord`, `readDenseArray`, plus focused readers for provider fact/ref, launch facts, clock observation, normalized measurement, and usage refusal.
- main codec: `digestDomain`, `seal`, `splitSealed`, `snapshotBytes`, `encodeProviderRunRecord`, `decodeProviderRunRecord`.

Related: `mem:gotcha-full-envelope-reencode-subsumes-carried-digest-check`, `mem:convention-hostile-shape-reads-in-pure-kernels`, `mem:gotcha-proto-key-drop-in-dynamic-key-accumulator`.