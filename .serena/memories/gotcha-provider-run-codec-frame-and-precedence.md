# Provider-run codec test constraints

`apps/daemon/src/telemetry/provider-run-codec.test.ts` pins a frame that differs from the activation codec's per-field shape: `${PROVIDER_RUN_RECORD_VERSION}\n`, one 4-byte body-length prefix, one canonical JSON body, then a 4-byte digest-length prefix and 64 ASCII hex digest bytes. `BODY_START = version.length + 1 + 4`; the tail is 68 bytes.

The caller's `recordDigest` is outside the digest domain and must be overwritten before serialization, so different caller digest fields produce byte-identical output. The computed digest is attached both to the returned/body record and the trailing frame. Decode needs two independent guards: recompute from the decoded semantic value, then canonical-reencode and compare bytes.

Refusal precedence is observable: invalid JSON -> `PROVIDER_RUN_BYTES_MALFORMED`; JSON non-record -> `PROVIDER_RUN_RECORD_UNREADABLE`; unsupported header or body version -> `PROVIDER_RUN_VERSION_UNSUPPORTED`; only valid supported records reach `PROVIDER_RUN_DIGEST_MISMATCH`. These forgeries retain a stale authentic tail, so a digest-first decoder returns the wrong code.

Absent object fields are allowed and serialize differently from explicit null; present undefined (including sparse array holes), non-finite numbers, and cycles refuse `PROVIDER_RUN_FIELD_INVALID`. Encode outcomes are `REFUSED`; decode outcomes are `UNKNOWN`; layer is always `PROVIDER_RUN_CODEC`; storeCode is null.