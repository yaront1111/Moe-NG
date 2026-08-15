# A synchronous wrapper cannot truthfully report a rejection from an exit-lifetime Promise

Measured on task-58fd2c3781254d839ee27867f8f9f4e6.

`AgentWrapperConfig.spawnAgent` returns `Promise<void>`, and the real Claude spawner settles that promise when the child exits. The wrapper's `staff` / `runOnce` and its main-loop report read are synchronous. Even an already-rejected async promise becomes observable only on a later microtask; there is no supported synchronous Promise-state inspection.

Therefore these requirements cannot all hold:
1. runOnce remains synchronous and existing callers/tests stay unchanged;
2. spawnAgent remains an exit-lifetime Promise;
3. the immediate report distinguishes a coded startup refusal from SPAWNED.

Bad workarounds:
- awaiting spawnAgent: blocks until the agent exits;
- mutating the returned report in catch: the immediate caller already consumed false SPAWNED, and the result is no longer immutable;
- duplicating the spawner preflight in the wrapper: creates two authorities that can drift;
- util.inspect/Promise internals: unsupported and engine-specific.

The production seam must separate startup admission from lifetime, for example:
`{ ok: true, exit: Promise<void> } | { ok: false, code, layer }`, or an awaited start acknowledgement followed by a separate exit handle. Then the wrapper can report only after admission while retaining active bookkeeping until exit.

Related: `mem:task-task-89071eb1ea0d4ccd8015f61d10cd89f6-handoff`, `mem:gotcha-hoisted-guard-turns-rejection-into-sync-throw`.