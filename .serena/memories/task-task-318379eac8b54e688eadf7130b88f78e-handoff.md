# Control-room daemon transport seam — worker handoff (DONE)

Task `task-318379eac8b54e688eadf7130b88f78e`, epic M3. Finished 2026-08-09.
Gates: daemon 597 passed (30 files), control-room-client 39, `pnpm test:integration` 40.
Merge-base for QA diff: `7183c045ec563a56b285227901038320bb563ddc`.

## What shipped

| Module | Lines | Owns |
|---|---|---|
| `apps/daemon/src/http/http-listener.ts` | 195 | bind, routing, serialization |
| `apps/daemon/src/http/http-listener-guards.ts` | 145 | loopback check, Host/Origin/CSRF, bounded body, authority formatting |
| `apps/daemon/src/daemon-entry.ts` | 161 | `startDaemon`, shutdown, provider seam |
| `apps/daemon/src/daemon-main.ts` | 93 | argv, provider module load, `import.meta.main` guard |
| `packages/control-room-client/src/client-transport.ts` | 134 | `sendCommand`, `readEventPage` |
| `tests/integration/control-room/control-room-transport.test.ts` | 176 | DoD 4 faithfulness proof |

Manifest: `apps/daemon/package.json` gained `main` and `bin: { "moe-daemon": "./src/daemon-main.ts" }`.
Node 24.16 strips types natively, so a `.ts` bin is directly executable — **no** tsx, no
new dependency. `apps/daemon/src/index.ts` got exactly **one** line
(`export * from "./daemon-entry.js"`), which re-exports the listener too.

## Three defects the unit suites could not see

1. **Body was a string.** `decodeBoundedJsonBytes` -> `snapshotBytes` requires a
   `Uint8Array` and refuses anything else with `JSON_INPUT_TYPE_INVALID`. Every
   well-formed command refused at DECODE while the socket looked healthy. Only the
   round trip caught it. See [[gotcha-daemon-envelope-decoder-requires-uint8array]].
2. **Credential was per-listener, not per-request.** Now read from
   `x-moe-session-credential`.
3. **`::1` bind was bound but unreachable** — expected authority was `::1:port`.
   RFC 3986 needs `[::1]:port`. See [[gotcha-ipv6-loopback-authority-needs-brackets]].

## DoD 3 was mis-specified (architect said so first, confirmed on disk)

`ControlRoomClientSurface` (`client-compat.ts:58`) is a generated **builder registry**,
already returned by `createCompatGate`. Nothing to implement. Intent met by a send path
that CONSUMES it — both suites feed it from `gate.client`, so the tested configuration is
the only one production can reach.

**The root-export pin made the module better.** `client-compat.test.ts` pinned the package
root to exactly `["createCompatGate"]` because "a build whose pins do not match should not
even learn the protocol string it failed to match". My first cut imported
`GENERATED_WIRE_PROTOCOL_VERSION`, leaking exactly that to any ungated caller with a stub
fetch. Fixed by taking `wireProtocolVersion` as a caller argument; the transport now
imports no generated module at all.

## Not built here, deliberately

- **Resumable cursor stream** — `event-stream.ts` already implements it. The listener
  ROUTES to `readEventPage`. `resumeFromSnapshot` has **no route**: a resume needs a
  presented cursor the client cannot yet have been handed.
- **Browser Origin.** The client sets `origin` explicitly, which is a Node-side
  affordance — browsers forbid the header and set it themselves. Whether the served page
  origin equals the daemon's bound origin is the app-wiring task's problem.
- **Real registry wiring.** `daemon-entry-fixtures.ts` is the only provider; the bin
  refuses with `DAEMON_ENTRY_NO_DEPENDENCY_PROVIDER` unless `--dependencies=` names one.

## Foreign commit hazard hit again

`f4e12bf` ("Verification process wrapper", another task) is a whole-tree commit that swept
in `http-listener.ts`, `http-listener.test.ts` and `apps/daemon/package.json`. Not amended,
not reset. QA must review by base-ref diff over owned paths, not by looking for a commit
bearing this task's id.

Related: [[gotcha-daemon-js-bridges-are-runtime-tier-only]],
[[gotcha-control-room-has-no-daemon-transport]] (now closed by this task).
