# A DoD demanding "the exact reason code" for an outcome that carries none

Found 2026-08-11 on `task-4afcb064`. A previous session reported this task
BLOCKED over it; it did not need to be.

## The situation

DoD required a **stale cursor** to "assert the exact @moe/coordination reason
code and layer". But `CoordinationCursorGap`
(`packages/coordination/src/coordination-contracts.ts:161`) is
`{durableCursor, mailboxSequence, outcome:"CURSOR_GAP"}` — deliberately no
`code`, no `layer`, because it is a reseat instruction, not a refusal.

Reading that as a contract conflict and blocking is the expensive mistake.

## The move

Before concluding a DoD is unsatisfiable, enumerate the OTHER paths the same
concept reaches. "Stale cursor" is not only the read path:

- replay from a cursor ahead of the mailbox -> `CURSOR_GAP`, no code;
- acknowledge a sequence not ahead of the durable cursor ->
  `COORDINATION_ACK_REGRESSION` at layer `MAILBOX`
  (`coordination-mailbox.ts:172`) — a real code and a real layer.

Cover both. The code-bearing sibling satisfies the reason-code rail; the
structured outcome is asserted by exact field values
(`{durableCursor: 2, mailboxSequence: 2}`), which is stronger than a code
anyway. Nothing adapter-local is invented, which is the actual prohibition.

## The general rule

A stable-reason-code rail is satisfied by the strongest exact assertion the
contract can express on that path. When one path expresses no code, assert its
exact fields AND find the sibling path that does. Inventing a local code is
forbidden; so is quietly asserting "not successful".
