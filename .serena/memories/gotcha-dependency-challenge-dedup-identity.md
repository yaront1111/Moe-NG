# Gotcha: dependency challenge dedup identity

Endpoint equality is not dependency-challenge identity. The canonical key is subject kind + exact edge/contract hash + graph epoch + canonically sorted `(sourceFactRef, version)` bindings. Endpoint-only matching falsely deduplicates a new graph/fact observation, while discovery-only enforcement lets existing-edge `DEDUPLICATED` statuses name nonexistent challenges.

Normalize source facts first, compute the key for both missing-edge and existing-edge subjects, and require the current open-challenge context to carry that exact prior key plus challenge ref. Mutual hidden-hold refusal remains a separate inverse-endpoint rule.