# Length framing does not imply store admissibility

An injective/length-framed aggregate-id derivation can still fail every valid commit when producer field maxima sum beyond the durable store's identifier ceiling. Always test the derivation against the real store using maximum producer-admitted values, not only printable-character, determinism, or pairwise-collision tests.

Provider-run example: three ASCII refs admitted at 200 bytes each produced 679 bytes; @moe/store requires <=512 UTF-8 bytes and raised STORE_INPUT_INVALID. The bounded correction uses a domain-separated SHA-256 over UTF-8 byte-length-framed components, while preserving the full identity inside the durable record and requiring record comparison on replay.

Also inspect precedent rather than assuming it is safe: activation ledger's raw framing had the same problem. Follow-up owner: task-8f84c56d88504f80aa2fefdf69f093bd.
