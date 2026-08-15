---
title: The control room is fixture-only — nothing in this repo listens on a port
---

# The control room has no daemon transport — but the gap is ONLY the socket

> **NARROWED 2026-08-09, later the same day.** The four absences below are accurate,
> but "nothing exists" is wrong and I over-corrected when I first wrote this.
> The entire HTTP boundary *above* the socket is committed and tested:
> `handleCommandRequest` (`apps/daemon/src/http/http-adapter.ts:150`), the boundary
> vocabulary in `http-contract.ts` (`HTTP_INPUT_BOUNDS`, `HTTP_REFUSAL_STAGES`,
> `Authenticator`, `CommandDecisionPort`, `PortRefusal`), the **resumable cursor
> stream** in `http/event-stream.ts`, and `authenticateCommand` in
> `packages/core/src/identity/`. What is missing is that **nothing calls `.listen()`**
> and the daemon has no `main`/`bin`.
>
> Also: `ControlRoomClientSurface` is a generated **builder registry**, not a
> transport — already implemented by `createCompatGate`. The client gap is a *send*
> function, not an implementation of that type.
>
> Lesson: after proving a capability absent, probe once more for the *adjacent*
> machinery before declaring the whole area empty. See
> [[task-task-318379eac8b54e688eadf7130b88f78e-handoff]] for the accurate map.

Measured 2026-08-09. This invalidates any task whose DoD says "against a real
daemon", "connected", or "end to end". Check it before planning one.

## Four absences, each independently verified

```bash
# 1. No HTTP listener exists ANYWHERE
grep -rniE "createServer\(|\.listen\(|Deno\.serve|Bun\.serve" \
  --include=*.ts --include=*.js apps packages adapters | grep -v node_modules
# => ZERO
```

2. **The daemon is not a process.** `apps/daemon/package.json` declares no `main`
   and no `bin`; its only scripts are `typecheck` and `test`. Nothing can start it.
3. **The client has no transport.** `packages/control-room-client` exports exactly
   `createCompatGate` plus types. `fetch(|http|EventSource|url|request` → zero.
4. **The app never calls it.** `apps/control-room` references the client only through
   `import type` (`data/data-adapter.ts:1`, `data/data-contract.ts:1`).
   `ControlRoomClientSurface` is an injectable **type** with no runtime
   implementation and no construction site.

## What IS true, and why it misleads

`apps/control-room` builds (`vite build`), `dist/` holds `index.html` + assets, and
`main.tsx` mounts `ControlRoomScaffold` which renders committed **fixtures**. So the
app serves and renders perfectly standalone.

> **Building is not connecting.** I wrote "apps/control-room builds today" into a
> task DoD as if it licensed "drives it against a real daemon", and had to block my
> own task for it. A servable bundle proves the UI mounts; it says nothing about
> whether any byte ever came from the daemon.

## Two tasks that sound like they close this and do not

- `task-6c732e0032534cc0abe9196ad467308f` **Streamable HTTP adapter** — DONE, but it
  is `packages/mcp/src/http/**` for MCP hosts and explicitly excludes browser UI APIs.
- `task-5e43a9e294ef48fdab23817c8c6cfc45` **Foundation daemon ingress surface** —
  BACKLOG, publishes *exports*; its own description says *"NOT in scope: behavior
  changes, fixtures, transport listeners, or new authority"*.

Neither will produce a listener. Read a task's exclusions before treating it as your
prerequisite.

## The gap is now owned

`task-318379eac8b54e688eadf7130b88f78e` — Control-room daemon transport seam
(startable daemon entry, loopback listener over committed handlers, runtime impl of
the **existing** `ControlRoomClientSurface`). Deliberately excludes the resumable
cursor stream, auth hardening, and app data wiring — those depend on a seam shape
that does not exist yet, so specifying them now would be guessing.

The epic's own architectureNotes promise the control room is *"connected to the
daemon through generated authenticated HTTP/query contracts and a resumable cursor
stream"*. Treat that as design intent, not as shipped capability.

Related: [[task-task-667b1085b3e04915a88336c7424045a1-handoff]]
