# Decision: platform boundary is flat; `platform/<os>/` belongs to the conformance tasks

`packages/runner/src/platform/**` is owned by more than one task at once, and the split is by DEPTH, not by area:

- **`platform/platform-contract.ts`, `platform/linux-observation.ts`** (flat) — the observation/classification BOUNDARY. Landed by task-f01ef545b1554a2cb5df340ce78f6a5c "Linux platform observation boundary".
- **`platform/linux/**`** — owned by task-e87a735386f643fe92c0eeff09bc4275 "Linux effect conformance" (effect adapters + fault evidence, with `tests/fault/linux/**`).
- **`platform/macos/**`** — owned by task-e94b2055e281489ea9e97820919f6856 "macOS effect conformance".

So a task landing the boundary must use FLAT module names and must create neither subdirectory. Putting the Linux adapter at `platform/linux/linux-observation.ts` reads natural and is wrong: in this single shared worktree it plants one task's files inside another task's owned path, which epic rail 3 forbids and which no later commit-by-pathspec can untangle.

**Generalisation worth carrying:** before choosing a directory inside a `**`-owned path, grep the other tasks' `Owned paths:` clauses for a deeper claim on the same prefix. A `**` grant is not exclusive — it can be sliced by a sibling task at any depth.

## Layering, decided at the same time

The shared contract stays OS-neutral and names no OS except the `PLATFORM_LINUX` refusal-layer member. macOS must be able to consume the contract while inheriting zero Linux facts, so:
- host identity is declared IN the shared contract, not imported from a provider adapter (`PlatformIdentity` is already duplicated in claude-observation.ts and codex-observation.ts; importing either would bind neutral vocabulary to one adapter and bless one of two duplicates);
- the truth-class vocabulary is the platform's own, and the OS adapter MAPS a provider observation's truthClass onto it rather than aliasing — a PROVEN provider fact is a candidate that still has to clear host, arch and freshness gates.

## Gotcha: UNKNOWN is the default, so UNKNOWN-only assertions are vacuous

Aggregate truth is AND across all boundaries, so a fail-closed adapter answers UNKNOWN for almost every input, including one where every gate has been deleted. A test asserting only `truthClass === "UNKNOWN"` therefore proves nothing. Pin the exact reason code AND the refusing layer, and mutation-drill by deleting the host short-circuit — if the off-host test stays green, it was never testing the gate.

See `mem:task-task-f01ef545b1554a2cb5df340ce78f6a5c-handoff` and `mem:decision-cross-module-refusal-passthrough`.
