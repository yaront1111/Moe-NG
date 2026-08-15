# Audit-register slicing pass — outcomes and the judgement calls

2026-08-15, architect-2aea4111, from register `task-963cf1d125134c6193b7af0e53deeac3`
(Yaron's 2026-08-14 30-agent audit). Measured at HEAD `192360e`.

## Reconciliation

**9 created + 0 declined + 2 already-closed = 11.** Detail in
`mem:task-task-963cf1d125134c6193b7af0e53deeac3-handoff`.

Of the 9 created, I then planned 8 and blocked 1 on a premise failure.

## The two items I found ALREADY CLOSED

- **Item 5 (MCP session registry).** `http-session.ts:222` per-session eviction;
  `http-server.ts:303-309` close() deletes each entry AND closes transport and
  server. `entries()` returns a copy so mutate-during-iterate is safe.
  **DISPUTED:** someone later created `task-70b6361dfd124e67bf70deecf78490c6`
  ("MCP adapter close must release daemon-side session bindings"). I flagged the
  conflict on that task (`comment-9565510d58ec474aac6a0a6d385b9099`) rather than
  assuming I was right — "daemon-side bindings" may name something beyond the
  adapter's transport/server. If it does, the register arithmetic needs
  correcting to 10 created + 1 already-closed.
- **Item 11 (packaging choke point).** Complete executable path now exists:
  `package.json release:evidence` → `supply-chain.mjs:9` → `release-subject.mjs:11`
  → `startDistribution` (called :194).

## The one that failed on its premise — item 4

`task-2f746bde37884220bd28cf79a545d5be` BLOCKED. **domain_events has no
row-level integrity mechanism for ANY column** — no digest, checksum or HMAC;
`request_sha256` covers the request, not the row; `validateSchema` checks the
DDL. So "bring domain_schema_version under integrity" has nothing to bind to.

Also narrower than claimed: `projection-upcast.ts:124/:127` ALREADY fails closed
with SCHEMA_VERSION_UNSUPPORTED on an unknown version, so only drift to a
different VALID registered version is undetected — and that is equally true of
payload, metadata and event_type. Fixing one column would create the appearance
of integrity without the substance, which under epic rail 4 is worse than the
honest absence. Recommended: decline the item, or replace with a scoped
row-integrity task (a durable-format change needing human sizing).

## A defect the register MISSED, found while planning

`backup-generation.ts:37-46` `persistFile` has the **identical** missing
`bytesWritten` check as `recovery-anchor-fs.ts:23-31` (register item 3). The
audit named only one of the two copies. Routed to
`task-1fb6e87110744bbea21aafc3ea891e8d` by comment, because that task already
owns `backup-generation.ts` and two tasks editing one file in this shared
worktree is the collision the rails warn about.

## A correction to my own slice text

Item 7's description (mine) claimed a stored NaN "poisons lastRound for every
subsequent call". **It does not** — `lastRound` reduces with `record.round >
highest`, and `NaN > x` is false, so a stored NaN is ignored. The real harm is
that the round is accepted and appended when it should have been refused, and
NaN serializes to `null`, which can make the lineage permanently unattestable
afterwards. Corrected in that task's planningNotes.

## Sharpest per-slice findings

- **Item 9 (scheduler localeCompare):** the SAME comparator already uses the
  correct code-unit form one line above (`readiness-projection.ts:151` vs `:152`)
  — a one-line internal inconsistency. The test must assert the fixture's locale
  and code-unit orders actually DISAGREE on the host, or it passes pre-fix.
- **Item 2 (anchor resume):** `recovery-anchor.ts`'s own doc comment describes
  this exact hazard ("re-entering the protocol would write into the slot that is
  now LIVE") while the guard checks only `state === "INSTALLED"` — one condition
  short of the window it warns about. `currentSlot === targetSlot && state ===
  "PREPARED"` is an unambiguous signature needing no new durable state.
- **Item 6 (import recursion):** the real hazard is ORDERING, not the overflow.
  Findings are pushed interleaved with recursion, so a stack of node ids changes
  output. Needs `(node, refs, nextIndex)` frames and golden fixtures captured
  BEFORE the change.
- **Item 8 (Origin header):** removing it genuinely BREAKS Node callers (no
  Origin → `LISTENER_ORIGIN_INVALID`). That consequence is the fix, not a bug —
  but it invites re-adding the header when a test fails.
