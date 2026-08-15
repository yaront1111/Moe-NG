# Stale task descriptions are the dominant planning hazard — and they fail in BOTH directions

Recorded 2026-08-09 after planning the whole PLANNING queue in one pass. **Seven of eleven tasks
had a materially false claim in their description.** This is the base rate, not bad luck.

## The two directions, with the day's instances

**A gap claimed OPEN that is actually CLOSED** — the expensive one, because it produces duplicate work:
- `task-bc0b8f5b`: "Runs and Resources get no parity treatment at all today." False — a dedicated
  `TABLE_SURFACES` block already mounts both at 1440/720 and passes. Caught only by *running* the
  test, not reading the description.
- `task-8470a860`: an entire task duplicating a shipped listener. Cost a worker 6 completed steps.

**A dependency claimed PRESENT that is actually ABSENT** — the one that produces fiction:
- `task-5e43a9e2`: four of six required surface families absent.
- `task-9634ed3b`: `apps/daemon/src/graph/` does not exist.

**A premise that expired between authoring and planning** — the subtlest:
- `task-4b274fad`: "there is no motion to suppress." Two stylesheets landed since; `shell-layout.css`
  now has real 160ms transitions (properly suppressed). Its DoD guard would be **red on arrival**.
- `task-4d226307` and `task-cda6bddf`: manifest claims measured against a grep that counted
  comments and ban-test fixtures as imports.
- `task-a95ccf7e`: "exactly ONE stylesheet" — there are three.

**Status claims about OTHER tasks go stale too:**
- `task-4b274fad` says its dependency `task-ab8c9489` is WORKING. It is **DONE**. Believing it would
  have blocked a plannable task; that one measurement unblocked it.

## The measurement discipline that actually works
1. **Run the test, don't read it.** The only thing that caught `task-bc0b8f5b` was executing the file.
2. **`ls -d` the owned path first.** One command separates greenfield from duplicate.
3. **Resolve dependency task ids to their real status** — never trust a description's word for
   another task's state.
4. **Open every grep hit.** A hit inside `*-ban.test.*`, `*package-boundary*`, or near "by design" /
   "not imported" / "held out" is evidence **against**, not for. See
   `mem:gotcha-naive-grep-counts-comments-and-ban-fixtures-as-imports`.
5. **Check both directions before writing a step.** Costs one command; saves a rejected plan or a
   silent duplicate.

## When the DoD itself is the stale thing
Do **not** narrow it on your own authority — it is the gate QA reads literally, and a worker
following a narrowed plan gets rejected for obeying it. Block with the **exact replacement text**.
That worked twice today: `task-4d226307` came back amended and correct within ~10 minutes.

Note governors **cannot edit `definitionOfDone`** — no MCP tool exposes it — so the correction lives
in `reopenReason` and QA inherits it from there. On `task-4d226307` that limitation bit twice.
