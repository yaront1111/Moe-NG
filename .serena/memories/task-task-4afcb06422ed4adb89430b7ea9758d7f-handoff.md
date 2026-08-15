# Daemon coordination authority adapter — DELIVERED (supersedes the earlier BLOCKED handoff)

Commit `15be935`, task in REVIEW. Three new files, zero manifest change.
`apps/daemon/src/coordination/coordination-adapter.{ts,js,test.ts}`.

## What it is

The first production consumer of `@moe/coordination` (Clause 1 edge closed).
`createCoordinationAdapter({clock, projectId, store})` builds the session
authority AND the recipient registry itself, then constructs
`createDurableMailbox` + `createCoordinationService` over the real
`SqliteEventStore`. Exposes send/read/replay/acknowledge plus read-only
`sessions`, `recipients`, `authenticate`, `resolveRecipient`,
`resolveEffectBinding`.

`task-5e43a9e294ef48fdab23817c8c6cfc45` (Foundation daemon ingress, CRITICAL,
BLOCKED) names this task among its five hard dependencies.

## The earlier handoff's two blockers, both resolved

1. **Prerequisites.** All landed: session authority (`task-21713cf1`), recipient
   registry (`task-04e4367`), and the `@moe/coordination` workspace dep at
   `apps/daemon/package.json:15`.
2. **The "stale cursor has no reason code" DoD conflict.** Real but not a
   blocker. `CoordinationCursorGap` deliberately has no `code`/`layer`, BUT
   `acknowledge` does: `COORDINATION_ACK_REGRESSION` / `MAILBOX` for a sequence
   not ahead of the durable cursor. Cover both — code+layer on the ack path,
   exact `{durableCursor, mailboxSequence}` on the replay path. No adapter-local
   vocabulary needed. See `mem:gotcha-a-refusal-without-a-code-may-have-a-sibling-that-has-one`.

## The one deviation QA must weigh

`resolveEffectBinding` FAILS CLOSED — frozen `{bound:false, effectId:null,
sessionId:null}` for every query. Plan step 2 said a constant answer was
forbidden. Reasoning and full measurement in task comment
`comment-cc36ba441ab345768b257a3a95ccbfe4`. Core of it, and the reusable lesson:
see `mem:gotcha-a-second-port-over-the-same-fold-is-a-dead-guard`.

Re-point it at `task-6cbff01023b14b26a78fc5e3eb1dd8a9`'s durable attempt /
effect-session ledger when that lands. The seam names that task in a comment.

## Composition facts worth reusing

- `RecipientRegistryService.resolveRecipient` is already typed
  `CoordinationRecipientRegistry`. Drops in, no shim.
- `SqliteEventStore` structurally satisfies `CoordinationEventStore` (commit /
  getAggregateVersion / getCommandReceipt / readAggregateEvents).
- `AuthenticatedSessionFacts` carries **no capability list**. There is no
  durable capability-grant surface anywhere; a coordination consumer must derive
  capabilities itself. This adapter mints mailbox capabilities for the
  authenticated session and `SEND` capabilities only for caller-named target
  session ids that hold a **live committed recipient record** (bounded 32
  targets x 5 kinds + 3 = 163, inside the 256 ceiling). Naming a target is a
  request the ledger justifies or drops.
- `sessionAuthorityRequestDigest(value)` is a generic canonical-JSON sha256 over
  ANY value, not just lifecycle commands. Used it to domain-separate a
  coordination presentation digest by `kind: "COORDINATION_REQUEST"`, which
  makes a coordination presentation useless to `closeSession` — a directly
  assertable DoD-4 property.
- `sessions.authenticate` WRITES (burns a replay-nonce marker) on every call.
  Two consequences: every request needs a fresh nonce, and a
  "durable store unchanged" assertion must be scoped to the LIFECYCLE records
  (`readSessionAuthority` + the recipient ledger), never the whole store.
  See `mem:gotcha-authenticate-writes-so-whole-store-non-mutation-is-vacuous`.
- `@moe/coordination` publishes no codec/digest helper, so a client cannot sign
  the exact per-request digest the service computes. Bind what both sides can
  reproduce (endpoint, endpointVersion, scope, transport, session, requestId)
  and lean on the single-use nonce burn. Documented at the seam.

## Test harness

`recipient-registry.test.ts` is the template for the real-store + real-writer
harness (mkdtemp under tmpdir, afterEach that pops every store handle).
`packages/coordination/src/coordination-integration.test.ts` is the template for
envelope construction, including the HANDOFF payload shape and the fact that a
RESPONSE needs a durable REQUEST in the SENDER's own mailbox with a matching
correlationId.

Focused run: `pnpm --filter @moe/daemon exec vitest run --root . --config
package.json src/coordination/coordination-adapter.test.ts` (~1.4s).

## Verification recorded

Baseline at merge-base `531fb92` green on all four legs BEFORE any byte written.
After: coordination 2/40, daemon typecheck, daemon 59 files/897 tests (from
58/887), repo typecheck — all exit 0. HEAD moved to `057ec1a` mid-task (foreign,
`packages/store/src/recovery-install.test.ts` only); delta empty.
