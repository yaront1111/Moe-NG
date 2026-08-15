# Daemon bootstrap command byte ingress

Stable v1 boundary decision, landed in `b8a2381` as `apps/daemon/src/bootstrap/bootstrap-contracts.ts`.
Sibling of `mem:decision-daemon-graph-preview-ingress` and follows the same shape deliberately — the daemon should have one ingress idiom, not two.

## Surface
- `decodeBootstrapRequestBytes(input: unknown): BootstrapDecodeResult`, exported from `./bootstrap-contracts.js`.
- `BOOTSTRAP_SCHEMA_VERSION = "moe-bootstrap-command/1"`, compared by identity against a pinned literal.
- Envelope is an exact 9-own-key object, all required, no extras:
  `commandId, correlationId, decidedAt, expectedVersion, kind, payload, principalId, projectId, schemaVersion`.
- `BOOTSTRAP_COMMAND_KINDS`: the NINE kinds this surface owns — `approval.decide, goal.create, plan.propose, policy.install, policy.validate, project.activate, project.bind_repository, project.register, provider.probe`. Typed `as const satisfies readonly RuntimeCommandKind[]`, so a typo cannot compile and every member is provably in `RUNTIME_COMMAND_KINDS`.

## Refusal taxonomy (closed)
- `BOOTSTRAP_INPUT_REJECTED` — `decodeBoundedJsonBytes` refused the bytes/UTF-8/JSON/resource bounds. Carries `decodeError` **verbatim**; translating it would erase which bound was exceeded.
- `BOOTSTRAP_REQUEST_INVALID` — decoded value is not the exact envelope (extra key, missing key, wrong `schemaVersion`, non-integer/negative `expectedVersion`, non-object `payload`).
- `BOOTSTRAP_COMMAND_UNKNOWN` — envelope is exact but `kind` is outside the owned nine. Deliberately its own code, so accidentally widening the surface is distinguishable in evidence from a malformed envelope.

## The two decisions worth keeping
**1. Every refusal carries `refusedBy: "DAEMON_INGRESS"`.** This is the layer marker epic rail 6 needs. Once the `@moe/core` reducers compose on top, their refusals carry the core's own `RuntimeError` code and a different `refusedBy`, so a test can assert WHICH layer answered. Without it, a refusal test goes vacuous the moment a second layer can refuse first — the exact defect the project rail names.

**2. Set-equality is asserted against a literal restated in the test, never against a list derived from production.** Deriving both sides makes the assertion vacuous: a tenth kind added to production appears on both sides and the test stays green. Both lengths are also asserted `=== 9` so the comparison cannot degenerate into two empty sets.

## Invariants
- Decode before ALL schema inspection. Never call `JSON.parse` here.
- A non-null prototype means the value did not come from the bounded decoder and is not trusted (mirrors `apps/daemon/src/index.ts`).
- Every returned result is frozen.
- This module answers shape only. Legality, authority, ordering and version agreement belong to a `@moe/core` reducer. Never add HTTP, auth, persistence, activation, approval, provider I/O, spawn, or a clock read — `decidedAt` is caller-supplied precisely so the ingress stays clock-free.
