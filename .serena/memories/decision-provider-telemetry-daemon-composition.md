# Provider telemetry composes at daemon, not runner

At current moe-next architecture, `@moe/runner` depends only on `@moe/contracts`, while scheduler owns the authoritative `UsageMeasurementRecord` and `normalizeUsageMeasurement` coverage/source semantics. Keep raw provider parsing and launch-bound facts in runner; publish scheduler's existing normalizer at its root; compose the two at daemon, which already depends on both packages.

A raw runner record must preserve provider sequence, raw receipt digest, upstream UNKNOWN code/layer, declared launch selection separately from provider-observed model evidence, and null rather than zero for missing counts. The daemon normalizer preserves scheduler CONTRACT versus MEASUREMENT codes/layers and then builds/persists the final canonical run record. Never inject a fake normalizer into runner or duplicate scheduler's source/coverage lookup there.

Selected model/snapshot/effort also need a pre-open production launch-selection fence. Runtime reportedVersion/closure and profileRevisionId remain separate identities and never substitute.
