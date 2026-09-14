# Review retry between wrapper polls

## Problem

The wrapper limits repeated staffing of one unchanged item. It currently resets that advisory counter only when a poll observes the item outside READY. A third failed review and a human continuation approval can both commit between polls. The next poll sees READY again and refuses with `STAFFING_ATTEMPTS_EXHAUSTED`, despite the new durable continuation.

## Required behavior

Recognize a new, verified, unconsumed review continuation independently of whether a BLOCKED frame was observed. Reset the advisory staffing counter once for that exact approval. Preserve the existing attempt cap, human approval authority, review source binding, and consumption rules.

Use a server-owned optional continuation reader on the wrapper configuration. The production reader follows the existing review ledger. Validate the project, node, approval decision identity and result digest, and the current review version. Claim churn, ordinary READY frames, arbitrary version changes, missing readers, and unverifiable or repeated grants cannot reset the counter. Remember the applied approval across blocked polls so re-observation cannot grant another reset.

## Owned changes

- `apps/daemon/src/orchestrator/agent-wrapper.ts`: apply the proven one-time reset before the advisory cap.
- `apps/daemon/src/orchestrator/agent-wrapper-config.ts`: typed optional continuation reader.
- `apps/daemon/src/orchestrator/wrapper-review-missions.ts`: produce the existing ledger's continuation identity.
- `apps/daemon/src/orchestrator/agent-wrapper-main.ts`: production wiring.
- `apps/daemon/src/orchestrator/wrapper-review-test-fixtures.ts`: matching fixture wiring.
- Focused wrapper continuation regressions and a small helper module with a physical `.js` bridge if needed to respect the source size limit.

## Verification and delivery

First reproduce the real three-round failure with an approval before the next wrapper poll, without an intervening BLOCKED read. Verify the exact refusal, then prove the next seat starts after the fix. Cover same-grant replay, malformed/foreign/stale tokens, ordinary claim/version movement, and the existing cap.

Run focused tests, typecheck, root tests, foundation/store checks, and the full daemon suite. Commit only the owned files and package that exact commit. Verify the packaged sources and startup path. Preserve the active UnAI worker while the next-project installation is updated after proving its path has no active readers.
