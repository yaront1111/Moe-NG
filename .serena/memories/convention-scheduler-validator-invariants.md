# Convention: invariants any change to the scheduler graph validator must hold

Applies to `packages/scheduler/src/validate-graph{,-input,-structure}.ts`.

## Read order (hostile-input defense)
1. Resolve policy BEFORE touching the snapshot — a malformed limit must never be decided by attacker-controlled input.
2. Schema (`isPlainRecord` + `hasOnlyOwnStringKeys`) -> own data properties -> `isPlainArray` -> `isGraphKey(completion)` -> `readPlainArrayLength`.
3. **Raw array ceilings precede every indexed read.** Over-limit refuses in constant time; otherwise a sparse or accessor-backed array turns the policy check itself into an attacker-controlled traversal.
4. Only then dense-array shape, then element reads.

Accessors are never invoked: reads go through `readOwnDataProperty` / `readOwnArrayElement` (both `Object.getOwnPropertyDescriptor`-based, returning `{ok:false}` for accessor descriptors). `isPlainRecord`/`isPlainArray` reject proxies via `util.types.isProxy` in a try/catch that fails closed.

## Issue accumulation
Fixed order: parse record-local issues -> missing endpoints -> completion presence/terminality -> normalized policy limits. Then, and only if that set is empty, topology.

- **Never build topology while any integrity issue stands.** Cycle and closure presuppose resolvable endpoints; `buildHardGraphIndex` does `indexOf.get(graph.completionNodeKey)!` and yields `undefined` for an absent completion node.
- `nodeShapeOk === false` must suppress both unknown-endpoint and absent-completion findings — those facts are unclaimable when any node record is untrustworthy.
- Topology failures are reported one at a time (cycle short-circuits before closure).

## Determinism and immutability boundary
Centralized in `validate-graph.ts` and nowhere else:
- Failures: `sortIssues` (key = `JSON.stringify([code, nodeKeys, edgeKeys, message])`) then `deepFreeze`.
- Success: sorted view -> cloned nodes/edges -> copied policy -> `computeGraphIdentity(view)` -> `deepFreeze` -> `registerValidatedGraph` exactly once.

Helper modules must not sort the final issue list, freeze anything, or register provenance.

## TDD note that pays off here
Because the reported order is the *sorted* order, a characterization test whose accumulation order differs from its expected order is the only kind that catches a dropped `sortIssues`. Build fixtures deliberately so at least two same-code issues are emitted in the reverse of their canonical order.

See `mem:gotcha-scheduler-js-shims` before adding any new module here.
