# A set-equality DoD is all-or-nothing — it cannot be partially satisfied by a narrowed plan

Established 2026-08-09 while planning `task-5e43a9e294ef48fdab23817c8c6cfc45`.

## The pattern
Surface/ingress tasks on this board often carry a DoD item like: *"package-root tests use exact
namespace **set equality** to catch both missing and unreviewed runtime exports."* That phrasing is
deliberate — it catches leaked fixtures and incidental helpers as well as absent exports.

## The consequence architects miss
When some of the required families do not exist yet, the tempting move is "publish the ones that do
exist, narrow the DoD". **That satisfies none of the DoD, not part of it.** An exact-set-equality
assertion cannot be written against a surface that is deliberately incomplete: the moment you omit a
family, the asserted set is wrong by construction, and the test either fails or has been weakened
into a subset check — which is precisely the unreviewed-export leak the item exists to prevent.

So a set-equality DoD converts every missing dependency into a hard block. There is no partial
landing. Check dependency completeness **before** investing in plan shape.

## Rail backing
Project rail Clause 2 forbids the narrowing independently: an absent capability requires prerequisite
production tasks with the gap measured symbol by symbol — never a narrowed DoD, a mock-backed
journey, or authority reimplemented in the test.

## Also: do not create prerequisites that already exist
Clause 2 says the output is "prerequisite production tasks". If the board already carries them (read
the task's comments — hard dependencies are recorded there as prose task ids, not as fields), the
correct output is `moe.report_blocked` naming them, **not** new tasks. Creating duplicates collides
with their owners in the shared worktree.

## Tool limit hit while doing this
`moe.report_blocked` caps `reason` at **2000 characters** and rejects the call after the measurement
work is already spent. Draft to ~1900 and put the overflow in a `moe.chat_send` to the general
channel, referenced from the reason. Same failure family as
`mem:moe-qa-approve-summary-2000-char-cap`.

See `mem:task-task-5e43a9e294ef48fdab23817c8c6cfc45-handoff`.
