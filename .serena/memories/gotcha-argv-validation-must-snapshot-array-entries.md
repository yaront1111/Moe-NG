# Argv validation must snapshot array entries

Validating `Object.getOwnPropertyDescriptor(argv, index).value` and later encoding with `for (const argument of argv)` is a hostile-input TOCTOU. Arrays may own a custom `Symbol.iterator`; it can yield entries different from those validated, including NUL-bearing strings, more entries than `length`, or an unbounded sequence.

The test must hit the production boundary, not only a helper:
1. Build an array whose ordinary index descriptor is safe but whose iterator yields hostile data.
2. Require the exact pre-spawn refusal code and layer.
3. Assert the resolver/spawn call log is empty.

A safe implementation encodes an immutable snapshot of the exact validated descriptor values, or refuses custom iteration; it never re-reads caller-owned iteration behavior after validation.