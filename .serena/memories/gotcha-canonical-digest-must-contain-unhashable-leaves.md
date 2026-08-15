# Gotcha: canonical digest must contain unhashable leaves

`JSON.stringify`-backed digest helpers can throw on BigInt, cycles, and hostile proxies. Exact outer-record parsing does not validate leaf values. A public fail-closed bridge must validate/snapshot every leaf or contain canonicalization and return its stable malformed reason; never let digest construction reject/throw outside the result vocabulary.

QA probe: inject an unhashable value into a production-bound leaf before identity recomputation; assert the production entrypoint does not throw and pins exact code/layer.