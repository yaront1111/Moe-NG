# Gotcha: a getOwnPropertyDescriptor-trap proxy over an EMPTY target never fires

A hostile-input test that proxies `{}` with a throwing `getOwnPropertyDescriptor` trap silently tests nothing:
`Object.keys(proxy)` first calls [[OwnPropertyKeys]] (no ownKeys trap -> the target's own keys, i.e. none), then
calls [[GetOwnProperty]] only for the keys it got back. With zero keys the descriptor trap is never invoked, the
"hostile" case degrades into an ordinary malformed record, and the assertion still passes.

Give descriptor-trap proxies a target with at least one own key (e.g. `{ probe: "value" }`). An `ownKeys` trap has
the opposite property — it fires even on an empty target.

Corollary for these matrices: count the traps, not the cases. Assert a positive per-case trap counter, otherwise a
case that never triggered its trap reads exactly like coverage. Verified on
`packages/runner/src/providers/claude/claude-launcher.test.ts`.
